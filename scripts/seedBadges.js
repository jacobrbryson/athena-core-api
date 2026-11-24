#!/usr/bin/env node
/**
 * Mission badges (owner, 11-24): writes the six badge definitions and backfills
 * the Guardians-app missions the kids already finished. Dry run unless --write.
 *
 * Who earned a Guardians-app badge, from their own records (the same rows their
 * Base counters read):
 *   Answered the Call  checked in to the Guardians app
 *   Trailblazer        cracked at least one trail key
 *   Codebreaker        reported their family's map piece
 *   Signal Keeper      started the Portico Signal (the only record it keeps)
 *   First Watch        found at least one clue card
 * Only kids with a Guardians actor (a Companion account) get awards; Athena
 * earns none of these. Her first is First Sight, from I Spy.
 */
require("dotenv").config({ quiet: true });
const pool = require("../src/helpers/db");
const { BADGES, artPath } = require("../src/config/badges");

const ADVENTURE = "lake_norman_guardians";

async function missionIdFor(b) {
	if (!b.missionTitle) return null;
	const [[m]] = await pool.query("SELECT id FROM athena_gm_mission WHERE title = ? AND source <> 'legacy' AND approval_state = 'approved' ORDER BY id DESC LIMIT 1", [b.missionTitle]);
	return m?.id || null;
}

async function earners(key) {
	const [kids] = await pool.query(
		`SELECT a.id AS actor_id, a.display_name, g.guardian_id, COALESCE(g.qr_token_first_used_at, g.last_login_at) AS checked_in
		 FROM athena_gm_actor a JOIN guardian_credential g ON g.id = a.guardian_credential_id
		 WHERE a.kind = 'kid' AND g.adventure_key = ?`,
		[ADVENTURE]
	);
	const first = async (sql, params) => (await pool.query(sql, params))[0][0]?.at || null;
	const out = [];
	for (const k of kids) {
		let at = null;
		if (key === "answered-the-call") at = k.checked_in;
		if (key === "trailblazer") at = await first("SELECT MIN(COALESCE(used_at, reported_at)) AS at FROM guardian_trail_key WHERE mission_key = 'mission-1-ratatouille-trail' AND guardian_id = ? AND status = 'used'", [k.guardian_id]);
		if (key === "codebreaker") at = await first("SELECT MIN(created_at) AS at FROM mission_contribution WHERE adventure_key = ? AND mission_key = 'mission-2-convergence' AND guardian_id = ?", [ADVENTURE, k.guardian_id]);
		if (key === "signal-keeper") at = await first("SELECT MIN(started_at) AS at FROM guardian_mission_state WHERE adventure_key = ? AND mission_key = 'mission-2-portico' AND started_by_guardian_id = ?", [ADVENTURE, k.guardian_id]);
		if (key === "first-watch") at = await first("SELECT MIN(found_at) AS at FROM guardian_index_find WHERE adventure_key = ? AND mission_key = 'mission-3-first-watch' AND found_by_guardian_id = ?", [ADVENTURE, k.guardian_id]);
		if (at) out.push({ actorId: k.actor_id, name: k.display_name, at });
	}
	return out;
}

(async () => {
	const write = process.argv.includes("--write");
	for (const b of BADGES) {
		const missionId = await missionIdFor(b);
		if (b.missionTitle && !missionId) console.log(`! ${b.key}: no approved mission called "${b.missionTitle}"`);
		if (write) {
			await pool.query(
				`INSERT INTO athena_gm_badge (badge_key, mission_key, mission_id, name, story, art, with_athena) VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON DUPLICATE KEY UPDATE mission_key = VALUES(mission_key), mission_id = VALUES(mission_id), name = VALUES(name), story = VALUES(story), art = VALUES(art), with_athena = VALUES(with_athena)`,
				[b.key, b.missionKey || null, missionId, b.name, b.story, artPath(b.key), b.withAthena ? 1 : 0]
			);
		}
		const people = b.missionKey ? await earners(b.key) : [];
		console.log(`${b.name} (${b.key})${missionId ? ` → mission ${missionId}` : ""}${b.withAthena ? ", with Athena" : ""}: ${people.length ? people.map((p) => `${p.name.split(" ")[0]} ${new Date(p.at).toISOString().slice(0, 10)}`).join(", ") : b.missionKey ? "nobody" : "earned when the mission finishes"}`);
		if (write && people.length) {
			const [[row]] = await pool.query("SELECT id FROM athena_gm_badge WHERE badge_key = ?", [b.key]);
			for (const p of people) {
				await pool.query("INSERT IGNORE INTO athena_gm_badge_award (badge_id, actor_id, earned_at, source) VALUES (?, ?, ?, 'backfill')", [row.id, p.actorId, p.at]);
			}
		}
	}
	if (!write) console.log("(dry run: nothing written; add --write)");
	process.exit(0);
})().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
