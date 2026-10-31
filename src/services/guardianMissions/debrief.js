/**
 * What a finished mission proved (migration 0112). The pass criteria and her
 * predictions were locked when the plan was approved; code grades them here
 * against what happened, so she can't mark her own work.
 *
 * A criterion names the capability it tests, and its result becomes a test
 * result, which is what moves her abilities. Anything that failed becomes a
 * weakness for self-evaluation, and a miss on a prediction does too. A person's
 * skill goes on their record from evidence: first pass "learning", a second
 * "reliable", pointing at the mission that showed it.
 *
 * Criterion kinds, each with `key`, `text`, and `capability` or `skill`:
 *   all_steps_done                      every step finished
 *   nothing_stuck                       no step ended stuck
 *   within_minutes { value }            Go to finish took this long or less
 *   predictions_close { value }         every prediction within this factor
 *   person_steps_done { actor }         that person finished all their steps
 */
const pool = require("../../helpers/db");
const missions = require("./index");
const partners = require("./partners");

const KINDS = new Set(["all_steps_done", "nothing_stuck", "within_minutes", "predictions_close", "person_steps_done"]);
const PREDICTION_MISS_FACTOR = 2;

const parse = (v) => {
	if (v == null || typeof v === "object") return v;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
};

const minutesBetween = (from, to) => (from && to ? (new Date(to).getTime() - new Date(from).getTime()) / 60_000 : null);

/** How far off a prediction was, as a factor: 1 is exact, 2 is double or half. */
function missFactor(predicted, actual) {
	if (!(predicted > 0) || !(actual > 0)) return Infinity;
	return Math.max(predicted / actual, actual / predicted);
}

/** Pure: what's wrong with a plan's criteria, as sentences. */
function validateCriteria(criteria, { capabilityKeys = [], skillKeys = [], actorKeys = [] } = {}) {
	if (!Array.isArray(criteria) || !criteria.length) return ["The plan says nothing about what would count as passing."];
	const problems = [];
	for (const c of criteria) {
		const name = c?.key || "A criterion";
		if (!KINDS.has(c?.kind)) problems.push(`${name}: that kind of check doesn't exist.`);
		if (String(c?.text || "").trim().length < 5) problems.push(`${name}: it needs a plain description.`);
		if (c?.kind === "person_steps_done") {
			if (!actorKeys.includes(c.actor)) problems.push(`${name}: ${c.actor || "nobody"} isn't in this plan.`);
			if (!skillKeys.includes(c.skill)) problems.push(`${name}: ${c.skill || "that skill"} isn't a skill.`);
		} else if (!capabilityKeys.includes(c?.capability)) {
			problems.push(`${name}: ${c?.capability || "it"} isn't one of this mission's capabilities.`);
		}
		if (["within_minutes", "predictions_close"].includes(c?.kind) && !(Number(c.value) > 0)) problems.push(`${name}: it needs a number.`);
	}
	return problems;
}

function check(criterion, { steps, predictions, goAt, endedAt, actorIds }) {
	const finished = steps.filter((s) => s.status === "done");
	switch (criterion.kind) {
		case "all_steps_done":
			return { passed: finished.length === steps.length, detail: `${finished.length} of ${steps.length} steps done` };
		case "nothing_stuck": {
			const stuck = steps.filter((s) => s.status === "stuck").length;
			return { passed: stuck === 0, detail: `${stuck} stuck` };
		}
		case "within_minutes": {
			const took = minutesBetween(goAt, endedAt);
			return { passed: took != null && took <= Number(criterion.value), detail: took == null ? "no time recorded" : `${Math.round(took)} minutes` };
		}
		case "predictions_close": {
			const worst = predictions.reduce((n, p) => Math.max(n, missFactor(Number(p.predicted_minutes), Number(p.actual_minutes))), 0);
			return { passed: predictions.length > 0 && worst <= Number(criterion.value), detail: predictions.length ? `worst was off by ${worst === Infinity ? "a step never finishing" : `${worst.toFixed(1)} times`}` : "no predictions" };
		}
		case "person_steps_done": {
			const own = steps.filter((s) => Number(s.assigned_actor_id) === Number(actorIds[criterion.actor]));
			const done = own.filter((s) => s.status === "done").length;
			return { passed: own.length > 0 && done === own.length, detail: `${done} of ${own.length} of their steps` };
		}
		default:
			return { passed: false, detail: "unknown check" };
	}
}

/** Pure: grade criteria against what happened, and name what went wrong. */
function grade({ criteria, steps, predictions, goAt, endedAt, actorIds = {} }) {
	const results = criteria.map((c) => ({ key: c.key, text: c.text, capability: c.capability || null, skill: c.skill || null, actor: c.actor || null, ...check(c, { steps, predictions, goAt, endedAt, actorIds }) }));
	const weaknesses = results.filter((r) => !r.passed).map((r) => ({ capKey: r.capability || r.skill, summary: `${r.text}: ${r.detail}`.slice(0, 255) }));
	for (const p of predictions) {
		if (missFactor(Number(p.predicted_minutes), Number(p.actual_minutes)) > PREDICTION_MISS_FACTOR) {
			const actual = p.actual_minutes == null ? "never finished" : `took ${Math.round(Number(p.actual_minutes))} min`;
			weaknesses.push({ capKey: p.cap_key || null, summary: `Expected ${Number(p.predicted_minutes)} min, ${actual}: ${String(p.instruction || "").slice(0, 120)}`.slice(0, 255) });
		}
	}
	return { results, weaknesses };
}

/** A person's skill from evidence: this pass plus any before it. */
async function creditSkill(familyId, mission, actorId, skillKey) {
	const cap = await missions.capabilityByKey(familyId, skillKey);
	if (!cap) return;
	await missions.recordTest(familyId, skillKey, { stage: "debrief", passed: true, actorId, notes: mission.title });
	// Distinct missions: repeating one mission isn't a second proof.
	const [[{ passes }]] = await pool.query("SELECT COUNT(DISTINCT notes) AS passes FROM athena_gm_test_result WHERE capability_id = ? AND actor_id = ? AND passed = 1", [cap.id, actorId]);
	await pool.query(
		`INSERT INTO athena_gm_actor_capability (actor_id, capability_id, level, source, evidence_mission_id, last_tested_at, audience)
		 VALUES (?, ?, ?, 'mission', ?, NOW(), 'kids_too')
		 ON DUPLICATE KEY UPDATE level = VALUES(level), source = 'mission', evidence_mission_id = VALUES(evidence_mission_id), last_tested_at = NOW()`,
		[actorId, cap.id, Number(passes) >= 2 ? "reliable" : "learning", mission.id]
	);
}

/** Grade a finished mission once. Results become test results, misses weaknesses. */
async function run(familyId, missionId) {
	const mission = await missions.missionById(missionId);
	const criteria = parse(mission?.pass_criteria);
	if (!mission || !Array.isArray(criteria) || !criteria.length) return null;
	const [existing] = await pool.query("SELECT mission_id FROM athena_gm_debrief WHERE mission_id = ?", [mission.id]);
	if (existing.length) return null;

	const [steps] = await pool.query("SELECT s.*, c.cap_key FROM athena_gm_mission_step s LEFT JOIN athena_gm_capability c ON c.id = s.capability_id WHERE s.mission_id = ? ORDER BY s.seq", [mission.id]);
	const [predictions] = await pool.query(
		`SELECT p.predicted_minutes, p.actual_minutes, s.instruction, c.cap_key
		 FROM athena_gm_prediction p JOIN athena_gm_mission_step s ON s.id = p.step_id LEFT JOIN athena_gm_capability c ON c.id = s.capability_id
		 WHERE p.mission_id = ?`,
		[mission.id]
	);
	const actors = await partners.people(mission);
	const actorIds = Object.fromEntries(actors.map((a) => [partners.planKey(a, familyId), a.id]));
	const familyOf = Object.fromEntries(actors.map((a) => [a.id, a.family_id]));

	const { results, weaknesses } = grade({ criteria, steps, predictions, goAt: mission.go_at, endedAt: mission.ended_at || new Date(), actorIds });
	const passed = results.filter((r) => r.passed).length;
	await pool.query("INSERT INTO athena_gm_debrief (mission_id, family_id, results, passed, total) VALUES (?, ?, ?, ?, ?)", [mission.id, familyId, JSON.stringify(results), passed, results.length]);

	// A step ties the result to this mission, which is what gives it its reach.
	const anchor = (capKey) => (steps.find((s) => s.cap_key === capKey && s.assigned_actor_id) || steps[steps.length - 1])?.id ?? null;
	for (const r of results) {
		if (r.capability) await missions.recordTest(familyId, r.capability, { stepId: anchor(r.capability), stage: "debrief", passed: r.passed, notes: r.text });
		// A skill sits on the person's own family's record.
		if (r.skill && r.passed && actorIds[r.actor]) await creditSkill(familyOf[actorIds[r.actor]], mission, actorIds[r.actor], r.skill);
	}
	// A later pass on the same tool closes what an earlier mission showed.
	for (const r of results.filter((x) => x.passed && x.capability)) {
		await pool.query("UPDATE athena_gm_weakness SET resolved_at = NOW() WHERE family_id = ? AND cap_key = ? AND mission_id <> ? AND resolved_at IS NULL", [familyId, r.capability, mission.id]);
	}
	for (const w of weaknesses) {
		await pool.query("INSERT INTO athena_gm_weakness (family_id, mission_id, cap_key, summary) VALUES (?, ?, ?, ?)", [familyId, mission.id, w.capKey, w.summary]);
	}
	await missions.log(familyId, "mission_debriefed", { missionId: mission.id, detail: { passed, total: results.length } });
	return { results, weaknesses };
}

/** Write the time a step actually took against her prediction. */
async function recordActual(step) {
	await pool.query(
		`UPDATE athena_gm_prediction p JOIN athena_gm_mission_step s ON s.id = p.step_id
		 SET p.actual_minutes = TIMESTAMPDIFF(SECOND, s.sent_at, s.completed_at) / 60
		 WHERE p.step_id = ? AND s.sent_at IS NOT NULL AND s.completed_at IS NOT NULL`,
		[step.id]
	);
}

/** An adult ends a live mission that can't finish on its own. Stuck steps count against it. */
async function finish(familyId, missionUuid, adult) {
	const mission = await missions.missionByUuid(familyId, missionUuid);
	if (mission.status !== "running" || mission.phase !== "live") {
		throw Object.assign(new Error("Only a live mission can be ended this way."), { status: 409 });
	}
	await pool.query("UPDATE athena_gm_mission SET phase = 'debrief', status = 'completed', ended_at = NOW() WHERE id = ? AND phase = 'live'", [mission.id]);
	await missions.log(familyId, "mission_ended", { actorId: adult.id, missionId: mission.id });
	return run(familyId, mission.id);
}

/** Open weaknesses, newest first, for self-evaluation and the page. */
async function openWeaknesses(familyId) {
	const [rows] = await pool.query("SELECT id, mission_id, cap_key, summary, created_at FROM athena_gm_weakness WHERE family_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 50", [familyId]);
	return rows;
}

module.exports = { missFactor, validateCriteria, grade, run, recordActual, finish, openWeaknesses };
