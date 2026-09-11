/**
 * Perception: what Athena can see right now.
 *
 * Cameras never stream video to the server. Each device runs a two-rate
 * pipeline (see athena-unity/Assets/Scripts/Vision):
 *
 *   fast loop  (~10 fps, on device)  detector + distance estimate
 *                                    -> compact JSON objects
 *   slow loop  (every few seconds, or when asked "what do you see?")
 *                                    one keyframe -> vision LLM (local first)
 *                                    -> strict SCENE_SCHEMA JSON
 *
 * Devices POST the structured scene to /vision/observe. The latest scene per
 * person is held briefly in memory and rendered into Athena's prompt; notable
 * observations are also written to long-term memory (kind "observation").
 *
 * Camera sources are pluggable on the device side: phone camera, USB-UVC /
 * RTSP dashcams, a BMW head-unit video capture, or post-drive Drive Recorder
 * clips — the server contract is the same for all of them.
 */
const llm = require("./llm");
const { createEvent } = require("./memoryStore/events");

const LIVE_TTL_MS = 20_000;
const RECENT_WINDOW_MS = 10 * 60_000;
const OBSERVATION_MEMORY_GAP_MS = 2 * 60_000;
const MAX_OBJECTS = 24;

const SCENE_SCHEMA = {
	type: "object",
	properties: {
		summary: { type: "string" },
		objects: {
			type: "array",
			items: {
				type: "object",
				properties: {
					label: { type: "string" },
					description: { type: "string" },
					distance_m: { type: "number" },
					bearing_deg: { type: "number" },
					confidence: { type: "number" },
				},
				required: ["label", "description", "distance_m", "bearing_deg", "confidence"],
			},
		},
		hazards: { type: "array", items: { type: "string" } },
		notable: { type: "boolean" },
	},
	required: ["summary", "objects", "hazards", "notable"],
};

const scenes = new Map(); // profileId -> { latest, recent: [], lastMemoryAt }

const num = (v, lo, hi) => {
	const n = Number(v);
	return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null;
};
const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

function sanitizeObjects(list) {
	return (Array.isArray(list) ? list : [])
		.map((o) => ({
			label: str(o?.label, 60),
			description: str(o?.description, 160),
			distance_m: num(o?.distance_m, 0, 5000),
			bearing_deg: num(o?.bearing_deg, -180, 180),
			confidence: num(o?.confidence, 0, 1),
			track_id: str(o?.track_id, 40),
		}))
		.filter((o) => o.label)
		.slice(0, MAX_OBJECTS);
}

function sanitizeScene(payload = {}) {
	return {
		source: {
			id: str(payload.source?.id, 60) || "camera",
			kind: str(payload.source?.kind, 30) || "phone", // phone | uvc | rtsp | bmw-headunit | drive-recorder
			position: str(payload.source?.position, 30), // front | rear | left | right | cabin
		},
		captured_at: payload.captured_at ? new Date(payload.captured_at) : new Date(),
		summary: str(payload.summary, 400),
		objects: sanitizeObjects(payload.objects),
		hazards: (Array.isArray(payload.hazards) ? payload.hazards : []).map((h) => str(h, 120)).filter(Boolean).slice(0, 6),
		notable: payload.notable === true,
		context: {
			driving: payload.context?.driving === true,
			speed_kmh: num(payload.context?.speed_kmh, 0, 400),
		},
	};
}

/**
 * The slow loop: one keyframe -> vision model -> strict scene JSON. Device
 * detections (the fast loop's output) ride along as hints, so the model
 * refines labels and distances rather than starting from scratch.
 */
async function structureScene({ imageBase64, mimeType = "image/jpeg", detections = [], source = {}, audience = "adult" }) {
	const hints = sanitizeObjects(detections)
		.map((d) => `${d.label}${d.distance_m != null ? ` ~${d.distance_m}m` : ""}${d.bearing_deg != null ? ` at ${d.bearing_deg}°` : ""}`)
		.join("; ");
	const prompt = `You are the perception system for Athena, looking through a ${source.position || "front"}-facing ${source.kind || "camera"}.
Output a structured description of the scene — no prose outside the JSON.
- objects: the things that matter (vehicles, people, animals, signs, landmarks, obstacles). description: a few words ("white pickup truck", "stop sign").
- distance_m: best estimate in meters from the camera, from apparent size and perspective. bearing_deg: horizontal angle, 0 = straight ahead, negative = left, positive = right.
- confidence 0-1. hazards: anything a driver or walker should know right now, else [].
- notable: true only if something is unusual or worth remembering (wildlife, an accident, a striking view) — not ordinary traffic.
${hints ? `On-device detector saw: ${hints}. Correct these if the image disagrees.` : ""}
Return ONLY JSON matching: ${JSON.stringify(SCENE_SCHEMA)}`;

	const { data, endpointId, tier } = await llm.generateJson({
		task: "vision",
		audience,
		schema: SCENE_SCHEMA,
		temperature: 0.1,
		contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBase64 } }] }],
		check: (d) => (Array.isArray(d?.objects) && typeof d?.summary === "string" ? null : "missing objects/summary"),
	});
	return { ...data, servedBy: { endpointId, tier } };
}

/** Store an observation from a device. Returns the sanitized scene. */
async function ingestObservation(profileId, payload = {}, { audience = "adult", familyId = null } = {}) {
	let scene = sanitizeScene(payload);

	if (typeof payload.keyframe?.imageBase64 === "string" && payload.keyframe.imageBase64.length > 100) {
		const structured = await structureScene({
			imageBase64: payload.keyframe.imageBase64,
			mimeType: payload.keyframe.mimeType || "image/jpeg",
			detections: scene.objects,
			source: scene.source,
			audience,
		});
		scene = sanitizeScene({ ...payload, ...structured, source: payload.source, context: payload.context });
		scene.servedBy = structured.servedBy;
	}

	const entry = scenes.get(profileId) || { latest: null, recent: [], lastMemoryAt: 0 };
	entry.latest = { ...scene, receivedAt: Date.now() };
	entry.recent = entry.recent.filter((s) => Date.now() - s.receivedAt < RECENT_WINDOW_MS);
	if (scene.summary) entry.recent.push(entry.latest);
	scenes.set(profileId, entry);

	// Notable sightings become long-term memories, throttled.
	if (scene.notable && scene.summary && Date.now() - entry.lastMemoryAt > OBSERVATION_MEMORY_GAP_MS) {
		entry.lastMemoryAt = Date.now();
		createEvent({
			profileId,
			familyId,
			kind: "observation",
			title: scene.summary.slice(0, 80),
			content: `${scene.summary} (seen via ${scene.source.kind} camera${scene.source.position ? `, ${scene.source.position}` : ""})`,
			occurredAt: scene.captured_at,
			importance: 5,
			source: "device",
			metadata: { objects: scene.objects.slice(0, 8), source: scene.source, context: scene.context },
		}).catch((err) => console.warn("[perception] observation memory failed:", err.message));
	}
	return scene;
}

function describeObject(o) {
	const where = [];
	if (o.distance_m != null) where.push(o.distance_m < 10 ? `${o.distance_m.toFixed(1)} m` : `${Math.round(o.distance_m)} m`);
	if (o.bearing_deg != null) {
		const b = o.bearing_deg;
		where.push(Math.abs(b) < 10 ? "ahead" : `${Math.abs(Math.round(b))}° ${b < 0 ? "left" : "right"}`);
	}
	return `${o.description || o.label}${where.length ? ` — ${where.join(", ")}` : ""}`;
}

/** Prompt block for the chat model, or null if no fresh scene. */
function getPromptBlock(profileId, now = Date.now()) {
	const entry = scenes.get(profileId);
	if (!entry?.latest) return null;
	const age = now - entry.latest.receivedAt;
	const lines = [];
	if (age <= LIVE_TTL_MS) {
		const s = entry.latest;
		lines.push(`Live from the ${s.source.position || ""} ${s.source.kind} camera (${Math.round(age / 1000)}s ago)${s.context.driving ? ", they are DRIVING" : ""}:`);
		if (s.summary) lines.push(`Scene: ${s.summary}`);
		for (const o of s.objects.slice(0, 10)) lines.push(`- ${describeObject(o)}`);
		if (s.hazards.length) lines.push(`Hazards: ${s.hazards.join("; ")}`);
	}
	const earlier = entry.recent
		.filter((s) => now - s.receivedAt > LIVE_TTL_MS && now - s.receivedAt <= RECENT_WINDOW_MS && s.summary)
		.slice(-4);
	if (earlier.length) {
		lines.push("Earlier in the last few minutes:");
		for (const s of earlier) lines.push(`- ${Math.round((now - s.receivedAt) / 60000)} min ago: ${s.summary}`);
	}
	if (!lines.length) return null;
	return `\n# What you can see
${lines.join("\n")}
Distances and angles are camera estimates — say "about". Only bring up what you see when it's relevant or they ask. If they're driving: short, speakable replies, never ask them to look at a screen, and mention hazards plainly.
`;
}

module.exports = { ingestObservation, structureScene, getPromptBlock, sanitizeScene, SCENE_SCHEMA, _reset: () => scenes.clear() };
