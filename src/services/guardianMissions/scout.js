/**
 * The "scout geography" capability: Athena asks someone to stand at a spot and
 * photograph north, east, south and west; the phone records GPS and compass
 * heading at each capture; she describes the place, what could be hidden
 * there and how hard it would be; then someone walks to what she described
 * and confirms it matches.
 *
 * Every stage that can fail on its own writes its own test result, so the
 * track record shows which part is shaky:
 *
 *   push_notification / push_delivered   the ask reached a phone
 *   phone_camera      / capture          a photo arrived for the step
 *   phone_gps         / sensors          it carried a position
 *   phone_compass     / sensors          it carried a heading
 *   scout_geography   / upload           the photo was stored
 *   scout_geography   / analysis         Athena wrote a location entry
 *   scout_geography   / triangulation    two heading lines crossed usefully
 *   scout_geography   / verification     a person confirmed it matches
 *
 * Asks go to any actor (the owner chose his own phone only for now; the
 * recipient is a parameter, not a constant). Photos are kept in the private
 * project-media bucket under guardian-missions/.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../../helpers/db");
const missions = require("./index");
const geo = require("./geo");
const templates = require("./templates");

const BUCKET = () => process.env.PROJECT_MEDIA_BUCKET || "athena-project-media";
const DIRECTIONS = ["N", "E", "S", "W"];
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 6 * 1024 * 1024;
// The same object seen from two spots this far apart or closer is matched for triangulation.
const NEARBY_M = 150;

let storageClient;
function storage() {
	if (!storageClient) {
		const { Storage } = require("@google-cloud/storage");
		storageClient = new Storage();
	}
	return storageClient;
}

function failure(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

const parse = (v) => {
	if (v == null || typeof v === "object") return v;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
};

const num = (v, lo, hi) => {
	const n = Number(v);
	return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

/** The running mission that may scout, or a clear refusal. */
async function scoutMission(familyId) {
	const [rows] = await pool.query(
		`SELECT m.uuid FROM athena_gm_mission m
		 JOIN athena_gm_mission_capability mc ON mc.mission_id = m.id
		 JOIN athena_gm_capability c ON c.id = mc.capability_id AND c.cap_key = 'scout_geography'
		 WHERE m.family_id = ? AND m.status = 'running' AND m.approval_state = 'approved'
		 ORDER BY m.mission_key = 'scout-the-yard' DESC, m.started_at DESC LIMIT 1`,
		[familyId]
	);
	if (!rows[0]) throw failure("No approved mission that scouts is running. Approve “Scout the yard” first.", 409);
	return missions.missionByUuid(familyId, rows[0].uuid);
}

function instructionFor({ place, dueAt }) {
	const where = place ? `at ${place}` : "at one spot in the yard";
	const by = dueAt ? ` by ${new Date(dueAt).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" })}` : "";
	return `Stand ${where} and take four photos, holding the phone upright: north, east, south, then west${by}. Proof: the four photos (the app records where you stood and which way you faced).`;
}

/** Push the ask, with Take photo / Can't right now buttons and the step id. */
function deliverer(push) {
	return async (actor, step) => {
		// A Guardian with no phone still has the Guardians app: the ask waits there.
		const inApp = { sent: 1, results: [{ uuid: null, channel: "chat", ok: true }] };
		if (!actor?.profile_id) return actor?.guardian_credential_id ? inApp : { sent: 0, skipped: "that person has no phone linked" };
		const scouting = step.cap_key === "scout_geography" && step.proof_required === "photo_set";
		const pushed = await push.sendToProfile(actor.profile_id, {
			title: scouting ? "Athena: scouting request" : "Athena",
			body: step.instruction,
			data: {
				kind: scouting ? "gm_scout" : "gm_step",
				step: step.uuid,
				mission: step.mission_uuid,
				proof: step.proof_required,
				directions: scouting ? DIRECTIONS.join(",") : "",
			},
			// Per step: a re-send replaces itself, two different asks stack.
			collapseKey: `gm-${step.uuid}`,
		});
		return pushed.sent > 0 || !actor.guardian_credential_id ? pushed : inApp;
	};
}

/** Athena asks someone to scout. Returns the step and the gate's decision. */
async function requestScout(familyId, { recipientKey = "ross", place = null, dueAt = null } = {}, push) {
	const mission = await scoutMission(familyId);
	const step = await missions.createStep(familyId, mission.id, {
		actorKey: recipientKey,
		capKey: "scout_geography",
		instruction: instructionFor({ place, dueAt }),
		place,
		proofRequired: "photo_set",
		dueAt,
		batchKey: "scout",
	});
	const sent = await missions.sendStep(familyId, step.uuid, deliverer(push));
	return { step: await missions.stepByUuid(familyId, step.uuid), send: sent };
}

/**
 * One photo of a set, with what the phone's sensors read at capture time.
 * The phone sends set + direction so a retake replaces nothing silently:
 * each capture is its own row.
 */
async function savePhoto(familyId, actor, stepUuid, input = {}) {
	const step = await missions.stepByUuid(familyId, stepUuid);
	if (step.proof_required !== "photo_set" || step.cap_key !== "scout_geography") throw failure("That step doesn't take scouting photos.", 409);
	if (["done", "declined"].includes(step.status)) throw failure(`That step is already ${step.status}.`, 409);
	const mission = await missions.missionById(step.mission_id);
	if (mission.status !== "running") throw failure("That mission isn't running.", 409);

	const direction = DIRECTIONS.includes(input.direction) ? input.direction : "other";
	const setUuid = /^[0-9a-f-]{36}$/i.test(String(input.setUuid || "")) ? input.setUuid : randomUUID();
	const contentType = TYPES.has(input.contentType) ? input.contentType : "image/jpeg";
	const buf = Buffer.isBuffer(input.buf) ? input.buf : Buffer.from(String(input.imageBase64 || ""), "base64");
	const capturedAt = input.capturedAt && !Number.isNaN(new Date(input.capturedAt).getTime()) ? new Date(input.capturedAt) : new Date();
	const lat = num(input.lat, -90, 90);
	const lng = num(input.lng, -180, 180);
	const accuracy = num(input.accuracy, 0, 10000);
	const heading = num(input.heading, 0, 360);
	const pitch = num(input.pitch, -180, 180);

	// A kid scouts only inside the zone an adult approved. Outside it, or with no
	// location, the photo isn't kept and a parent is told.
	if (actor?.kind === "kid") {
		const zoneUuid = parse(mission.plan)?.zone;
		const zone = zoneUuid ? await templates.zoneByUuid(familyId, zoneUuid) : null;
		if (!zone || !templates.insideZone(zone, { lat, lng, accuracy })) {
			await missions.markStepStuck(familyId, step, `${actor.display_name} scouted outside the approved zone.`);
			throw failure("That's outside the area for this mission. A parent will take a look.", 409);
		}
	}

	await missions.recordTest(familyId, "phone_camera", { stepId: step.id, stage: "capture", passed: buf.length > 1000, notes: buf.length > 1000 ? null : "empty or tiny image", actorId: actor?.id });
	if (buf.length <= 1000) throw failure("That photo was empty.");
	if (buf.length > MAX_BYTES) throw failure("That photo is too large.", 413);
	await missions.recordTest(familyId, "phone_gps", { stepId: step.id, stage: "sensors", passed: lat != null && lng != null, notes: lat == null ? "no position" : accuracy != null ? `±${Math.round(accuracy)} m` : null, actorId: actor?.id });
	await missions.recordTest(familyId, "phone_compass", { stepId: step.id, stage: "sensors", passed: heading != null, notes: heading == null ? "no heading" : `${Math.round(heading)}° (approximate)`, actorId: actor?.id });

	const uuid = randomUUID();
	const name = `guardian-missions/${new Date().toISOString().slice(0, 10)}/${step.uuid}/${setUuid}-${direction}-${uuid}.${contentType.split("/")[1]}`;
	const started = Date.now();
	try {
		await storage().bucket(BUCKET()).file(name).save(buf, { contentType, resumable: false, metadata: { cacheControl: "private, max-age=0" } });
	} catch (err) {
		await missions.recordTest(familyId, "scout_geography", { stepId: step.id, stage: "upload", passed: false, notes: String(err.message).slice(0, 200), actorId: actor?.id });
		throw failure("Couldn't store that photo. Try again.", 503);
	}
	await pool.query(
		`INSERT INTO athena_gm_photo (uuid, family_id, step_id, set_uuid, direction, object_path, content_type, bytes, lat, lng, accuracy_m, heading_deg, pitch_deg, captured_at, uploaded_at, actor_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
		[uuid, familyId, step.id, setUuid, direction, `gs://${BUCKET()}/${name}`, contentType, buf.length, lat, lng, accuracy, heading, pitch, capturedAt, actor?.id || null]
	);
	// Latency here is capture → stored, which is what background upload costs.
	await missions.recordTest(familyId, "scout_geography", { stepId: step.id, stage: "upload", passed: true, latencyMs: Math.max(Date.now() - capturedAt.getTime(), Date.now() - started), actorId: actor?.id });
	await missions.log(familyId, "photo_received", { actorId: actor?.id, missionId: step.mission_id, stepId: step.id, detail: { direction, setUuid } });
	await pool.query("UPDATE athena_gm_mission_step SET status = 'in_progress' WHERE id = ? AND status IN ('ready','waiting_parent','waiting_kids')", [step.id]);

	const [have] = await pool.query("SELECT DISTINCT direction FROM athena_gm_photo WHERE set_uuid = ? AND step_id = ?", [setUuid, step.id]);
	const got = new Set(have.map((r) => r.direction));
	const complete = DIRECTIONS.every((d) => got.has(d));
	return { photo: uuid, setUuid, direction, complete, missing: DIRECTIONS.filter((d) => !got.has(d)) };
}

const SCOUT_SCHEMA = {
	type: "object",
	properties: {
		name: { type: "string" },
		description: { type: "string" },
		hiding_potential: { type: "string" },
		difficulty: { type: "integer" },
		hiding_spots: {
			type: "array",
			items: { type: "object", properties: { what: { type: "string" }, direction: { type: "string" }, difficulty: { type: "integer" } }, required: ["what", "direction"] },
		},
		landmarks: {
			type: "array",
			items: { type: "object", properties: { label: { type: "string" }, direction: { type: "string" }, x: { type: "number" } }, required: ["label", "direction", "x"] },
		},
		verify_instruction: { type: "string" },
	},
	required: ["name", "description", "hiding_potential", "difficulty", "verify_instruction"],
};

function checkScout(d) {
	if (!d || typeof d !== "object") return "not an object";
	if (!d.name || !d.description || !d.verify_instruction) return "missing name, description or verify_instruction";
	if (!Number.isInteger(d.difficulty) || d.difficulty < 1 || d.difficulty > 5) return "difficulty must be 1-5";
	return null;
}

async function readPhoto(objectPath) {
	const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(objectPath || "");
	if (!m) return null;
	const [buf] = await storage().bucket(m[1]).file(m[2]).download();
	return buf;
}

/**
 * Analyse a complete set: one location entry, a verification step, and any
 * triangulation against earlier sets nearby. `llm` is services/llm, passed in
 * so tests can stand in for it.
 */
async function analyzeSet(familyId, stepUuid, setUuid, llm) {
	const step = await missions.stepByUuid(familyId, stepUuid);
	const [photos] = await pool.query("SELECT * FROM athena_gm_photo WHERE step_id = ? AND set_uuid = ? ORDER BY captured_at DESC", [step.id, setUuid]);
	const latest = new Map();
	for (const p of photos) if (!latest.has(p.direction)) latest.set(p.direction, p);
	const ordered = DIRECTIONS.map((d) => latest.get(d)).filter(Boolean);
	if (ordered.length < DIRECTIONS.length) throw failure("That set isn't complete yet.", 409);

	const spot = averageSpot(ordered);
	const parts = [];
	for (const p of ordered) {
		const buf = await readPhoto(p.object_path);
		parts.push({ text: `Photo facing ${p.direction}${p.heading_deg != null ? ` (compass ${Math.round(Number(p.heading_deg))}°, approximate)` : ""}:` });
		parts.push({ inlineData: { mimeType: p.content_type || "image/jpeg", data: buf.toString("base64") } });
	}
	const prompt = `You are Athena, planning a real-life clue hunt for two kids (ages 7 and 10) in their own yard. These four photos were taken standing at one spot, facing north, east, south and west.
Describe the place so someone could walk back to it, say what could be hidden there and how, and how hard finding something there would be (1 very easy .. 5 very hard). People in the photos are out of scope: describe places and objects, never people.
Also list fixed landmarks you can see (trees, posts, planters, sheds, rocks): for each, the photo direction (N/E/S/W) and x, its horizontal position in that photo from 0 (left edge) to 1 (right edge).
verify_instruction: one self-contained sentence asking someone to walk to the spot you described and confirm it matches.
Return ONLY JSON matching: ${JSON.stringify(SCOUT_SCHEMA)}`;

	const started = Date.now();
	let data;
	try {
		({ data } = await llm.generateJson({
			task: "vision",
			audience: "adult",
			schema: SCOUT_SCHEMA,
			contents: [{ role: "user", parts: [{ text: prompt }, ...parts] }],
			check: checkScout,
		}));
	} catch (err) {
		await missions.recordTest(familyId, "scout_geography", { stepId: step.id, stage: "analysis", passed: false, latencyMs: Date.now() - started, notes: String(err.message).slice(0, 200) });
		await missions.markStepStuck(familyId, step, "Athena couldn't analyse the photos");
		throw failure("Athena couldn't analyse those photos.", 502);
	}

	const sightings = landmarkBearings(data.landmarks, latest);
	const locUuid = randomUUID();
	const [ins] = await pool.query(
		`INSERT INTO athena_gm_location (uuid, family_id, name, lat, lng, accuracy_m, heading_deg, photo_refs, description, hiding_potential, difficulty, triangulated, source_step_id)
		 VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
		[
			locUuid,
			familyId,
			String(data.name).slice(0, 160),
			spot.lat,
			spot.lng,
			spot.accuracy,
			JSON.stringify(ordered.map((p) => ({ photo: p.uuid, direction: p.direction, heading: p.heading_deg == null ? null : Number(p.heading_deg) }))),
			String(data.description).slice(0, 4000),
			[data.hiding_potential, ...(data.hiding_spots || []).map((h) => `• ${h.what} (${h.direction}${h.difficulty ? `, ${h.difficulty}/5` : ""})`)].join("\n").slice(0, 4000),
			data.difficulty,
			JSON.stringify({ sightings, fixes: [] }),
			step.id,
		]
	);
	const locationId = ins.insertId;
	await missions.recordTest(familyId, "scout_geography", { stepId: step.id, stage: "analysis", passed: true, latencyMs: Date.now() - started });
	await missions.completeStep(familyId, step, { note: `Location: ${data.name}`, proof: { setUuid, photos: ordered.map((p) => p.uuid) }, locationId });

	const fixes = await triangulate(familyId, locationId, spot, sightings);
	if (fixes.length) await missions.recordTest(familyId, "scout_geography", { stepId: step.id, stage: "triangulation", passed: true, notes: `${fixes.length} landmark${fixes.length === 1 ? "" : "s"} placed` });

	// Verification: someone walks to the spot she described. Same person for now.
	const verify = await missions.createStep(familyId, step.mission_id, {
		actorKey: step.actor_key,
		capKey: "scout_geography",
		instruction: `${String(data.verify_instruction).slice(0, 600)} Reply Done if it matches, or tell me what's different.`,
		place: String(data.name).slice(0, 255),
		proofRequired: "parent_confirm",
		batchKey: "scout",
	});
	await pool.query("UPDATE athena_gm_mission_step SET location_id = ? WHERE id = ?", [locationId, verify.id]);
	return { location: locUuid, verifyStep: verify.uuid, fixes };
}

function averageSpot(photos) {
	const pts = photos.filter((p) => p.lat != null && p.lng != null);
	if (!pts.length) return { lat: null, lng: null, accuracy: null };
	const lat = pts.reduce((a, p) => a + Number(p.lat), 0) / pts.length;
	const lng = pts.reduce((a, p) => a + Number(p.lng), 0) / pts.length;
	const accs = pts.map((p) => Number(p.accuracy_m)).filter(Number.isFinite);
	return { lat, lng, accuracy: accs.length ? Math.max(...accs) : null };
}

/** Landmark → bearing from the spot, using that photo's own compass heading. */
function landmarkBearings(landmarks = [], latest) {
	const out = [];
	for (const l of landmarks || []) {
		const photo = latest.get(String(l.direction || "").toUpperCase());
		const heading = photo?.heading_deg == null ? null : Number(photo.heading_deg);
		const bearing = geo.bearingInPhoto(heading, Number(l.x));
		if (bearing == null) continue;
		out.push({ label: String(l.label).slice(0, 80), key: labelKey(l.label), bearing: Math.round(bearing) });
	}
	return out;
}

function labelKey(label) {
	return String(label || "").toLowerCase().replace(/\b(the|a|an)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * The same landmark seen from two spots: intersect the heading lines. Exact
 * label matches only; a fix is approximate and carries its crossing angle.
 */
async function triangulate(familyId, locationId, spot, sightings) {
	if (spot.lat == null || !sightings.length) return [];
	const [others] = await pool.query(
		"SELECT id, lat, lng, triangulated FROM athena_gm_location WHERE family_id = ? AND id <> ? AND lat IS NOT NULL ORDER BY id DESC LIMIT 50",
		[familyId, locationId]
	);
	const fixes = [];
	for (const other of others) {
		const there = { lat: Number(other.lat), lng: Number(other.lng) };
		if (geo.distanceM(spot, there) > NEARBY_M || geo.distanceM(spot, there) < 2) continue;
		const theirs = (typeof other.triangulated === "string" ? JSON.parse(other.triangulated) : other.triangulated)?.sightings || [];
		for (const s of sightings) {
			const match = theirs.find((t) => t.key && t.key === s.key);
			if (!match) continue;
			const fix = geo.intersect(spot, s.bearing, there, match.bearing);
			if (fix) fixes.push({ label: s.label, lat: fix.lat, lng: fix.lng, crossDeg: fix.crossDeg, withLocation: Number(other.id) });
		}
	}
	if (fixes.length) {
		await pool.query("UPDATE athena_gm_location SET triangulated = JSON_SET(COALESCE(triangulated, JSON_OBJECT()), '$.fixes', CAST(? AS JSON)) WHERE id = ?", [JSON.stringify(fixes), locationId]);
	}
	return fixes;
}

/** Someone walked to the spot: does it match? Either answer is a result worth keeping. */
async function verify(familyId, stepUuid, { matches, note = null, actorId = null }) {
	const step = await missions.stepByUuid(familyId, stepUuid);
	if (!step.location_id || step.proof_required !== "parent_confirm") throw failure("That step isn't a verification.", 409);
	if (step.status === "done") throw failure("Already verified.", 409);
	await missions.recordTest(familyId, "scout_geography", { stepId: step.id, stage: "verification", passed: Boolean(matches), notes: note, actorId });
	if (matches) {
		await pool.query("UPDATE athena_gm_location SET last_verified_at = NOW(), verified_by_actor_id = ? WHERE id = ?", [actorId, step.location_id]);
	}
	await missions.completeStep(familyId, step, { actorId, note: matches ? "Matches" : `Doesn't match${note ? `: ${note}` : ""}` });
	return missions.stepByUuid(familyId, stepUuid);
}

module.exports = { requestScout, savePhoto, analyzeSet, verify, deliverer, instructionFor, landmarkBearings, labelKey, DIRECTIONS };
