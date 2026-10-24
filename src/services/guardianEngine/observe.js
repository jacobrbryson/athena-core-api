/**
 * Observers: turn "is the garage door closed?" into an observation with a
 * timestamp, a confidence and its evidence — or into an honest "unknown".
 *
 * The camera observer takes a FRESH frame through the bridge (never a stored
 * thumbnail), checks it is still fresh when it is evaluated, asks the vision
 * model one narrow question with a fixed vocabulary, and fuses the answer
 * with any sensor that reports on the same subject. The model perceives;
 * the thresholds that turn its answer into a verdict are here.
 *
 * Every dependency (bridge, model, sensors, clock) is injectable so the
 * engine's tests and simulation mode can script what a camera "sees" without
 * a camera, a model, or a network.
 */
const eufyBridge = require("../eufyBridge");
const llm = require("../llm");
const { readModel } = require("./checks");

/** Capture failures that mean "this camera can't be reached now". */
const OFFLINE = new Set(["bridge_unreachable", "device_unavailable", "not_configured", "capture_failed"]);

const VISION_SCHEMA = {
	type: "object",
	properties: {
		visible: { type: "boolean" },
		state: { type: "string" },
		confidence: { type: "number" },
		reason: { type: "string" },
	},
	required: ["visible", "state", "confidence"],
};

/** The model call. Runs inside the caller's access context (the configuring adult). */
async function visionAsk({ check, subject, jpeg, cameraName }) {
	const prompt = `You are checking one fresh frame from a home security camera called "${cameraName || "camera"}" for a household safety check.
${check.question(subject)}
Answer only about that one object. Do not describe people. If it is night and the image is too dark to be sure, say "unknown".
"confidence" is 0 to 1: how sure you are of "state". "reason" is a few words on what you saw.
Return ONLY JSON matching: ${JSON.stringify({ ...VISION_SCHEMA, properties: { ...VISION_SCHEMA.properties, state: { type: "string", enum: check.vocabulary } } })}`;
	const { data, model } = await llm.generateJson({
		task: "vision",
		audience: "adult",
		schema: VISION_SCHEMA,
		contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } }] }],
		check: (d) => (d && typeof d.state === "string" ? null : "state is required"),
	});
	return { ...data, model: model || null };
}

const defaultDeps = {
	snapshot: (serial) => eufyBridge.freshSnapshot(serial),
	vision: visionAsk,
	/** Physical sensors for a subject. None are connected yet (no garage sensor). */
	sensors: async () => [],
	now: () => new Date(),
};

/**
 * Combine a camera verdict with sensor readings. A fresh sensor that agrees
 * raises confidence; one that disagrees makes the result unknown. A camera
 * that could not tell defers to a fresh, confident sensor.
 */
function fuse(check, camera, sensors) {
	const usable = sensors.filter((s) => s && s.fresh && check.vocabulary.includes(s.status) && s.status !== "unknown");
	if (!usable.length) return camera;
	const states = new Set(usable.map((s) => check.normalize(s.status)));
	if (states.size > 1) return { ...camera, status: "unknown", reason: "conflict", source: "fused", sensors: usable };
	const sensorState = [...states][0];
	const sensorConfidence = Math.max(...usable.map((s) => Number(s.confidence) || 0.9));
	if (camera.status === "unknown" || camera.status === "offline") {
		return { ...camera, status: sensorState, confidence: sensorConfidence, reason: null, source: "sensor", fresh: true, capturedAt: usable[0].capturedAt, sensors: usable };
	}
	if (camera.status !== sensorState) return { ...camera, status: "unknown", reason: "conflict", source: "fused", sensors: usable };
	return { ...camera, confidence: Math.max(camera.confidence || 0, sensorConfidence), source: "fused", sensors: usable };
}

/**
 * One look at one subject. `captures` caches this attempt's frame per camera
 * so two doors on one camera wake it once. Returns
 *   { status, confidence, reason, fresh, capturedAt, source, deviceSerial, cameraName, model, jpeg }
 * where status is the check's safe/unsafe word, "unknown" or "offline".
 */
async function observeSubject({ check, subject, config, captures = new Map(), cameraNames = new Map(), deps = {} }) {
	const d = { ...defaultDeps, ...deps };
	const base = { status: "unknown", confidence: null, reason: null, fresh: false, capturedAt: null, source: "camera", deviceSerial: subject.serial || null, cameraName: cameraNames.get(subject.serial) || null, model: null, jpeg: null };
	if (!subject.serial) return fuse(check, { ...base, reason: "no_camera" }, await d.sensors(check, subject).catch(() => []));
	let capture = captures.get(subject.serial);
	if (!capture) {
		capture = await d.snapshot(subject.serial).catch(() => ({ ok: false, reason: "bridge_unreachable" }));
		captures.set(subject.serial, capture);
	}
	let camera;
	if (!capture.ok) {
		camera = { ...base, status: OFFLINE.has(capture.reason) ? "offline" : "unknown", reason: capture.reason || "capture_failed" };
	} else {
		const capturedAt = new Date(capture.capturedAt);
		const ageMs = d.now().getTime() - capturedAt.getTime();
		// A frame is evidence only while it is fresh. One that has aged past the
		// limit — a slow model, a stuck request — proves nothing about now.
		if (!Number.isFinite(ageMs) || ageMs > config.maxEvidenceAgeSeconds * 1000 || ageMs < -60_000) {
			camera = { ...base, capturedAt, reason: "stale", jpeg: capture.jpeg };
		} else {
			let answer;
			try {
				answer = await d.vision({ check, subject, jpeg: capture.jpeg, cameraName: base.cameraName });
			} catch {
				answer = null;
			}
			if (!answer) {
				camera = { ...base, capturedAt, fresh: true, reason: "vision_unavailable", jpeg: capture.jpeg };
			} else {
				const read = readModel(check, answer);
				// Re-check freshness after the model: the verdict is about the moment of capture.
				const stillFresh = d.now().getTime() - capturedAt.getTime() <= config.maxEvidenceAgeSeconds * 1000;
				let status = read.state;
				let reason = null;
				if (!stillFresh) (status = "unknown"), (reason = "stale");
				else if (!read.visible) (status = "unknown"), (reason = "not_visible");
				else if (status === "unknown") reason = "low_confidence";
				else if (read.confidence < config.minConfidence) (status = "unknown"), (reason = "low_confidence");
				camera = { ...base, status, confidence: read.confidence, reason, fresh: stillFresh, capturedAt, model: answer.model || null, modelState: read.state, modelReason: read.reason, jpeg: capture.jpeg };
			}
		}
	}
	const sensors = await d.sensors(check, subject).catch(() => []);
	return fuse(check, camera, sensors);
}

module.exports = { observeSubject, fuse, visionAsk, OFFLINE, VISION_SCHEMA, defaultDeps };
