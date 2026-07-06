#!/usr/bin/env node
/**
 * Full "first time" experience reset for a Guardian account.
 *
 * Puts the account back to the state a brand-new player sees, so the whole
 * flow can be re-tested end to end: first-contact greeting → channel check →
 * the "Ratatouille is MISSING!!!" alarm → mission handoff → key hunt.
 *
 * Resets, for ONE guardian:
 *   1. Trail-mission progress (guardian_trail_key rows — keys become unused).
 *   2. First-login flag (guardian_credential.last_login_at → NULL) so the next
 *      sign-in counts as first contact and plays the alarm.
 *   3. QR first-use flag (qr_token_first_used_at → NULL) so a printed QR card
 *      signs in directly again instead of redirecting to the secret gate.
 *
 * Usage:
 *   npm run reset:experience              # defaults to the test account 12345678
 *   npm run reset:experience 87654321     # any guardian id
 *
 * NOTE: `npm run reset:trail` clears ONLY trail progress (use it to stage the
 * real team without wiping their returning-guardian status).
 *
 * Connection comes from the same env vars used by src/helpers/db.js
 * (DB_HOST, DB_USER, DB_PASS, DB_NAME, DB_PORT).
 */
require("dotenv").config();
const mysql = require("mysql2/promise");

const TRAIL_MISSION = "mission-1-ratatouille-trail";
const DEFAULT_GUARDIAN = "12345678";

async function main() {
	const guardianId = process.argv[2] || DEFAULT_GUARDIAN;
	if (!/^\d{8}$/.test(guardianId)) {
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
		const [trail] = await conn.query(
			`DELETE FROM guardian_trail_key WHERE guardian_id = ? AND mission_key = ?;`,
			[guardianId, TRAIL_MISSION]
		);
		const [cred] = await conn.query(
			`UPDATE guardian_credential
          SET last_login_at = NULL, qr_token_first_used_at = NULL
        WHERE guardian_id = ?;`,
			[guardianId]
		);
		if (!cred.affectedRows) {
			console.error(`✗ No guardian_credential row found for ${guardianId}.`);
			process.exit(1);
		}
		console.log(`✓ Experience reset for guardian ${guardianId}:`);
		console.log(`  • trail keys cleared: ${trail.affectedRows}`);
		console.log(`  • first login: next sign-in plays first contact + the alarm`);
		console.log(`  • QR card: first scan signs in directly again`);
		console.log(
			`\nSign in fresh (incognito, or after Exit) — do NOT rely on the 🎬 Onboarding toggle for this test.`
		);
	} finally {
		await conn.end();
	}
}

main().catch((err) => {
	console.error("Experience reset failed:", err.message);
	process.exit(1);
});
