#!/usr/bin/env node
/**
 * Read-only schema inspector. Reports which of the family-system tables
 * already exist and their column layout, so we can reconcile the migration
 * with any pre-existing tables. Makes NO changes.
 *
 *   node db/inspect.js
 */
require("dotenv").config();
const mysql = require("mysql2/promise");

const TABLES = [
	"families",
	"family_members",
	"child_profiles",
	"family_permissions",
	"family_consent",
	"family_consent_log",
	"child_login_code",
	"conversation_mode",
	"user_memory",
	"schema_migrations",
	"session",
	"profile",
	"profile_child",
];

async function main() {
	const conn = await mysql.createConnection({
		host: process.env.DB_HOST,
		user: process.env.DB_USER,
		password: process.env.DB_PASS,
		database: process.env.DB_NAME,
		port: process.env.DB_PORT || 3306,
	});
	try {
		console.log(`Database: ${process.env.DB_NAME}\n`);
		for (const table of TABLES) {
			const [rows] = await conn.query(
				`SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION;`,
				[table]
			);
			if (!rows.length) {
				console.log(`✗ ${table}: (does not exist)`);
				continue;
			}
			const [[count]] = await conn.query(
				`SELECT COUNT(*) AS n FROM \`${table}\`;`
			);
			console.log(`✓ ${table}: EXISTS (${count.n} rows)`);
			for (const c of rows) {
				console.log(
					`    - ${c.COLUMN_NAME} ${c.COLUMN_TYPE}` +
						`${c.COLUMN_KEY ? " [" + c.COLUMN_KEY + "]" : ""}` +
						`${c.EXTRA ? " " + c.EXTRA : ""}`
				);
			}
		}
	} finally {
		await conn.end();
	}
}

main().catch((err) => {
	console.error("Inspect failed:", err.message);
	process.exit(1);
});
