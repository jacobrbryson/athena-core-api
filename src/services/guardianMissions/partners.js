/**
 * Missions across families (migration 0115). The planning family invites
 * another family to one waiting plan. That family's parent reads it and decides
 * for their own kids; nobody can add another family's kid. Only after they
 * accept can the plan name those kids, as `key@family`. The usual rules follow
 * each kid: their own agreement, the gate, and kids hearing nothing before Go.
 *
 * Leaving stops the mission. Each family stays in charge of its own kids, and a
 * partial team isn't what its plan was approved as.
 */
const pool = require("../../helpers/db");
const missions = require("./index");

function failure(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

/** Pure: the plan's name for a person: plain at home, key@family for a partner. */
function planKey(actor, homeFamilyId) {
	return Number(actor.family_id) === Number(homeFamilyId) ? actor.actor_key : `${actor.actor_key}@${actor.family_id}`;
}

/** Everyone a plan may name: the home family, and partners who accepted. */
async function people(mission) {
	const [rows] = await pool.query(
		`SELECT a.* FROM athena_gm_actor a
		 WHERE a.kind IN ('parent','kid') AND (a.family_id = ? OR a.family_id IN
		   (SELECT family_id FROM athena_gm_mission_family WHERE mission_id = ? AND status = 'accepted'))`,
		[mission.family_id, mission.id]
	);
	return rows;
}

/** Other families with a parent, named by that parent. Used to pick who to invite. */
async function otherFamilies(familyId) {
	const [rows] = await pool.query("SELECT family_id, display_name FROM athena_gm_actor WHERE kind = 'parent' AND family_id <> ? ORDER BY display_name", [familyId]);
	return rows.map((r) => ({ id: Number(r.family_id), name: `${r.display_name}'s family` }));
}

async function invite(familyId, missionUuid, partnerFamilyId, by) {
	const mission = await missions.missionByUuid(familyId, missionUuid);
	if (mission.status !== "proposed") throw failure("Only a waiting plan can invite a family.", 409);
	const partner = Number(partnerFamilyId);
	if (!(await otherFamilies(familyId)).some((f) => f.id === partner)) throw failure("Unknown family.", 404);
	await pool.query(
		`INSERT INTO athena_gm_mission_family (mission_id, family_id, invited_by_actor_id) VALUES (?, ?, ?)
		 ON DUPLICATE KEY UPDATE status = 'invited', invited_by_actor_id = VALUES(invited_by_actor_id), decided_by_actor_id = NULL, decided_at = NULL`,
		[mission.id, partner, by.id]
	);
	await missions.log(familyId, "family_invited", { actorId: by.id, missionId: mission.id, detail: { family: partner } });
}

/** What this family has been invited to or joined. */
async function forFamily(familyId) {
	const [rows] = await pool.query(
		`SELECT m.uuid, m.title, m.goal, m.status AS mission_status, m.phase, f.status
		 FROM athena_gm_mission_family f JOIN athena_gm_mission m ON m.id = f.mission_id
		 WHERE f.family_id = ? AND f.status IN ('invited','accepted') AND m.status NOT IN ('completed','stopped','declined','archived')`,
		[familyId]
	);
	return rows.map((r) => ({ uuid: r.uuid, title: r.title, goal: r.goal, status: r.status, missionStatus: r.mission_status, phase: r.phase }));
}

async function membership(familyId, missionUuid) {
	const [rows] = await pool.query(
		`SELECT f.status, m.id, m.family_id, m.uuid, m.status AS mission_status
		 FROM athena_gm_mission_family f JOIN athena_gm_mission m ON m.id = f.mission_id
		 WHERE f.family_id = ? AND m.uuid = ? LIMIT 1`,
		[familyId, missionUuid]
	);
	if (!rows[0]) throw failure("Unknown invitation.", 404);
	return rows[0];
}

/** A partner's parent answers for their own family. */
async function respond(partnerFamilyId, missionUuid, accept, by) {
	const row = await membership(partnerFamilyId, missionUuid);
	if (row.status !== "invited") throw failure("That invitation is closed.", 409);
	await pool.query(
		"UPDATE athena_gm_mission_family SET status = ?, decided_by_actor_id = ?, decided_at = NOW() WHERE mission_id = ? AND family_id = ?",
		[accept ? "accepted" : "declined", by.id, row.id, partnerFamilyId]
	);
	await missions.log(row.family_id, accept ? "family_joined" : "family_declined", { actorId: by.id, missionId: row.id });
}

/** A partner leaves. Their kids' waiting asks are cancelled and the mission stops. */
async function leave(partnerFamilyId, missionUuid, by) {
	const row = await membership(partnerFamilyId, missionUuid);
	if (row.status !== "accepted") throw failure("Your family isn't in that mission.", 409);
	await pool.query("UPDATE athena_gm_mission_family SET status = 'left', decided_by_actor_id = ?, decided_at = NOW() WHERE mission_id = ? AND family_id = ?", [by.id, row.id, partnerFamilyId]);
	await pool.query(
		`UPDATE athena_gm_mission_step s JOIN athena_gm_actor a ON a.id = s.assigned_actor_id
		 SET s.status = 'declined', s.result_note = 'Their family left the mission.'
		 WHERE s.mission_id = ? AND a.family_id = ? AND s.status IN ('pending','ready','waiting_parent','waiting_kids','in_progress')`,
		[row.id, partnerFamilyId]
	);
	if (["approved", "running", "paused"].includes(row.mission_status)) {
		await missions.stopMission(row.family_id, row.uuid, { actorId: by.id, reason: "a family left" });
	}
}

/**
 * Which family runs this step, if this person may act on it: their own family's
 * mission, or a step assigned to them on a partner's.
 */
async function stepFamilyFor(actor, stepUuid) {
	const [rows] = await pool.query(
		"SELECT m.family_id, s.assigned_actor_id FROM athena_gm_mission_step s JOIN athena_gm_mission m ON m.id = s.mission_id WHERE s.uuid = ? LIMIT 1",
		[stepUuid]
	);
	const row = rows[0];
	if (!row) throw failure("Unknown step.", 404);
	if (Number(row.family_id) === Number(actor.family_id) || Number(row.assigned_actor_id) === Number(actor.id)) return Number(row.family_id);
	throw failure("That step is for someone else.", 403);
}

module.exports = { planKey, people, otherFamilies, invite, forFamily, respond, leave, stepFamilyFor };
