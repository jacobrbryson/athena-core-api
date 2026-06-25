#!/usr/bin/env node
/**
 * Guardian credential seeder.
 *
 * Loads Guardian credentials from a JSON file and upserts them into the
 * guardian_credential table, hashing each Guardian Secret (never stored in
 * plaintext). Safe to re-run: an existing guardian_id is updated in place.
 *
 * Usage:
 *   node db/seed-guardians.js [path-to-json]
 *
 *   # default file is db/guardians.test.json
 *   node db/seed-guardians.js
 *   node db/seed-guardians.js db/guardians.sample.json
 *   node db/seed-guardians.js /path/to/real-guardians.json
 *
 * JSON shape (array of objects):
 *   {
 *     "guardian_id": "12345678",        // exactly 8 numeric digits, unique
 *     "guardian_secret": "A1B2C3",      // exactly 6 alpha-numeric chars
 *     "display_name": "Test Guardian",
 *     "adventure_key": "lake_norman_guardians",
 *     "participant_type": "guardian",   // guardian | civilian_group
 *     "is_active": true
 *   }
 *
 * Connection comes from the same env vars used by src/helpers/db.js
 * (DB_HOST, DB_USER, DB_PASS, DB_NAME, DB_PORT).
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { hashSecret } = require("../src/helpers/secret");

const GUARDIAN_ID_RE = /^\d{8}$/;
const GUARDIAN_SECRET_RE = /^[A-Za-z0-9]{6}$/;
const VALID_ADVENTURES = new Set([
	"lake_norman_guardians",
	"rescue_ratatouille",
]);

function loadFile(file) {
	const resolved = path.resolve(file);
	if (!fs.existsSync(resolved)) {
		throw new Error(`Seed file not found: ${resolved}`);
	}
	const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
	if (!Array.isArray(parsed)) {
		throw new Error("Seed file must contain a JSON array of guardians.");
	}
	return parsed;
}

function validate(entry, index) {
	const errors = [];
	if (!GUARDIAN_ID_RE.test(String(entry.guardian_id || ""))) {
		errors.push("guardian_id must be exactly 8 numeric digits");
	}
	if (!GUARDIAN_SECRET_RE.test(String(entry.guardian_secret || ""))) {
		errors.push("guardian_secret must be exactly 6 alpha-numeric characters");
	}
	if (!VALID_ADVENTURES.has(entry.adventure_key)) {
		errors.push(
			`adventure_key must be one of: ${[...VALID_ADVENTURES].join(", ")}`
		);
	}
	if (errors.length) {
		throw new Error(`Entry #${index + 1} invalid: ${errors.join("; ")}`);
	}
}

async function connect() {
	return mysql.createConnection({
		host: process.env.DB_HOST,
		user: process.env.DB_USER,
		password: process.env.DB_PASS,
		database: process.env.DB_NAME,
		port: process.env.DB_PORT || 3306,
	});
}

async function seed() {
	const file = process.argv[2] || path.join(__dirname, "guardians.test.json");
	const guardians = loadFile(file);
	console.log(`→ Seeding ${guardians.length} guardian(s) from ${file}`);

	guardians.forEach(validate);

	const conn = await connect();
	try {
		let inserted = 0;
		let updated = 0;
		for (const g of guardians) {
			const hash = hashSecret(String(g.guardian_secret));
			const [result] = await conn.query(
				`INSERT INTO guardian_credential
           (guardian_id, guardian_secret_hash, display_name, adventure_key, participant_type, is_active)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           guardian_secret_hash = VALUES(guardian_secret_hash),
           display_name         = VALUES(display_name),
           adventure_key        = VALUES(adventure_key),
           participant_type     = VALUES(participant_type),
           is_active            = VALUES(is_active);`,
				[
					String(g.guardian_id),
					hash,
					g.display_name || null,
					g.adventure_key,
					g.participant_type || "guardian",
					g.is_active === false ? 0 : 1,
				]
			);
			// mysql2 reports affectedRows=1 for insert, 2 for an update via ON DUP KEY.
			if (result.affectedRows === 1) inserted++;
			else updated++;
			console.log(`  ✓ ${g.guardian_id} (${g.adventure_key})`);
		}
		console.log(
			`✓ Done. ${inserted} inserted, ${updated} updated, ${guardians.length} total.`
		);
	} finally {
		await conn.end();
	}
}

seed().catch((err) => {
	console.error("Guardian seed failed:", err.message);
	process.exit(1);
});
