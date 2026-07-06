#!/usr/bin/env node
/**
 * Rescue Ratatouille trail-mission reset.
 *
 * Deletes guardian_trail_key rows so the key hunt can be run again — used to
 * re-test with the seeded test account, or to stage a clean game for the real
 * team before the campaign week.
 *
 * Usage:
 *   node db/reset-trail.js               # reset EVERY guardian's trail progress
 *   node db/reset-trail.js 12345678      # reset one guardian's progress
 *
 * Connection comes from the same env vars used by src/helpers/db.js
 * (DB_HOST, DB_USER, DB_PASS, DB_NAME, DB_PORT).
 */
require("dotenv").config();
const mysql = require("mysql2/promise");

const TRAIL_MISSION = "mission-1-ratatouille-trail";

async function main() {
	const guardianId = process.argv[2] || null;
	if (guardianId && !/^\d{8}$/.test(guardianId)) {
		console.error(`Guardian ID must be exactly 8 digits, got: ${guardianId}`);
		process.exit(1);
	}

	const conn = await mysql.createConnection({
		host: process.env.DB_HOST,
		user: process.env.DB_USER,
		password: process.env.DB_PASS,
		database: process.env.DB_NAME,
		port: process.env.DB_PORT || 3306,
	});

	try {
		const [result] = guardianId
			? await conn.query(
					`DELETE FROM guardian_trail_key WHERE guardian_id = ? AND mission_key = ?;`,
					[guardianId, TRAIL_MISSION]
			  )
			: await conn.query(`DELETE FROM guardian_trail_key WHERE mission_key = ?;`, [
					TRAIL_MISSION,
			  ]);
		console.log(
			`✓ Trail reset${guardianId ? ` for guardian ${guardianId}` : " (all guardians)"}: ${result.affectedRows} key(s) cleared.`
		);
	} finally {
		await conn.end();
	}
}

main().catch((err) => {
	console.error("Trail reset failed:", err.message);
	process.exit(1);
});
