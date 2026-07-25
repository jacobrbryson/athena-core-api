#!/usr/bin/env node
/**
 * Mission 3 "The First Watch" index reset.
 *
 * Clears the shared index (found cards + fired convergences) so the hunt can be
 * run again — used to re-test with the seeded test account, or to stage a clean
 * game for the real team before the campaign week.
 *
 * NOTE: the index is network-shared, so this is campaign-wide by design. There
 * is no per-guardian reset because there is no per-guardian progress.
 *
 * Usage:
 *   node db/reset-index.js                        # reset lake_norman_guardians
 *   node db/reset-index.js some_other_adventure   # reset a specific adventure
 *
 * Connection comes from the same env vars used by src/helpers/db.js
 * (DB_HOST, DB_USER, DB_PASS, DB_NAME, DB_PORT).
 */
require("dotenv").config();
const mysql = require("mysql2/promise");

const INDEX_MISSION = "mission-3-first-watch";
const DEFAULT_ADVENTURE = "lake_norman_guardians";

async function main() {
	const adventureKey = process.argv[2] || DEFAULT_ADVENTURE;

	const conn = await mysql.createConnection({
		host: process.env.DB_HOST,
		user: process.env.DB_USER,
		password: process.env.DB_PASS,
		database: process.env.DB_NAME,
		port: process.env.DB_PORT || 3306,
	});

	try {
		const [finds] = await conn.query(
			`DELETE FROM guardian_index_find WHERE mission_key = ? AND adventure_key = ?;`,
			[INDEX_MISSION, adventureKey]
		);
		const [convs] = await conn.query(
			`DELETE FROM guardian_index_convergence WHERE mission_key = ? AND adventure_key = ?;`,
			[INDEX_MISSION, adventureKey]
		);
		console.log(
			`✓ Index reset for ${adventureKey}: ${finds.affectedRows} card(s) and ${convs.affectedRows} convergence(s) cleared.`
		);
	} finally {
		await conn.end();
	}
}

main().catch((err) => {
	console.error("Index reset failed:", err.message);
	process.exit(1);
});
