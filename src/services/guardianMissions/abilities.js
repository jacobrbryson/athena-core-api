/**
 * Athena's abilities and how strong each one is (migration 0110, owner
 * 2026-10-31).
 *
 * Scores are arithmetic over test results, never a model's opinion and never
 * time spent: practice counts once it passes a test. They are not stored, so
 * every number can be explained from the record.
 *
 * Each ability climbs REACH rungs. A rung is a much bigger stage than the one
 * below, and percent is a position on that whole ladder: proving every tool in
 * an ability at home reaches the household rung's ceiling and no further. A
 * capability is proven at a rung when tests at that reach or higher are
 * 'working' by the track record's own rule, with at least MIN_TESTS of them.
 * A mission's reach is fixed when its plan is approved, so a result can't
 * promote itself.
 *
 * A solo test counts the same as one with people, except that the top rungs of
 * Communication and Coordination can only be earned with real people, because
 * those can't be proven in simulation.
 *
 * Nothing here gates anything. A score can't enable a capability, approve a
 * mission or widen who she may contact.
 */
const pool = require("../../helpers/db");
const trackRecord = require("./trackRecord");

const FLOOR = 1;
const REACH = [
	{ name: "Household", ceiling: 2 },
	{ name: "Neighborhood", ceiling: 5 },
	{ name: "Town", ceiling: 12 },
	{ name: "Region", ceiling: 30 },
	{ name: "Nation", ceiling: 60 },
	{ name: "World", ceiling: 100 },
];
const MIN_TESTS = 3;
const PEOPLE_FROM_RUNG = { communication: 5, coordination: 5 };

/** Pure: is this capability proven at this rung? results: newest first. */
function provenAt(results = [], rung, { peopleOnly = false } = {}) {
	const counted = results.filter((r) => Number(r.reach) >= rung && (!peopleOnly || r.with_people === 1 || r.with_people === true));
	return counted.length >= MIN_TESTS && trackRecord.statusOf(counted) === "working";
}

/**
 * Pure: one ability's score. links: [{ cap_key, weight }], system capabilities
 * only. results: by cap_key, newest first.
 */
function score(key, links = [], results = {}) {
	const total = links.reduce((n, l) => n + Number(l.weight), 0);
	let percent = FLOOR;
	let rung = 0;
	let next = null;
	for (let i = 0; total > 0 && i < REACH.length; i += 1) {
		const number = i + 1;
		const peopleOnly = number >= (PEOPLE_FROM_RUNG[key] || Infinity);
		const proven = links.filter((l) => provenAt(results[l.cap_key], number, { peopleOnly }));
		const share = proven.reduce((n, l) => n + Number(l.weight), 0) / total;
		const base = i === 0 ? FLOOR : REACH[i - 1].ceiling;
		if (share === 1) {
			percent = REACH[i].ceiling;
			rung = number;
			continue;
		}
		percent = base + (REACH[i].ceiling - base) * share;
		next = { name: REACH[i].name, proven: proven.length, total: links.length, peopleOnly };
		break;
	}
	return { percent: Math.round(percent * 10) / 10, rung, reach: rung ? REACH[rung - 1].name : null, next };
}

/** Pure: a person's standing in each ability, from their skills. */
function personRollup(skills = [], links = [], abilityRows = []) {
	return abilityRows
		.map((a) => {
			const mine = links.filter((l) => Number(l.ability_id) === Number(a.id) && l.kind === "skill");
			if (!mine.length) return null;
			const held = (level) => mine.filter((l) => skills.some((s) => s.cap_key === l.cap_key && s.level === level)).length;
			return { key: a.ability_key, name: a.name, reliable: held("reliable"), learning: held("learning"), total: mine.length };
		})
		.filter(Boolean);
}

/** Links with their capability's kind and name, wherever that capability lives. */
async function loadLinks() {
	const [rows] = await pool.query(
		`SELECT l.cap_key, l.ability_id, l.weight, MIN(c.kind) AS kind, MIN(c.name) AS name, MIN(c.badge) AS badge
		 FROM athena_gm_capability_ability l JOIN athena_gm_capability c ON c.cap_key = l.cap_key
		 GROUP BY l.cap_key, l.ability_id, l.weight`
	);
	return rows;
}

/** Every test of a capability, newest first, with its reach and whether a person took part. */
async function loadResults() {
	const [rows] = await pool.query(
		`SELECT c.cap_key, r.passed, r.created_at, COALESCE(m.reach_rung, 1) AS reach,
			(COALESCE(ta.kind, sa.kind) IN ('parent','kid')) AS with_people
		 FROM athena_gm_test_result r
		 JOIN athena_gm_capability c ON c.id = r.capability_id
		 LEFT JOIN athena_gm_mission_step s ON s.id = r.step_id
		 LEFT JOIN athena_gm_mission m ON m.id = s.mission_id
		 LEFT JOIN athena_gm_actor ta ON ta.id = r.actor_id
		 LEFT JOIN athena_gm_actor sa ON sa.id = s.assigned_actor_id
		 ORDER BY r.created_at DESC, r.id DESC`
	);
	const byCap = {};
	for (const row of rows) (byCap[row.cap_key] ||= []).push(row);
	return byCap;
}

async function loadAbilities() {
	const [rows] = await pool.query("SELECT id, ability_key, name, description FROM athena_gm_ability ORDER BY seq");
	return rows;
}

/** Her abilities for the Guardians page. */
async function abilityOverview() {
	const [rows, links, results] = await Promise.all([loadAbilities(), loadLinks(), loadResults()]);
	return rows.map((a) => {
		const own = links.filter((l) => Number(l.ability_id) === Number(a.id) && l.kind === "system");
		return {
			key: a.ability_key,
			name: a.name,
			description: a.description,
			...score(a.ability_key, own, results),
			capabilities: own
				.sort((x, y) => Number(y.weight) - Number(x.weight) || x.name.localeCompare(y.name))
				.map((l) => ({ key: l.cap_key, name: l.name, badge: l.badge, proven: provenAt(results[l.cap_key], 1) })),
		};
	});
}

module.exports = { FLOOR, REACH, MIN_TESTS, provenAt, score, personRollup, loadLinks, loadAbilities, abilityOverview };
