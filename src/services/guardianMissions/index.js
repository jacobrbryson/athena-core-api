/**
 * Guardians: Athena's capabilities, the missions that test them, and the
 * household's controls over both (migration 0103, Companion -> Guardians).
 *
 * The capability table is the source of truth; a mission is a test case that
 * updates it. Athena owns a mission once the owner approves its plan: she
 * sends each step, self-contained, to whoever can do it, and a step is done
 * only when its proof arrives. Every gate she passes is gate.mayUse(); every
 * thing she does is a row in athena_gm_log.
 *
 * Approving a plan is a direct action in the action layer
 * (approve_guardian_mission), so the approval is an athena_action row like
 * every other human decision. Anything a step does that spends money or
 * contacts an outsider still goes through the action layer per call.
 *
 * Pauses and mutes HOLD asks (status unchanged, logged as 'held'); they are
 * sent by flushHeld() when the hold lifts. Nothing is ever dropped, and there
 * are no rate limits on her asks.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../../helpers/db");
const gate = require("./gate");
const abilities = require("./abilities");
const consent = require("./consent");
const identity = require("./identity");
const trackRecord = require("./trackRecord");
const { teamProgress } = require("./team");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE = ["approved", "running", "paused"];
const LEVELS = new Set(["untested", "learning", "reliable"]);
const REPLIES = new Set(["done", "cant_now", "pause", "stop", "text"]);

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

// ---------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------

/** The caller's parent actor row, or null. This is the Guardians page's gate. */
async function parentActor(profileId) {
	if (!profileId) return null;
	const [rows] = await pool.query(
		"SELECT * FROM athena_gm_actor WHERE profile_id = ? AND kind = 'parent' ORDER BY id LIMIT 1",
		[profileId]
	);
	return rows[0] || null;
}

async function actorByKey(familyId, key) {
	const [rows] = await pool.query("SELECT * FROM athena_gm_actor WHERE family_id = ? AND actor_key = ? LIMIT 1", [familyId, key]);
	return rows[0] || null;
}

async function actorByUuid(familyId, uuid) {
	if (!UUID.test(String(uuid || ""))) throw failure("Unknown person.", 404);
	const [rows] = await pool.query("SELECT * FROM athena_gm_actor WHERE family_id = ? AND uuid = ? LIMIT 1", [familyId, uuid]);
	if (!rows[0]) throw failure("Unknown person.", 404);
	return rows[0];
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

/** Append-only. Never throws: a log failure must not undo what happened. */
async function log(familyId, verb, { actorId = null, missionId = null, stepId = null, capabilityId = null, outcome = "ok", detail = null } = {}) {
	try {
		await pool.query(
			`INSERT INTO athena_gm_log (family_id, actor_id, mission_id, step_id, capability_id, verb, outcome, detail)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[familyId, actorId, missionId, stepId, capabilityId, String(verb).slice(0, 40), outcome, detail == null ? null : JSON.stringify(detail)]
		);
	} catch (err) {
		console.error("[guardian missions] LOG WRITE FAILED", verb, err.message);
	}
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

async function control(familyId) {
	const [rows] = await pool.query("SELECT * FROM athena_gm_control WHERE family_id = ? LIMIT 1", [familyId]);
	return rows[0] || { family_id: familyId, mode: "running", quiet_until: null, kill_switch: 0, monthly_budget: null, stop_word: null };
}

/**
 * Master pause (running / quiet until a time / paused), the kill switch, the
 * monthly home-project budget and the kids' stop word.
 */
async function setControl(familyId, profileId, input = {}) {
	const current = await control(familyId);
	const next = { ...current };
	if (input.mode !== undefined) {
		if (!["running", "quiet_until", "paused"].includes(input.mode)) throw failure("Unknown pause setting.");
		next.mode = input.mode;
		if (input.mode === "quiet_until") {
			const until = new Date(input.quietUntil);
			if (Number.isNaN(until.getTime()) || until <= new Date()) throw failure("Pick a time in the future.");
			next.quiet_until = until;
		} else next.quiet_until = null;
	}
	if (input.killSwitch !== undefined) {
		next.kill_switch = input.killSwitch ? 1 : 0;
		next.kill_switch_at = input.killSwitch ? new Date() : null;
	}
	if (input.monthlyBudget !== undefined) {
		const n = input.monthlyBudget === null || input.monthlyBudget === "" ? null : Number(input.monthlyBudget);
		if (n !== null && (!Number.isFinite(n) || n < 0 || n > 1_000_000)) throw failure("That budget isn't a usable amount.");
		next.monthly_budget = n;
	}
	if (input.stopWord !== undefined) {
		const w = String(input.stopWord || "").trim().slice(0, 40);
		next.stop_word = w || null;
	}
	await pool.query(
		`INSERT INTO athena_gm_control (family_id, mode, quiet_until, kill_switch, kill_switch_at, monthly_budget, stop_word, updated_by_profile_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE mode = VALUES(mode), quiet_until = VALUES(quiet_until), kill_switch = VALUES(kill_switch),
		   kill_switch_at = VALUES(kill_switch_at), monthly_budget = VALUES(monthly_budget), stop_word = VALUES(stop_word),
		   updated_by_profile_id = VALUES(updated_by_profile_id)`,
		[familyId, next.mode, next.quiet_until || null, next.kill_switch ? 1 : 0, next.kill_switch_at || null, next.monthly_budget ?? null, next.stop_word, profileId]
	);
	const parent = await parentActor(profileId);
	await log(familyId, "control_changed", { actorId: parent?.id, detail: { mode: next.mode, quietUntil: next.quiet_until, killSwitch: Boolean(next.kill_switch) } });
	if (next.mode === "running") await flushHeld(familyId).catch((err) => console.warn("[guardian missions] flush failed:", err.message));
	return control(familyId);
}

async function setCapabilityEnabled(familyId, profileId, uuid, enabled) {
	if (!UUID.test(String(uuid || ""))) throw failure("Unknown capability.", 404);
	const [result] = await pool.query("UPDATE athena_gm_capability SET enabled = ? WHERE family_id = ? AND uuid = ?", [enabled ? 1 : 0, familyId, uuid]);
	if (!result.affectedRows) throw failure("Unknown capability.", 404);
	const parent = await parentActor(profileId);
	await log(familyId, enabled ? "capability_enabled" : "capability_disabled", { actorId: parent?.id, detail: { uuid } });
}

/** Per-recipient mute. Muted asks are held, not dropped. */
async function setActorMute(familyId, profileId, uuid, { muted, mutedUntil = null }) {
	const actor = await actorByUuid(familyId, uuid);
	if (actor.kind === "assistant") throw failure("Athena can't be muted as a recipient; pause her instead.");
	let until = null;
	if (muted && mutedUntil) {
		until = new Date(mutedUntil);
		if (Number.isNaN(until.getTime())) throw failure("That time isn't usable.");
	}
	await pool.query("UPDATE athena_gm_actor SET muted = ?, muted_until = ? WHERE id = ?", [muted ? 1 : 0, until, actor.id]);
	const parent = await parentActor(profileId);
	await log(familyId, muted ? "recipient_muted" : "recipient_unmuted", { actorId: parent?.id, detail: { recipient: actor.actor_key, until } });
	if (!muted) await flushHeld(familyId).catch(() => undefined);
}

/** A parent reports a kid's (or their own) skill. Shown as a badge. */
async function setSkill(familyId, profileId, actorUuid, capabilityUuid, level) {
	if (!LEVELS.has(level)) throw failure("Unknown level.");
	const actor = await actorByUuid(familyId, actorUuid);
	const cap = await capabilityByUuid(familyId, capabilityUuid);
	if (cap.kind !== "skill") throw failure("That's one of Athena's capabilities, not a skill.");
	await pool.query(
		`INSERT INTO athena_gm_actor_capability (actor_id, capability_id, level, source, last_tested_at, audience)
		 VALUES (?, ?, ?, 'parent_reported', NOW(), 'kids_too')
		 ON DUPLICATE KEY UPDATE level = VALUES(level), source = 'parent_reported', last_tested_at = NOW()`,
		[actor.id, cap.id, level]
	);
	const parent = await parentActor(profileId);
	await log(familyId, "skill_reported", { actorId: parent?.id, capabilityId: cap.id, detail: { who: actor.actor_key, level } });
}

// ---------------------------------------------------------------------------
// Capabilities and their track record
// ---------------------------------------------------------------------------

async function capabilityByUuid(familyId, uuid) {
	if (!UUID.test(String(uuid || ""))) throw failure("Unknown capability.", 404);
	const [rows] = await pool.query("SELECT * FROM athena_gm_capability WHERE family_id = ? AND uuid = ? LIMIT 1", [familyId, uuid]);
	if (!rows[0]) throw failure("Unknown capability.", 404);
	return rows[0];
}

async function capabilityByKey(familyId, key) {
	const [rows] = await pool.query("SELECT * FROM athena_gm_capability WHERE family_id = ? AND cap_key = ? LIMIT 1", [familyId, key]);
	return rows[0] || null;
}

/**
 * Record one test result and re-derive the capability's status from its
 * record. Stage names which part was measured, so a shaky part shows itself.
 */
async function recordTest(familyId, capKey, { stepId = null, stage = "run", passed, latencyMs = null, notes = null, actorId = null } = {}) {
	const cap = await capabilityByKey(familyId, capKey);
	if (!cap) return null;
	await pool.query(
		`INSERT INTO athena_gm_test_result (capability_id, step_id, stage, passed, latency_ms, notes, actor_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[cap.id, stepId, String(stage).slice(0, 40), passed ? 1 : 0, Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : null, notes ? String(notes).slice(0, 500) : null, actorId]
	);
	const [results] = await pool.query(
		"SELECT passed, latency_ms, stage, created_at FROM athena_gm_test_result WHERE capability_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
		[cap.id, trackRecord.WINDOW]
	);
	const status = trackRecord.statusOf(results);
	await pool.query("UPDATE athena_gm_capability SET status = ?, last_tested_at = NOW() WHERE id = ?", [status, cap.id]);
	await log(familyId, "test_recorded", { actorId, stepId, capabilityId: cap.id, outcome: passed ? "ok" : "failed", detail: { stage, latencyMs, notes } });
	return { capability: cap.cap_key, status };
}

async function capabilityList(familyId) {
	const [caps] = await pool.query("SELECT * FROM athena_gm_capability WHERE family_id = ? ORDER BY kind, name", [familyId]);
	const [results] = await pool.query(
		`SELECT r.capability_id, r.passed, r.latency_ms, r.stage, r.created_at
		 FROM athena_gm_test_result r JOIN athena_gm_capability c ON c.id = r.capability_id
		 WHERE c.family_id = ? ORDER BY r.created_at DESC, r.id DESC`,
		[familyId]
	);
	const byCap = new Map();
	for (const r of results) {
		if (!byCap.has(r.capability_id)) byCap.set(r.capability_id, []);
		byCap.get(r.capability_id).push(r);
	}
	return caps.map((c) => {
		const summary = trackRecord.summarize(byCap.get(c.id) || []);
		return {
			uuid: c.uuid,
			key: c.cap_key,
			kind: c.kind,
			name: c.name,
			description: c.description,
			channel: c.channel,
			locality: c.locality,
			permission: c.permission,
			missionOnly: c.mission_only === 1,
			houseControl: c.house_control === 1,
			enabled: c.enabled === 1,
			status: c.status,
			athenaVia: c.athena_via || null,
			badge: c.badge,
			hardware: c.hardware,
			lastTestedAt: c.last_tested_at,
			stale: c.kind === "system" && c.last_tested_at != null && trackRecord.isStale(c.last_tested_at),
			record: { ...summary, text: trackRecord.describe(summary) },
			audience: c.audience,
		};
	});
}

// ---------------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------------

async function missionByUuid(familyId, uuid) {
	if (!UUID.test(String(uuid || ""))) throw failure("Unknown mission.", 404);
	const [rows] = await pool.query("SELECT * FROM athena_gm_mission WHERE family_id = ? AND uuid = ? LIMIT 1", [familyId, uuid]);
	if (!rows[0]) throw failure("Unknown mission.", 404);
	return withCapabilities(rows[0]);
}

async function missionById(id) {
	const [rows] = await pool.query("SELECT * FROM athena_gm_mission WHERE id = ? LIMIT 1", [id]);
	return rows[0] ? withCapabilities(rows[0]) : null;
}

async function withCapabilities(mission) {
	const [rows] = await pool.query("SELECT capability_id FROM athena_gm_mission_capability WHERE mission_id = ?", [mission.id]);
	return { ...mission, capabilityIds: rows.map((r) => Number(r.capability_id)) };
}

/**
 * Called only from the approve_guardian_mission action's execute(), so the
 * approval is an athena_action row (approval 'human') before this runs.
 * Approving locks a plan and starts adult prep; a kid hears nothing until an
 * adult presses Go (runner.js). A mission with no plan just runs, as before.
 */
async function markApproved(familyId, missionUuid, profileId, actionUuid) {
	const mission = await missionByUuid(familyId, missionUuid);
	if (mission.source === "legacy") throw failure("That mission runs in the Guardians app.", 409);
	if (!["proposed", "declined", "stopped", "completed"].includes(mission.status) && mission.approval_state === "approved") {
		throw failure("That mission is already approved.", 409);
	}
	await pool.query(
		`UPDATE athena_gm_mission SET approval_state = 'approved', approved_by_profile_id = ?, approved_at = NOW(),
		   approval_action_uuid = ?, status = 'running', started_at = COALESCE(started_at, NOW()), ended_at = NULL,
		   stopped_by_actor_id = NULL, stop_reason = NULL
		 WHERE id = ?`,
		[profileId, actionUuid || null, mission.id]
	);
	const parent = await parentActor(profileId);
	await log(familyId, "mission_approved", { actorId: parent?.id, missionId: mission.id, detail: { actionUuid } });
	const approved = await missionByUuid(familyId, missionUuid);
	if (runner) await runner.onApproved(familyId, approved);
	return approved;
}

/** Decline a proposed plan. A normal outcome, kept. */
async function declineMission(familyId, profileId, missionUuid) {
	const mission = await missionByUuid(familyId, missionUuid);
	if (mission.status !== "proposed") throw failure("Only a proposed mission can be declined.", 409);
	await pool.query("UPDATE athena_gm_mission SET status = 'declined' WHERE id = ?", [mission.id]);
	const parent = await parentActor(profileId);
	await log(familyId, "mission_declined", { actorId: parent?.id, missionId: mission.id });
}

/**
 * Stop a mission now. Any parent, any time; a kid's stop word lands here too.
 * Revokes the approval, so starting again needs a new one.
 */
async function stopMission(familyId, missionUuid, { actorId = null, reason = "stopped" } = {}) {
	const mission = await missionByUuid(familyId, missionUuid);
	if (mission.source === "legacy") throw failure("That mission runs in the Guardians app.", 409);
	await pool.query(
		`UPDATE athena_gm_mission SET status = 'stopped', approval_state = 'revoked', ended_at = NOW(),
		   stopped_by_actor_id = ?, stop_reason = ? WHERE id = ?`,
		[actorId, String(reason).slice(0, 255), mission.id]
	);
	await log(familyId, "mission_stopped", { actorId, missionId: mission.id, detail: { reason } });
}

/**
 * A Guardian or parent said their family's stop word in chat. Exact match only:
 * a sentence that happens to contain the word isn't a stop.
 */
async function stopWordHeard(actor, text) {
	if (!actor) return false;
	const { stop_word: word } = await control(actor.family_id);
	if (!word || String(text || "").trim().toLowerCase() !== String(word).trim().toLowerCase()) return false;
	await stopAll(actor.family_id, { actorId: actor.id, reason: "stop word" });
	return true;
}

/** Stop every running mission (the kids' stop word, or a parent's "stop everything"). */
async function stopAll(familyId, { actorId = null, reason = "stop everything" } = {}) {
	const [rows] = await pool.query(
		"SELECT uuid FROM athena_gm_mission WHERE family_id = ? AND source <> 'legacy' AND status IN ('approved','running','paused')",
		[familyId]
	);
	for (const r of rows) await stopMission(familyId, r.uuid, { actorId, reason });
	return rows.length;
}

async function setMissionPaused(familyId, profileId, missionUuid, paused) {
	const mission = await missionByUuid(familyId, missionUuid);
	if (mission.approval_state !== "approved") throw failure("That mission isn't approved.", 409);
	if (paused && mission.status !== "running") throw failure("That mission isn't running.", 409);
	if (!paused && mission.status !== "paused") throw failure("That mission isn't paused.", 409);
	await pool.query("UPDATE athena_gm_mission SET status = ? WHERE id = ?", [paused ? "paused" : "running", mission.id]);
	const parent = await parentActor(profileId);
	await log(familyId, paused ? "mission_paused" : "mission_resumed", { actorId: parent?.id, missionId: mission.id });
	if (!paused) {
		await flushHeld(familyId).catch(() => undefined);
		if (runner) await runner.advance(familyId, mission.id);
	}
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function waitingStatusFor(actor) {
	if (!actor) return "ready";
	if (actor.kind === "parent") return "waiting_parent";
	if (actor.kind === "kid") return "waiting_kids";
	return "ready";
}

/**
 * Add a step to a running mission. Self-contained: the instruction must say
 * what, where and by when, and proof_required says what counts as done.
 */
async function createStep(familyId, missionId, { actorKey = null, capKey = null, instruction, place = null, proofRequired = "photo", dueAt = null, batchKey = null, needsReapproval = false, audience = "parent_only", planKey = null, phase = null, afterKeys = null, dueMinutes = null }) {
	const mission = await missionById(missionId);
	if (!mission || Number(mission.family_id) !== Number(familyId)) throw failure("Unknown mission.", 404);
	const text = String(instruction || "").trim();
	if (text.length < 10) throw failure("A step needs a self-contained instruction.");
	const actor = actorKey ? await actorByKey(familyId, actorKey) : null;
	const cap = capKey ? await capabilityByKey(familyId, capKey) : null;
	if (cap && !mission.capabilityIds.includes(Number(cap.id))) throw failure(`${cap.name} is not one of this mission's capabilities.`, 403);
	const [[{ next }]] = await pool.query("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM athena_gm_mission_step WHERE mission_id = ?", [mission.id]);
	const uuid = randomUUID();
	if (planKey) {
		// A planned step waits as 'pending' until runner.js opens it.
		await pool.query(
			`INSERT INTO athena_gm_mission_step
				(uuid, mission_id, plan_key, phase, after_keys, due_minutes, seq, assigned_actor_id, capability_id, instruction, place, proof_required, status, audience)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
			[uuid, mission.id, planKey, phase, JSON.stringify(afterKeys || []), dueMinutes, next, actor?.id || null, cap?.id || null, text.slice(0, 2000), place, proofRequired, audience]
		);
	} else {
		await pool.query(
			`INSERT INTO athena_gm_mission_step
				(uuid, mission_id, seq, assigned_actor_id, capability_id, instruction, place, proof_required, status, due_at, batch_key, needs_reapproval, audience)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[uuid, mission.id, next, actor?.id || null, cap?.id || null, text.slice(0, 2000), place, proofRequired, waitingStatusFor(actor), dueAt, batchKey, needsReapproval ? 1 : 0, audience]
		);
	}
	await log(familyId, "step_created", { actorId: actor?.id, missionId: mission.id, capabilityId: cap?.id, detail: { uuid, proofRequired } });
	return stepByUuid(familyId, uuid);
}

async function stepByUuid(familyId, uuid) {
	if (!UUID.test(String(uuid || ""))) throw failure("Unknown step.", 404);
	const [rows] = await pool.query(
		`SELECT s.*, m.family_id, m.uuid AS mission_uuid, m.title AS mission_title, a.actor_key, a.display_name AS actor_name, a.kind AS actor_kind, c.cap_key
		 FROM athena_gm_mission_step s
		 JOIN athena_gm_mission m ON m.id = s.mission_id
		 LEFT JOIN athena_gm_actor a ON a.id = s.assigned_actor_id
		 LEFT JOIN athena_gm_capability c ON c.id = s.capability_id
		 WHERE s.uuid = ? AND m.family_id = ? LIMIT 1`,
		[uuid, familyId]
	);
	if (!rows[0]) throw failure("Unknown step.", 404);
	return { ...rows[0], proof: parse(rows[0].proof) };
}

/**
 * Send a step's ask to its person through `deliver(actor, step)`, if the gate
 * allows. Held asks keep their status and are logged 'held'; flushHeld()
 * sends them when the hold lifts. Returns the gate's decision.
 */
async function sendStep(familyId, stepUuid, deliver) {
	const step = await stepByUuid(familyId, stepUuid);
	if (["done", "declined", "pending"].includes(step.status)) return { verdict: "refuse", reason: `step is ${step.status}` };
	const mission = await missionById(step.mission_id);
	const actor = step.assigned_actor_id ? (await pool.query("SELECT * FROM athena_gm_actor WHERE id = ?", [step.assigned_actor_id]))[0][0] : null;
	const push = await capabilityByKey(familyId, "push_notification");
	const cap = step.capability_id ? (await pool.query("SELECT * FROM athena_gm_capability WHERE id = ?", [step.capability_id]))[0][0] : null;
	const ctrl = await control(familyId);
	const agreement = actor ? await consent.standingFor(actor) : null;

	// Both the step's own capability and the push that carries it must pass,
	// so a mission that asks people must list push_notification too.
	for (const c of [cap, push].filter(Boolean)) {
		const d = gate.mayUse({ control: ctrl, capability: c, mission, recipient: actor, consent: agreement });
		if (!d.allowed) {
			await log(familyId, "step_send", { actorId: actor?.id, missionId: mission.id, stepId: step.id, capabilityId: c.id, outcome: d.verdict === "hold" ? "held" : "refused", detail: { reason: d.reason } });
			return d;
		}
	}
	const started = Date.now();
	const result = await deliver(actor, step);
	const ok = Boolean(result && result.sent > 0);
	await identity.recordDelivery(familyId, actor, step, result);
	await pool.query(
		// nudge_count first: MySQL applies SET left to right, so it must read sent_at before it is filled.
		"UPDATE athena_gm_mission_step SET nudge_count = nudge_count + IF(sent_at IS NULL, 0, 1), sent_at = COALESCE(sent_at, NOW()), last_nudged_at = NOW(), status = IF(status = 'ready', ?, status) WHERE id = ?",
		[waitingStatusFor(actor), step.id]
	);
	await recordTest(familyId, "push_notification", { stepId: step.id, stage: "push_delivered", passed: ok, latencyMs: Date.now() - started, notes: ok ? null : result?.skipped || "no device accepted it", actorId: actor?.id });
	await log(familyId, "step_send", { actorId: actor?.id, missionId: mission.id, stepId: step.id, outcome: ok ? "ok" : "failed", detail: { sent: result?.sent || 0, skipped: result?.skipped || null } });
	return { verdict: ok ? "allow" : "failed", allowed: ok, reason: ok ? null : result?.skipped || "not delivered" };
}

/**
 * Send every held ask that may go now. Called when a pause or mute lifts or a
 * mission resumes. The deliverer is wired in by the caller that owns push.
 */
let heldDeliverer = null;
function setDeliverer(fn) {
	heldDeliverer = fn;
}

/** runner.js, wired in by the same caller. It needs this module, so it can't be required here. */
let runner = null;
function setRunner(r) {
	runner = r;
}

async function flushHeld(familyId) {
	if (!heldDeliverer) return 0;
	const [rows] = await pool.query(
		`SELECT s.uuid FROM athena_gm_mission_step s JOIN athena_gm_mission m ON m.id = s.mission_id
		 WHERE m.family_id = ? AND m.status = 'running' AND s.sent_at IS NULL AND s.status IN ('ready','waiting_parent','waiting_kids')
		 ORDER BY s.created_at`,
		[familyId]
	);
	let sent = 0;
	for (const r of rows) {
		const d = await sendStep(familyId, r.uuid, heldDeliverer).catch(() => null);
		if (d?.allowed) sent += 1;
	}
	return sent;
}

/**
 * A person answered an ask: from a notification button, a text, or the app.
 * "pause" pauses Athena; "stop" stops the mission; "can't right now" puts the
 * step back to wait - declining is a normal outcome, never a failure.
 */
async function replyToStep(familyId, stepUuid, { actorId = null, reply, text = null, via = "app" }) {
	if (!REPLIES.has(reply)) throw failure("Unknown reply.");
	const step = await stepByUuid(familyId, stepUuid);
	await pool.query("INSERT INTO athena_gm_step_reply (step_id, actor_id, reply, text, via) VALUES (?, ?, ?, ?, ?)", [step.id, actorId, reply, text ? String(text).slice(0, 500) : null, via]);
	await log(familyId, `reply_${reply}`, { actorId, missionId: step.mission_id, stepId: step.id, detail: { via } });
	await identity.recordReply({ familyId, actorId, via, missionId: step.mission_id, stepId: step.id });

	if (reply === "pause") {
		await pool.query(
			"INSERT INTO athena_gm_control (family_id, mode) VALUES (?, 'paused') ON DUPLICATE KEY UPDATE mode = 'paused', quiet_until = NULL",
			[familyId]
		);
		await log(familyId, "control_changed", { actorId, detail: { mode: "paused", via } });
	} else if (reply === "stop") {
		await stopMission(familyId, step.mission_uuid, { actorId, reason: `stop from ${via}` });
	} else if (reply === "cant_now") {
		// Back to waiting with a fresh send later; nothing is dropped.
		await pool.query("UPDATE athena_gm_mission_step SET sent_at = NULL WHERE id = ?", [step.id]);
	} else if (reply === "done" && ["none", "parent_confirm", "kid_confirm"].includes(step.proof_required)) {
		await completeStep(familyId, step, { actorId, note: text });
	}
	return stepByUuid(familyId, stepUuid);
}

async function completeStep(familyId, step, { actorId = null, note = null, proof = null, locationId = null } = {}) {
	await pool.query(
		"UPDATE athena_gm_mission_step SET status = 'done', completed_at = NOW(), result_note = COALESCE(?, result_note), proof = COALESCE(?, proof), location_id = COALESCE(?, location_id) WHERE id = ?",
		[note, proof ? JSON.stringify(proof) : null, locationId, step.id]
	);
	await log(familyId, "step_done", { actorId, missionId: step.mission_id, stepId: step.id });
	if (runner) await runner.stepDone(familyId, step);
}

async function markStepStuck(familyId, step, reason) {
	await pool.query("UPDATE athena_gm_mission_step SET status = 'stuck', result_note = ? WHERE id = ?", [String(reason).slice(0, 1000), step.id]);
	await log(familyId, "step_stuck", { missionId: step.mission_id, stepId: step.id, outcome: "failed", detail: { reason } });
}

/**
 * What she has learned from replies, per person: how often "can't right now"
 * came back recently. It informs WHEN and HOW she batches asks; it can never
 * silence one.
 */
async function replyPatterns(familyId) {
	const [rows] = await pool.query(
		`SELECT r.actor_id, r.reply, COUNT(*) n, MAX(r.created_at) last_at
		 FROM athena_gm_step_reply r JOIN athena_gm_mission_step s ON s.id = r.step_id JOIN athena_gm_mission m ON m.id = s.mission_id
		 WHERE m.family_id = ? AND r.created_at > DATE_SUB(NOW(), INTERVAL 14 DAY)
		 GROUP BY r.actor_id, r.reply`,
		[familyId]
	);
	return rows;
}

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

async function overview(familyId) {
	const [abilityRows, abilityRefs, contacts, agreements, ctrl, capabilities, actorsRes, missionsRes, stepsRes, skillsRes, cluesRes, logRes, locationsRes] = await Promise.all([
		// These read migrations that may not be applied yet: the page still works
		// without what they add.
		abilities.abilityOverview().catch(() => null),
		Promise.all([abilities.loadAbilities(), abilities.loadLinks()]).catch(() => [[], []]),
		identity.contactsByActor(familyId).catch(() => ({})),
		// Nobody shows as agreed unless the record says so.
		pool.query("SELECT id, kind FROM athena_gm_actor WHERE family_id = ?", [familyId]).then(([rows]) => consent.standingsFor(familyId, rows)).catch(() => ({})),
		control(familyId),
		capabilityList(familyId),
		pool.query("SELECT * FROM athena_gm_actor WHERE family_id = ? ORDER BY FIELD(kind,'assistant','parent','kid','guest'), id", [familyId]),
		pool.query("SELECT * FROM athena_gm_mission WHERE family_id = ? ORDER BY difficulty_rung, FIELD(priority,'high','normal'), title", [familyId]),
		pool.query(
			`SELECT s.*, m.uuid AS mission_uuid, a.uuid AS actor_uuid, a.display_name AS actor_name, a.kind AS actor_kind, c.name AS capability_name
			 FROM athena_gm_mission_step s JOIN athena_gm_mission m ON m.id = s.mission_id
			 LEFT JOIN athena_gm_actor a ON a.id = s.assigned_actor_id LEFT JOIN athena_gm_capability c ON c.id = s.capability_id
			 WHERE m.family_id = ? AND m.status IN ('approved','running','paused')
			 ORDER BY s.mission_id, s.seq`,
			[familyId]
		),
		pool.query(
			`SELECT ac.actor_id, ac.level, ac.source, ac.last_tested_at, c.uuid AS capability_uuid, c.name, c.badge, c.cap_key
			 FROM athena_gm_actor_capability ac JOIN athena_gm_capability c ON c.id = ac.capability_id
			 WHERE c.family_id = ? AND c.kind = 'skill'`,
			[familyId]
		),
		pool.query(
			`SELECT cl.uuid, cl.seq, cl.legacy_ref, cl.title, cl.act, cl.kind, cl.status, m.title AS mission_title
			 FROM athena_gm_clue cl LEFT JOIN athena_gm_mission m ON m.id = cl.mission_id
			 WHERE cl.family_id = ? ORDER BY cl.mission_id, cl.seq`,
			[familyId]
		),
		pool.query(
			`SELECT l.verb, l.outcome, l.detail, l.created_at, a.display_name AS actor_name, m.title AS mission_title
			 FROM athena_gm_log l LEFT JOIN athena_gm_actor a ON a.id = l.actor_id LEFT JOIN athena_gm_mission m ON m.id = l.mission_id
			 WHERE l.family_id = ? ORDER BY l.id DESC LIMIT 30`,
			[familyId]
		),
		pool.query("SELECT uuid, name, lat, lng, heading_deg, description, hiding_potential, difficulty, last_verified_at, created_at FROM athena_gm_location WHERE family_id = ? ORDER BY id DESC LIMIT 20", [familyId]),
	]);
	const actors = actorsRes[0];
	const missions = missionsRes[0];
	const steps = stepsRes[0];
	const skills = skillsRes[0];
	const missionCaps = await pool.query(
		`SELECT mc.mission_id, c.name, c.badge FROM athena_gm_mission_capability mc JOIN athena_gm_capability c ON c.id = mc.capability_id
		 JOIN athena_gm_mission m ON m.id = mc.mission_id WHERE m.family_id = ?`,
		[familyId]
	);
	const capsByMission = new Map();
	for (const r of missionCaps[0]) {
		if (!capsByMission.has(r.mission_id)) capsByMission.set(r.mission_id, []);
		capsByMission.get(r.mission_id).push({ name: r.name, badge: r.badge });
	}

	const shapeStep = (s) => ({
		uuid: s.uuid,
		seq: s.seq,
		instruction: s.instruction,
		place: s.place,
		proofRequired: s.proof_required,
		status: s.status,
		dueAt: s.due_at,
		sentAt: s.sent_at,
		nudgeCount: s.nudge_count,
		assignee: s.actor_uuid ? { uuid: s.actor_uuid, name: s.actor_name, kind: s.actor_kind } : null,
		capability: s.capability_name,
		resultNote: s.result_note,
		audience: s.audience,
	});
	// Before migration 0112 there are simply no debriefs to show.
	const [debriefRows] = await pool.query("SELECT mission_id, results, passed, total FROM athena_gm_debrief WHERE family_id = ?", [familyId]).catch(() => [[]]);
	const debriefs = new Map(debriefRows.map((d) => [Number(d.mission_id), { results: parse(d.results) || [], passed: d.passed, total: d.total }]));
	const shapeMission = (m) => {
		const own = steps.filter((s) => s.mission_id === m.id);
		const open = own.filter((s) => !["done", "declined"].includes(s.status));
		return {
			uuid: m.uuid,
			key: m.mission_key,
			title: m.title,
			goal: m.goal,
			rung: m.difficulty_rung,
			priority: m.priority,
			status: m.status,
			phase: m.phase || null,
			purpose: m.purpose || null,
			goAt: m.go_at || null,
			debrief: debriefs.get(Number(m.id)) || null,
			approval: m.approval_state,
			source: m.source,
			adventure: m.adventure_key,
			notes: m.notes,
			startedAt: m.started_at,
			endedAt: m.ended_at,
			capabilities: capsByMission.get(m.id) || [],
			steps: own.map(shapeStep),
			waitingOn: [...new Set(open.map((s) => (s.status === "waiting_parent" ? "you" : s.status === "waiting_kids" ? s.actor_name || "the kids" : null)).filter(Boolean))],
			audience: m.audience,
		};
	};

	const active = missions.filter((m) => ACTIVE.includes(m.status) || (m.source === "legacy" && m.status === "running"));
	const proposed = missions.filter((m) => m.status === "proposed");
	const history = missions.filter((m) => ["completed", "stopped", "declined", "archived"].includes(m.status));

	const guardians = actors
		.filter((a) => a.kind === "kid")
		.map((a) => {
			const mine = skills.filter((s) => Number(s.actor_id) === Number(a.id));
			return {
				uuid: a.uuid,
				name: a.display_name,
				muted: a.muted === 1,
				mutedUntil: a.muted_until,
				badges: mine.map((s) => ({
					capabilityUuid: s.capability_uuid,
					name: s.name,
					badge: s.badge,
					level: s.level,
					source: s.source,
					retest: trackRecord.isStale(s.last_tested_at),
				})),
				progress: { reliable: mine.filter((s) => s.level === "reliable").length, learning: mine.filter((s) => s.level === "learning").length },
				abilities: abilities.personRollup(mine, abilityRefs[1], abilityRefs[0]),
			};
		});

	// The team lives in the Guardians app's tables, on this family's own adventure.
	const legacyRunning = missions.find((m) => m.source === "legacy" && m.status === "running");
	const adventureKey = (legacyRunning || missions.find((m) => m.source === "legacy" && m.adventure_key))?.adventure_key;
	const team = adventureKey
		? await teamProgress(adventureKey, {
				kids: guardians.map((g) => ({ name: g.name, ...g.progress })),
				missions: {
					finished: missions.filter((m) => m.status === "completed").length,
					started: missions.filter((m) => m.status === "completed" || ACTIVE.includes(m.status)).length,
				},
				skillCount: capabilities.filter((c) => c.kind === "skill").length,
		  }).catch((err) => {
				console.warn("[guardian missions] team progress failed:", err.message);
				return null;
		  })
		: null;

	// What stands between each ready mission and Go, so the page can say so.
	const shapedActive = active.map(shapeMission);
	if (runner) {
		await Promise.all(
			shapedActive.map(async (shaped, i) => {
				if (shaped.phase === "ready") shaped.preflight = await runner.preflightFor(await withCapabilities(active[i])).catch(() => ["The checks couldn't run."]);
			})
		);
	}

	return {
		control: {
			mode: ctrl.mode,
			quietUntil: ctrl.quiet_until,
			killSwitch: ctrl.kill_switch === 1,
			killSwitchAt: ctrl.kill_switch_at || null,
			monthlyBudget: ctrl.monthly_budget == null ? null : Number(ctrl.monthly_budget),
			stopWord: ctrl.stop_word,
		},
		attention: gate.attention({ steps, proposedCount: proposed.length }),
		active: shapedActive,
		proposed: proposed.map(shapeMission),
		history: history.map(shapeMission),
		capabilities: capabilities.filter((c) => c.kind === "system"),
		skills: capabilities.filter((c) => c.kind === "skill"),
		abilities: abilityRows,
		recipients: actors.filter((a) => a.kind !== "assistant").map((a) => ({ uuid: a.uuid, name: a.display_name, kind: a.kind, muted: a.muted === 1, mutedUntil: a.muted_until, channels: contacts[a.id] || [], agreement: agreements[a.id]?.status || "unknown" })),
		guardians,
		team,
		clues: cluesRes[0].map((c) => ({ uuid: c.uuid, seq: c.seq, ref: c.legacy_ref, title: c.title, act: c.act, kind: c.kind, status: c.status, mission: c.mission_title })),
		locations: locationsRes[0].map((l) => ({ ...l, lat: l.lat == null ? null : Number(l.lat), lng: l.lng == null ? null : Number(l.lng), heading_deg: l.heading_deg == null ? null : Number(l.heading_deg) })),
		log: logRes[0].map((l) => ({ verb: l.verb, outcome: l.outcome, detail: parse(l.detail), at: l.created_at, who: l.actor_name, mission: l.mission_title })),
	};
}

module.exports = {
	parentActor,
	actorByKey,
	actorByUuid,
	log,
	control,
	setControl,
	setCapabilityEnabled,
	setActorMute,
	setSkill,
	capabilityByKey,
	capabilityByUuid,
	recordTest,
	capabilityList,
	missionByUuid,
	missionById,
	markApproved,
	declineMission,
	stopMission,
	stopAll,
	stopWordHeard,
	setMissionPaused,
	createStep,
	stepByUuid,
	sendStep,
	setDeliverer,
	setRunner,
	flushHeld,
	replyToStep,
	completeStep,
	markStepStuck,
	replyPatterns,
	overview,
	gate,
	trackRecord,
};
