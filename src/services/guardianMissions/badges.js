/**
 * Mission badges (owner, 11-24). Every finished mission has a badge with its own
 * painted art; each kid who did their part earns it, and so does Athena when the
 * badge is marked `with_athena` (a mission she plays in, like I Spy's First
 * Sight, her first). Kept apart from skill badges (athena_gm_skill): a skill says
 * what someone can do, a mission badge says where they were.
 *
 * Awards are written by code when a mission finishes (debrief.run), never by a
 * model, and a badge can't be earned twice.
 */
const pool = require("../../helpers/db");

const shape = (b) => ({
	key: b.badge_key,
	name: b.name,
	story: b.story,
	art: b.art || null,
	withAthena: Boolean(b.with_athena),
	earnedAt: b.earned_at || null,
});

/** Give a finished mission's badge to everyone who did their part. Returns the actor ids. */
async function awardMission(mission) {
	if (!mission || mission.status !== "completed") return [];
	const [[badge]] = await pool.query("SELECT * FROM athena_gm_badge WHERE mission_id = ? LIMIT 1", [mission.id]);
	if (!badge) return [];
	const [kids] = await pool.query(
		`SELECT DISTINCT s.assigned_actor_id AS id FROM athena_gm_mission_step s JOIN athena_gm_actor a ON a.id = s.assigned_actor_id
		 WHERE s.mission_id = ? AND s.status = 'done' AND a.kind = 'kid'`,
		[mission.id]
	);
	const ids = kids.map((k) => Number(k.id));
	if (badge.with_athena) {
		const [[athena]] = await pool.query("SELECT id FROM athena_gm_actor WHERE family_id = ? AND kind = 'assistant' ORDER BY id LIMIT 1", [mission.family_id]);
		if (athena) ids.push(Number(athena.id));
	}
	for (const id of ids) {
		await pool.query("INSERT IGNORE INTO athena_gm_badge_award (badge_id, actor_id, source) VALUES (?, ?, 'mission')", [badge.id, id]);
	}
	return ids;
}

/** The badges one Guardian (or Athena) has earned, oldest first. */
async function earned(actorId) {
	if (!actorId) return [];
	const [rows] = await pool.query(
		`SELECT b.*, aw.earned_at FROM athena_gm_badge_award aw JOIN athena_gm_badge b ON b.id = aw.badge_id
		 WHERE aw.actor_id = ? ORDER BY aw.earned_at, b.id`,
		[actorId]
	);
	return rows.map(shape);
}

/** Badges waiting on missions that are approved and not finished yet, for the given mission ids. */
async function waiting(missionIds, { athenaOnly = false } = {}) {
	const ids = [...new Set(missionIds.map(Number).filter(Boolean))];
	if (!ids.length) return [];
	const [rows] = await pool.query(
		`SELECT b.*, m.uuid AS mission_uuid FROM athena_gm_badge b JOIN athena_gm_mission m ON m.id = b.mission_id
		 WHERE b.mission_id IN (?) AND m.status IN ('running','paused') ${athenaOnly ? "AND b.with_athena = 1" : ""}`,
		[ids]
	);
	return rows.map((b) => ({ ...shape(b), mission: b.mission_uuid }));
}

/**
 * Athena as a Guardian, for the kids' Team page: her badges, the ones she's
 * working toward, and her I Spy record. Her ability bars come from the
 * overview the caller already has.
 */
async function athenaCard(familyId) {
	const [[athena]] = await pool.query("SELECT id, created_at FROM athena_gm_actor WHERE family_id = ? AND kind = 'assistant' ORDER BY id LIMIT 1", [familyId]);
	if (!athena) return null;
	const [open] = await pool.query("SELECT id FROM athena_gm_mission WHERE family_id = ? AND status IN ('running','paused') AND approval_state = 'approved'", [familyId]);
	const mine = await earned(athena.id);
	const next = (await waiting(open.map((m) => m.id), { athenaOnly: true })).filter((b) => !mine.some((e) => e.key === b.key));
	const [[ispy]] = await pool.query(
		`SELECT COUNT(*) AS rounds, SUM(r.outcome IS NOT NULL) AS finished,
		   SUM(r.outcome = 'guessed' AND r.solved_by_actor_id = ?) AS spotted,
		   SUM(r.outcome = 'taught') AS taught, SUM(r.spy_actor_id = ?) AS spied
		 FROM athena_gm_ispy_round r WHERE r.family_id = ?`,
		[athena.id, athena.id, familyId]
	).catch(() => [[{}]]);
	return {
		since: athena.created_at,
		badges: mine,
		next,
		ispy: {
			rounds: Number(ispy?.finished) || 0,
			spotted: Number(ispy?.spotted) || 0,
			taught: Number(ispy?.taught) || 0,
			spied: Number(ispy?.spied) || 0,
		},
	};
}

module.exports = { awardMission, earned, waiting, athenaCard, shape };
