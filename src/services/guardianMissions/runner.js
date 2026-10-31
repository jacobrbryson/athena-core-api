/**
 * Runs a mission from its approved plan (migration 0111, owner 2026-10-31).
 *
 * Approving locks the plan and opens its prep steps, which are for adults. When
 * prep is done the mission waits at 'ready' for an adult to press Go, after a
 * preflight that code runs, not a model. Only then can a kid be contacted: the
 * gate refuses a kid outside the live phase.
 *
 * Nothing runs on a timer loop. A step opens when the steps it follows are
 * done, so proof arriving drives the next step; a deadline is one Cloud Task
 * that wakes tick(), which reads what's due. The task carries nothing tick
 * trusts. A deadline nudges once and then marks the step stuck, which puts it
 * in front of a parent. Every send goes through sendStep and so the gate, and
 * a held ask stays held: tick leaves it and looks again later.
 *
 * The plan is untrusted: a model can write one. validatePlan checks it against
 * what exists, and it can only use what approval locked.
 */
const pool = require("../../helpers/db");
const consent = require("./consent");
const debrief = require("./debrief");
const identity = require("./identity");
const missions = require("./index");
const proof = require("./proof");
const templates = require("./templates");
const dispatch = require("../guardianEngine/dispatch");

const MAX_STEPS = 40;
const MIN_DEADLINE_MINUTES = 5;
const PHASES = new Set(["prep", "live"]);
// The proof a plan may ask for: the kinds something can actually complete.
const PROOFS = new Set(["none", "photo_set", "kid_confirm", "parent_confirm", "code"]);

function failure(message, status = 400, extra = {}) {
	return Object.assign(new Error(message), { status, ...extra });
}

const parse = (v) => {
	if (v == null || typeof v === "object") return v;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
};

const keysOf = (step) => parse(step.after_keys) || [];

/** Does any step depend on itself, however indirectly? */
function hasCycle(steps) {
	const after = new Map(steps.map((s) => [s.key, s.after || []]));
	const done = new Set();
	const walking = new Set();
	const visit = (key) => {
		if (done.has(key)) return false;
		if (walking.has(key)) return true;
		walking.add(key);
		const looped = (after.get(key) || []).some(visit);
		walking.delete(key);
		done.add(key);
		return looped;
	};
	return [...after.keys()].some(visit);
}

/**
 * Pure: what's wrong with a plan, as sentences; empty means it can run.
 * capabilityKeys: what this mission lists. actors: this family's people by key.
 */
function validatePlan(plan, { capabilityKeys = [], actors = {} } = {}) {
	const steps = plan?.steps;
	if (!Array.isArray(steps) || !steps.length) return ["The plan has no steps."];
	if (steps.length > MAX_STEPS) return [`A plan can have at most ${MAX_STEPS} steps.`];
	const problems = [];
	const keys = new Set(steps.map((s) => s?.key));
	if (keys.size !== steps.length) problems.push("Two steps share a name.");
	for (const s of steps) {
		const name = s?.key || "A step";
		if (!/^[a-z0-9_-]{1,40}$/.test(String(s?.key || ""))) problems.push(`${name}: its name isn't valid.`);
		if (String(s?.instruction || "").trim().length < 10) problems.push(`${name}: it needs an instruction that stands on its own.`);
		if (!PHASES.has(s?.phase)) problems.push(`${name}: it must be prep or live.`);
		if (!PROOFS.has(s?.proof || "none")) problems.push(`${name}: that kind of proof doesn't exist.`);
		const person = actors[s?.actor];
		if (!person) problems.push(`${name}: ${s?.actor || "nobody"} isn't in this family.`);
		else if (s.phase === "prep" && person.kind !== "parent") problems.push(`${name}: only adults take part in prep.`);
		if (s?.capability && !capabilityKeys.includes(s.capability)) problems.push(`${name}: ${s.capability} isn't one of this mission's capabilities.`);
		for (const k of s?.after || []) {
			if (!keys.has(k)) problems.push(`${name}: it follows ${k}, which isn't in the plan.`);
		}
		if (!Number.isInteger(s?.dueMinutes) || s.dueMinutes < 1) problems.push(`${name}: it needs a deadline in minutes.`);
		if (s?.predictMinutes != null && !(Number(s.predictMinutes) > 0)) problems.push(`${name}: its prediction needs a number of minutes.`);
		if (s?.proof === "code" && s?.phase !== "live") problems.push(`${name}: a code proves a live step.`);
	}
	const liveAfterPrep = steps.some((s) => s?.phase === "prep" && (s?.after || []).some((k) => steps.find((o) => o?.key === k)?.phase === "live"));
	if (liveAfterPrep) problems.push("A prep step can't wait on a live step.");
	if (!problems.length && hasCycle(steps)) problems.push("The plan's steps wait on each other in a circle.");
	return problems;
}

/** Pure: the waiting steps of this phase whose prerequisites are all done. */
function nextSteps(steps, phase) {
	const done = new Set(steps.filter((s) => s.status === "done").map((s) => s.plan_key));
	return steps.filter((s) => s.status === "pending" && s.phase === phase && keysOf(s).every((k) => done.has(k)));
}

/** Pure: has every step of this phase finished? */
function phaseDone(steps, phase) {
	const own = steps.filter((s) => s.phase === phase);
	return own.every((s) => s.status === "done");
}

/**
 * Pure: what stands in the way of Go, as sentences; empty means clear. Only
 * people in the plan are checked, and each must have agreed and be reachable.
 */
function preflight({ mission, steps, actors, agreements, contacts, capabilities, control, supervisor = null, codes = new Set(), zone = null, daylight = true }) {
	const problems = [];
	const kidsScout = steps.some((s) => s.cap_key === "scout_geography" && actors.find((a) => Number(a.id) === Number(s.assigned_actor_id))?.kind === "kid");
	if (kidsScout && !zone) problems.push("Kids can only scout inside an approved zone.");
	if (zone?.daylight_only === 1 && !daylight) problems.push(`${zone.name} is daylight only.`);
	const unset = steps.filter((s) => s.proof_required === "code" && !codes.has(Number(s.id))).length;
	if (unset) problems.push(`${unset} step${unset === 1 ? " still needs its" : "s still need their"} secret code.`);
	if (mission.approval_state !== "approved" || mission.status !== "running") problems.push("This plan isn't approved and running.");
	if (control?.mode === "paused") problems.push("Athena is paused.");
	if (control?.kill_switch === 1 && capabilities.some((c) => c.house_control === 1)) problems.push("The kill switch is on, and this mission uses lights or cameras.");
	for (const c of capabilities) {
		if (c.enabled !== 1) problems.push(`${c.name} is switched off.`);
		if (c.status === "broken") problems.push(`${c.name} isn't working.`);
	}
	const people = [...new Set(steps.map((s) => s.assigned_actor_id).filter(Boolean).map(Number))];
	if (people.length && !capabilities.some((c) => c.cap_key === "push_notification")) problems.push("This mission contacts people but doesn't list push notifications.");
	for (const id of people) {
		const actor = actors.find((a) => Number(a.id) === id);
		if (!actor || Number(actor.family_id) !== Number(mission.family_id)) {
			problems.push("Someone in this plan is in another family, and missions across families aren't supported yet.");
			continue;
		}
		if (!agreements[id]?.allowed) problems.push(`${actor.display_name} hasn't agreed to help train Athena.`);
		if (!(contacts[id] || []).some((c) => c.reachable)) problems.push(`There's no way to reach ${actor.display_name} yet.`);
	}
	if (supervisor) {
		if (supervisor.kind !== "parent" || Number(supervisor.family_id) !== Number(mission.family_id)) problems.push("The supervisor has to be an adult in this family.");
		else if (!agreements[supervisor.id]?.allowed) problems.push(`${supervisor.display_name} hasn't agreed to help train Athena.`);
	}
	return [...new Set(problems)];
}

async function stepsOf(missionId) {
	const [rows] = await pool.query("SELECT s.*, c.cap_key FROM athena_gm_mission_step s LEFT JOIN athena_gm_capability c ON c.id = s.capability_id WHERE s.mission_id = ? ORDER BY s.seq", [missionId]);
	return rows;
}

async function capabilitiesOf(mission) {
	if (!mission.capabilityIds.length) return [];
	const [rows] = await pool.query("SELECT * FROM athena_gm_capability WHERE id IN (?)", [mission.capabilityIds]);
	return rows;
}

async function familyActors(familyId) {
	const [rows] = await pool.query("SELECT * FROM athena_gm_actor WHERE family_id = ? AND kind IN ('parent','kid')", [familyId]);
	return rows;
}

/** Book the next look at what's due. A missed booking is caught by the backstop. */
function wakeFor(dueAt) {
	const url = (process.env.GUARDIAN_DISPATCH_URL || "").replace("/internal/guardian/dispatch", "/internal/guardian-missions/tick");
	return dispatch.wakeAt(dueAt, { url, name: "gm-mission", reason: "due" });
}

/** Open everything that is ready to open, then move the mission on if a phase finished. */
async function advance(familyId, missionId, deliver) {
	const mission = await missions.missionById(missionId);
	if (!mission || mission.status !== "running" || !mission.plan) return;
	if (mission.phase !== "prep" && mission.phase !== "live") return;
	const steps = await stepsOf(missionId);
	if (!steps.length) return;

	for (const step of nextSteps(steps, mission.phase)) {
		const [[actor]] = await pool.query("SELECT kind FROM athena_gm_actor WHERE id = ?", [step.assigned_actor_id]);
		const minutes = Number(step.due_minutes) || MIN_DEADLINE_MINUTES;
		await pool.query(
			"UPDATE athena_gm_mission_step SET status = ?, due_at = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ? AND status = 'pending'",
			[actor?.kind === "parent" ? "waiting_parent" : "waiting_kids", minutes, step.id]
		);
		await missions.sendStep(familyId, step.uuid, deliver);
		await wakeFor(new Date(Date.now() + minutes * 60_000));
	}

	if (!phaseDone(steps, mission.phase)) return;
	if (mission.phase === "prep") {
		await pool.query("UPDATE athena_gm_mission SET phase = 'ready' WHERE id = ? AND phase = 'prep'", [mission.id]);
		await missions.log(familyId, "mission_ready", { missionId: mission.id });
	} else {
		await pool.query("UPDATE athena_gm_mission SET phase = 'debrief', status = 'completed', ended_at = NOW() WHERE id = ? AND phase = 'live'", [mission.id]);
		await missions.log(familyId, "mission_finished", { missionId: mission.id });
		await debrief.run(familyId, mission.id);
	}
}

/**
 * The plan was approved: write its steps and open the first ones. A plan that
 * fails its checks doesn't start, and the approval is withdrawn so it can't sit
 * running with nothing behind it.
 */
async function onApproved(familyId, mission, deliver) {
	const plan = parse(mission.plan);
	if (!plan) return;
	const actors = await familyActors(familyId);
	const [caps] = mission.capabilityIds.length ? await pool.query("SELECT cap_key FROM athena_gm_capability WHERE id IN (?)", [mission.capabilityIds]) : [[]];
	const capabilityKeys = caps.map((c) => c.cap_key);
	const [skillRows] = await pool.query("SELECT cap_key FROM athena_gm_capability WHERE family_id = ? AND kind = 'skill'", [familyId]);
	const problems = [
		...validatePlan(plan, { capabilityKeys, actors: Object.fromEntries(actors.map((a) => [a.actor_key, a])) }),
		...debrief.validateCriteria(parse(mission.pass_criteria), { capabilityKeys, skillKeys: skillRows.map((c) => c.cap_key), actorKeys: actors.map((a) => a.actor_key) }),
	];
	const [wishes] = await pool.query("SELECT name FROM athena_gm_wish WHERE mission_id = ? AND status = 'wanted'", [mission.id]);
	for (const w of wishes) problems.push(`This plan needs something that hasn't been built: ${w.name}.`);
	if (problems.length) {
		await missions.stopMission(familyId, mission.uuid, { reason: "the plan failed its checks" });
		throw failure(problems[0], 409, { problems });
	}
	// Approving a stopped mission again carries on from the steps it already has.
	const written = (await stepsOf(mission.id)).some((s) => s.plan_key);
	for (const s of written ? [] : plan.steps) {
		await missions.createStep(familyId, mission.id, {
			actorKey: s.actor,
			capKey: s.capability || null,
			instruction: s.instruction,
			place: s.place || null,
			proofRequired: s.proof || "none",
			planKey: s.key,
			phase: s.phase,
			afterKeys: s.after || [],
			dueMinutes: s.dueMinutes,
			audience: s.phase === "live" ? "kids_too" : "parent_only",
		});
	}
	// Her predictions are written now and never again, so they can't follow the result.
	if (!written) {
		for (const row of await stepsOf(mission.id)) {
			const predicted = plan.steps.find((s) => s.key === row.plan_key)?.predictMinutes;
			if (predicted) await pool.query("INSERT INTO athena_gm_prediction (mission_id, step_id, predicted_minutes) VALUES (?, ?, ?)", [mission.id, row.id, predicted]);
		}
	}
	await advance(familyId, mission.id, deliver);
	const steps = await stepsOf(mission.id);
	if (!steps.some((s) => s.phase === "prep")) await pool.query("UPDATE athena_gm_mission SET phase = 'ready' WHERE id = ? AND phase = 'prep'", [mission.id]);
}

/** Everything preflight reads, for one mission in its own family. */
async function preflightFor(mission, supervisor = null) {
	const [steps, actors, capabilities, control, contacts] = await Promise.all([
		stepsOf(mission.id),
		familyActors(mission.family_id),
		capabilitiesOf(mission),
		missions.control(mission.family_id),
		identity.contactsByActor(mission.family_id),
	]);
	const [agreements, codes] = await Promise.all([consent.standingsFor(mission.family_id, actors), proof.codesSet(steps.map((s) => s.id))]);
	const zoneUuid = parse(mission.plan)?.zone;
	const zone = zoneUuid ? await templates.zoneByUuid(mission.family_id, zoneUuid) : null;
	return preflight({ mission, steps, actors, agreements, contacts, capabilities, control, supervisor, codes, zone, daylight: templates.isDaylight() });
}

/** An adult says "we're ready, start now". Their own agreement is checked too. */
async function go(familyId, missionUuid, { by, supervisorUuid, deliver }) {
	const mission = await missions.missionByUuid(familyId, missionUuid);
	if (mission.phase !== "ready") throw failure("This mission isn't ready for Go yet.", 409);
	const supervisor = await missions.actorByUuid(familyId, supervisorUuid);
	const standing = await consent.standingFor(by);
	if (!standing.allowed) throw failure("You need to agree to help train Athena before starting a mission.", 403);
	const problems = await preflightFor(mission, supervisor);
	if (problems.length) throw failure(problems[0], 409, { problems });
	await pool.query(
		"UPDATE athena_gm_mission SET phase = 'live', go_by_actor_id = ?, go_at = NOW(), supervisor_actor_id = ? WHERE id = ? AND phase = 'ready'",
		[by.id, supervisor.id, mission.id]
	);
	await missions.log(familyId, "mission_go", { actorId: by.id, missionId: mission.id, detail: { supervisor: supervisor.actor_key } });
	await advance(familyId, mission.id, deliver);
}

/**
 * Read what's due. A first deadline nudges and gives half the time again; a
 * second marks the step stuck for a parent. A send held by a pause or mute
 * leaves the step exactly as it was.
 */
async function tick(deliverFor) {
	const [rows] = await pool.query(
		`SELECT s.uuid, s.id, s.mission_id, s.nudge_count, s.due_minutes, m.family_id
		 FROM athena_gm_mission_step s JOIN athena_gm_mission m ON m.id = s.mission_id
		 WHERE m.status = 'running' AND s.status IN ('waiting_parent','waiting_kids') AND s.due_at <= NOW()`
	);
	let nudged = 0;
	let stuck = 0;
	for (const step of rows) {
		if (Number(step.nudge_count) > 0) {
			await missions.markStepStuck(step.family_id, step, "No answer by the deadline, after a reminder.");
			stuck += 1;
			continue;
		}
		const sent = await missions.sendStep(step.family_id, step.uuid, deliverFor);
		if (!sent.allowed) continue;
		const minutes = Math.max(MIN_DEADLINE_MINUTES, Math.round((Number(step.due_minutes) || MIN_DEADLINE_MINUTES) / 2));
		await pool.query("UPDATE athena_gm_mission_step SET due_at = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?", [minutes, step.id]);
		await wakeFor(new Date(Date.now() + minutes * 60_000));
		nudged += 1;
	}
	return { nudged, stuck };
}

/** A step finished: note how long it really took, then move on. */
async function stepDone(familyId, step, deliver) {
	await debrief.recordActual(step).catch((err) => console.warn("[guardian missions] prediction not recorded:", err.message));
	await advance(familyId, step.mission_id, deliver);
}

module.exports = { stepDone, validatePlan, nextSteps, phaseDone, preflight, preflightFor, advance, onApproved, go, tick };
