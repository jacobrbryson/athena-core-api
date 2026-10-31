/**
 * The Guardians team as the Guardians app recorded it: who is on the
 * adventure, what they found and decoded, and what that adds up to. Companion
 * -> Guardians reads this; nothing here writes.
 *
 * Levels, roles and skill percentages are not stored anywhere. They are
 * arithmetic over what happened, so each one can be explained: a skill's share
 * is always "n of total" of one real thing, and `detail` says which. A skill
 * with nothing to count is null (not started), never a low score.
 *
 * Only first names leave this module, and never a clue code, trail key or
 * guardian id: the page shows other families' kids.
 */
const pool = require("../../helpers/db");
const { getMissionDef, getIndexDef } = require("../../config/missions");

const TRAIL_MISSION = "mission-1-ratatouille-trail";
const TRAIL_ADVENTURE = "rescue_ratatouille";
const CONVERGENCE_MISSION = "mission-2-convergence";

const POINTS = { checkIn: 10, trailKey: 5, find: 5, contribution: 20, missionStarted: 10, learning: 10, reliable: 25 };
const POINTS_PER_LEVEL = 25;
const ACTIVITY_LIMIT = 8;
const MEMBER_ACTIVITY_LIMIT = 6;

/** Which skill a Guardian has the most evidence in names their role. Ties go to the earlier one. */
const ROLES = [
	["planning", "Pathfinder"],
	["observation", "Tracker"],
	["problemSolving", "Builder"],
	["realWorldTools", "Explorer"],
	["teamwork", "Creator"],
	["communication", "Sage"],
];

const firstName = (displayName) => String(displayName || "").trim().split(/\s+/)[0] || "Guardian";

const share = (done, total) => (total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null);

/** One Guardian's level and role from their own counts. */
function standing({ checkedIn = false, trailKeys = 0, finds = 0, contributions = 0, missionsStarted = 0, learning = 0, reliable = 0 }) {
	const points =
		(checkedIn ? POINTS.checkIn : 0) +
		trailKeys * POINTS.trailKey +
		finds * POINTS.find +
		contributions * POINTS.contribution +
		missionsStarted * POINTS.missionStarted +
		learning * POINTS.learning +
		reliable * POINTS.reliable;
	const evidence = {
		planning: missionsStarted,
		observation: finds,
		problemSolving: trailKeys,
		realWorldTools: learning + reliable,
		teamwork: contributions,
		communication: checkedIn ? 1 : 0,
	};
	const top = ROLES.reduce((best, [key, role]) => (evidence[key] > best.count ? { count: evidence[key], role } : best), { count: 0, role: "Recruit" });
	return {
		level: 1 + Math.floor(points / POINTS_PER_LEVEL),
		role: top.role,
		levelProgress: Math.round(((points % POINTS_PER_LEVEL) / POINTS_PER_LEVEL) * 100),
	};
}

/** The six team skills, each one share of one real count. */
function teamSkills({ missionsFinished, missionsStarted, familiesReported, familiesTotal, keysDecoded, keysPossible, cluesFound, cluesTotal, checkedIn, roster, reliableBadges, badgesPossible }) {
	const skill = (key, name, done, total, detail) => ({ key, name, percent: share(done, total), done, total, detail });
	return [
		skill("planning", "Planning", missionsFinished, missionsStarted, `${missionsFinished} of ${missionsStarted} missions carried through`),
		skill("teamwork", "Teamwork", familiesReported, familiesTotal, `${familiesReported} of ${familiesTotal} families reported their map piece`),
		skill("problemSolving", "Problem Solving", keysDecoded, keysPossible, `${keysDecoded} of ${keysPossible} trail keys decoded`),
		skill("observation", "Observation", cluesFound, cluesTotal, `${cluesFound} of ${cluesTotal} clue cards found`),
		skill("communication", "Communication", checkedIn, roster, `${checkedIn} of ${roster} Guardians have checked in with Athena`),
		skill("realWorldTools", "Real World Tools", reliableBadges, badgesPossible, `${reliableBadges} of ${badgesPossible} tool skills reliable`),
	];
}

/** Newest first, what the team did, in words. Times come from the rows that recorded it. */
function activityFrom({ finds, keys, contributions, nameOf, titleOf, limit = ACTIVITY_LIMIT }) {
	const rows = [
		...finds.map((f) => ({ kind: "find", at: f.found_at, who: nameOf(f.found_by_guardian_id), text: `found ${titleOf(f)}` })),
		...keys.map((k) => ({ kind: "key", at: k.used_at || k.reported_at, who: nameOf(k.guardian_id), text: "decoded a trail key" })),
		...contributions.map((c) => ({ kind: "report", at: c.created_at, who: nameOf(c.guardian_id), text: "reported the family's map piece" })),
	];
	return rows
		.filter((r) => r.who)
		.sort((a, b) => new Date(b.at) - new Date(a.at))
		.slice(0, limit);
}

/**
 * @param adventureKey the family's own adventure, read from its own missions
 * @param kids this family's kid actors with their skill badges: [{ name, learning, reliable }]
 * @param missions { finished, started } across the family's missions
 * @param skillCount how many tool skills there are to be reliable at
 */
async function teamProgress(adventureKey, { kids = [], missions, skillCount = 0 }) {
	const [[credentials], [finds], [keys], [contributions], [starts]] = await Promise.all([
		pool.query(
			"SELECT guardian_id, display_name, last_login_at FROM guardian_credential WHERE adventure_key = ? AND participant_type = 'guardian' AND is_active = 1",
			[adventureKey]
		),
		pool.query("SELECT mission_key, entry_id, found_by_guardian_id, found_at FROM guardian_index_find WHERE adventure_key = ?", [adventureKey]),
		pool.query("SELECT guardian_id, status, reported_at, used_at FROM guardian_trail_key WHERE mission_key = ?", [TRAIL_MISSION]),
		pool.query("SELECT guardian_id, family_key, created_at FROM mission_contribution WHERE adventure_key = ? AND mission_key = ?", [adventureKey, CONVERGENCE_MISSION]),
		pool.query("SELECT started_by_guardian_id FROM guardian_mission_state WHERE adventure_key = ?", [adventureKey]),
	]);

	const onTeam = new Set(credentials.map((c) => c.guardian_id));
	const teamFinds = finds.filter((f) => onTeam.has(f.found_by_guardian_id));
	const decoded = keys.filter((k) => onTeam.has(k.guardian_id) && k.status === "used");
	const count = (rows, field, id) => rows.filter((r) => r[field] === id).length;
	const ours = new Map(kids.map((k) => [k.name.toLowerCase(), k]));
	const nameById = new Map(credentials.map((c) => [c.guardian_id, firstName(c.display_name)]));
	const titleOf = (f) => getIndexDef(f.mission_key, adventureKey)?.entries?.find((e) => e.id === f.entry_id)?.title || "a clue card";
	const activityOf = (rows) => activityFrom({ ...rows, nameOf: (id) => nameById.get(id) || null, titleOf });

	const roster = credentials
		.map((c) => {
			const name = firstName(c.display_name);
			const kid = ours.get(name.toLowerCase());
			const finds_ = count(teamFinds, "found_by_guardian_id", c.guardian_id);
			const trailKeys = count(decoded, "guardian_id", c.guardian_id);
			const checkedIn = Boolean(c.last_login_at);
			const reported = count(contributions, "guardian_id", c.guardian_id);
			const missionsStarted = count(starts, "started_by_guardian_id", c.guardian_id);
			return {
				name,
				ours: Boolean(kid),
				checkedIn,
				finds: finds_,
				trailKeys,
				contributions: reported,
				missionsStarted,
				badges: (kid?.learning || 0) + (kid?.reliable || 0),
				recent: activityOf({
					finds: teamFinds.filter((f) => f.found_by_guardian_id === c.guardian_id),
					keys: decoded.filter((k) => k.guardian_id === c.guardian_id),
					contributions: contributions.filter((r) => r.guardian_id === c.guardian_id),
					limit: MEMBER_ACTIVITY_LIMIT,
				}),
				...standing({
					checkedIn,
					trailKeys,
					finds: finds_,
					contributions: reported,
					missionsStarted,
					learning: kid?.learning || 0,
					reliable: kid?.reliable || 0,
				}),
			};
		})
		.sort((a, b) => Number(b.ours) - Number(a.ours) || b.level - a.level || b.levelProgress - a.levelProgress || a.name.localeCompare(b.name));

	// The clue-card mission is the one the team last found a card in, running or finished.
	const clueMission = teamFinds.reduce((last, f) => (!last || new Date(f.found_at) > new Date(last.found_at) ? f : last), null)?.mission_key || null;
	const entries = (clueMission && getIndexDef(clueMission, adventureKey)?.entries) || [];
	const foundRefs = [...new Set(teamFinds.filter((f) => f.mission_key === clueMission).map((f) => f.entry_id))];
	const trailDef = getMissionDef(TRAIL_MISSION, TRAIL_ADVENTURE);
	const trailers = new Set(keys.filter((k) => onTeam.has(k.guardian_id)).map((k) => k.guardian_id));
	const families = (getMissionDef(CONVERGENCE_MISSION, adventureKey)?.families || []).filter((f) => !f.test);

	return {
		roster,
		skills: teamSkills({
			missionsFinished: missions.finished,
			missionsStarted: missions.started,
			familiesReported: new Set(contributions.map((c) => c.family_key)).size,
			familiesTotal: families.length,
			keysDecoded: decoded.length,
			keysPossible: trailers.size * (trailDef?.keys?.length || 0),
			cluesFound: foundRefs.length,
			cluesTotal: entries.length,
			checkedIn: roster.filter((g) => g.checkedIn).length,
			roster: roster.length,
			reliableBadges: kids.reduce((n, k) => n + k.reliable, 0),
			badgesPossible: kids.length * skillCount,
		}),
		clues: { mission: clueMission, found: foundRefs.length, total: entries.length, foundRefs },
		activity: activityOf({ finds: teamFinds, keys: decoded, contributions }),
	};
}

module.exports = { teamProgress, standing, teamSkills, activityFrom, firstName };
