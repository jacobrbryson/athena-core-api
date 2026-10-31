/**
 * House controls for Guardians missions: the porch light (and Morse on it),
 * pan/tilt and speaking through a Eufy camera. Every command goes through
 * gate.mayUse first, writes a test result for the capability it exercised,
 * and is logged - including the refusals.
 *
 * Who is asking matters:
 *   - Athena, for a mission step: the mission must be running and list the
 *     capability; mission-only controls are refused outside one.
 *   - A parent pressing "Test" on the Guardians page: that is the person's own
 *     click, not Athena acting, so mission mode does not apply - but the kill
 *     switch and the capability's own on/off still do.
 *
 * The bridge (eufy-bridge/server.mjs) runs on the home PC and accepts these
 * only with EUFY_BRIDGE_CONTROL=on. Until the owner turns that on, every
 * command fails with the bridge's 405, which is recorded as a failed test.
 */
const eufyBridge = require("../eufyBridge");
const missions = require("./index");

const DIRECTIONS = new Set(["left", "right", "up", "down"]);

function failure(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

/** Gate a command. `by` is { kind: 'athena', mission } or { kind: 'parent', actor }. */
async function permit(familyId, capKey, by) {
	const capability = await missions.capabilityByKey(familyId, capKey);
	if (!capability) throw failure("Unknown capability.", 404);
	const control = await missions.control(familyId);
	let decision;
	if (by.kind === "parent") {
		// The person's own click: mission mode and pauses are about Athena.
		const asParent = { ...capability, mission_only: 0 };
		decision = missions.gate.mayUse({ control: { ...control, mode: "running" }, capability: asParent });
	} else {
		decision = missions.gate.mayUse({ control, capability, mission: by.mission || null });
	}
	if (!decision.allowed) {
		await missions.log(familyId, `${capKey}_command`, { actorId: by.actor?.id || null, missionId: by.mission?.id || null, capabilityId: capability.id, outcome: decision.verdict === "hold" ? "held" : "refused", detail: { reason: decision.reason } });
		throw failure(decision.reason, decision.verdict === "hold" ? 409 : 403);
	}
	return capability;
}

async function call(path, body, { timeoutMs = 15_000, contentType = "application/json" } = {}) {
	const started = Date.now();
	let res;
	try {
		res = await eufyBridge.bridge(path, timeoutMs, { method: "POST", body: contentType === "application/json" ? JSON.stringify(body) : body, contentType });
	} catch (err) {
		return { ok: false, latencyMs: Date.now() - started, error: String(err?.message || err).slice(0, 120) };
	}
	const json = await res.json().catch(() => ({}));
	return { ok: res.ok, status: res.status, latencyMs: Number.isFinite(json.latencyMs) ? json.latencyMs : Date.now() - started, body: json, error: res.ok ? null : json.error || `HTTP ${res.status}` };
}

async function record(familyId, capKey, by, stage, result, detail) {
	await missions.recordTest(familyId, capKey, { stage, passed: result.ok, latencyMs: result.latencyMs, notes: result.ok ? detail : result.error, actorId: by.actor?.id || null });
	await missions.log(familyId, `${capKey}_command`, { actorId: by.actor?.id || null, missionId: by.mission?.id || null, outcome: result.ok ? "ok" : "failed", detail: { stage, detail, error: result.error || null } });
	return result;
}

/** Porch light on/off. Passes only when the switch reads back the state asked for. */
async function porchLight(familyId, on, by) {
	await permit(familyId, "porch_light", by);
	const result = await call("/v1/porch-light", { on: Boolean(on) });
	if (result.ok && result.body?.confirmed === false) Object.assign(result, { ok: false, error: "the switch didn't read back the new state" });
	return record(familyId, "porch_light", by, "command", result, on ? "on" : "off");
}

/** Slow Morse on the porch light (about 1 s dot, 3 s dash). Short messages only. */
async function morse(familyId, text, by) {
	const clean = String(text || "").toUpperCase().replace(/[^A-Z0-9 ]/g, "").trim().slice(0, 20);
	if (!clean) throw failure("Nothing to send in Morse.");
	await permit(familyId, "morse_out_light", by);
	await permit(familyId, "porch_light", by);
	const result = await call("/v1/porch-light/morse", { text: clean, dotSeconds: 1.0 }, { timeoutMs: 180_000 });
	if (result.ok && result.body?.failures > 0) Object.assign(result, { ok: false, error: `${result.body.failures} of ${result.body.commands} switch commands failed` });
	return record(familyId, "morse_out_light", by, "blink", result, `"${clean}" in ${result.body?.seconds ?? "?"} s`);
}

/** Step a pan/tilt camera, or send it to a saved position. */
async function pan(familyId, serial, { direction = null, steps = 1, preset = null }, by) {
	if (!eufyBridge.SERIAL.test(String(serial || ""))) throw failure("Unknown camera.");
	if (preset == null && !DIRECTIONS.has(direction)) throw failure("Pick left, right, up or down.");
	await permit(familyId, "pan_tilt_camera", by);
	const result = await call(`/v1/devices/${serial}/ptz`, preset != null ? { preset: Number(preset) } : { direction, steps: Number(steps) || 1 });
	return record(familyId, "pan_tilt_camera", by, "command", result, preset != null ? `preset ${preset}` : `${direction} ×${steps}`);
}

/** Speak through a camera. `audio` is a Buffer in any format ffmpeg reads (the bridge converts it). */
async function speak(familyId, serial, audio, contentType, by) {
	if (!eufyBridge.SERIAL.test(String(serial || ""))) throw failure("Unknown camera.");
	if (!Buffer.isBuffer(audio) || !audio.length) throw failure("No audio.");
	await permit(familyId, "speak_through_camera", by);
	const result = await call(`/v1/devices/${serial}/talk`, audio, { timeoutMs: 90_000, contentType: contentType || "audio/mpeg" });
	return record(familyId, "speak_through_camera", by, "talkback", result, `${audio.length} bytes`);
}

/** 16-bit mono PCM (what Athena's voice comes back as) wrapped as a WAV, so ffmpeg on the bridge can read it. */
function pcmToWav(pcm, sampleRate) {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

/** Say `text` in Athena's voice through a camera. `speech` is llm.speech, passed in for tests. */
async function say(familyId, serial, text, by, speech) {
	const words = String(text || "").trim().slice(0, 300);
	if (!words) throw failure("Nothing to say.");
	await permit(familyId, "speak_through_camera", by);
	const voice = await speech(words);
	const pcm = Buffer.from(voice.audioBase64, "base64");
	return speak(familyId, serial, pcmToWav(pcm, voice.sampleRate || 24000), "audio/wav", by);
}

/** Cameras the bridge knows, with what each can be told to do. Never captures anything. */
async function cameras() {
	if (!eufyBridge.configured()) return { state: "not_connected", cameras: [] };
	const status = await eufyBridge.status().catch(() => null);
	if (!status) return { state: "unreachable", cameras: [] };
	return {
		state: status.state,
		cameras: (status.devices || []).map((d) => ({ serial: d.serial, name: d.name, model: d.model, control: d.control || { ptz: false, presets: false, talkback: false }, freshSnapshot: d.freshSnapshotAvailable === true })),
	};
}

/** A fresh look through a camera, as a test of view_cameras. The image is not kept. */
async function look(familyId, serial, by) {
	await permit(familyId, "view_cameras", by);
	const started = Date.now();
	const shot = await eufyBridge.freshSnapshot(serial);
	const result = { ok: shot.ok === true, latencyMs: shot.latencyMs ?? Date.now() - started, error: shot.ok ? null : shot.reason };
	return record(familyId, "view_cameras", by, "fresh_snapshot", result, shot.ok ? `${shot.jpeg?.length || 0} bytes` : null);
}

module.exports = { porchLight, morse, pan, speak, say, look, cameras, permit, pcmToWav };
