#!/usr/bin/env node
/**
 * Minimal forward-only SQL migration runner.
 *
 * Applies every `*.up.sql` file in ./migrations (lexicographic order) that
 * has not already been recorded in the `schema_migrations` table. Each file
 * is executed inside a single multi-statement connection.
 *
 * Usage:
 *   node db/migrate.js            # apply all pending *.up.sql migrations
 *   node db/migrate.js status     # list applied / pending migrations
 *   node db/migrate.js down <id>  # run a single <id>.down.sql (manual rollback)
 *
 * Connection comes from the same env vars used by src/helpers/db.js
 * (DB_HOST, DB_USER, DB_PASS, DB_NAME, DB_PORT).
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function connect() {
	return mysql.createConnection({
		host: process.env.DB_HOST,
		user: process.env.DB_USER,
		password: process.env.DB_PASS,
		database: process.env.DB_NAME,
		port: process.env.DB_PORT || 3306,
		multipleStatements: true,
	});
}

async function ensureTable(conn) {
	await conn.query(
		`CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(191) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
	);
}

function listUpMigrations() {
	if (!fs.existsSync(MIGRATIONS_DIR)) return [];
	return fs
		.readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".up.sql"))
		.sort()
		.map((f) => ({ id: f.replace(/\.up\.sql$/, ""), file: f }));
}

async function appliedSet(conn) {
	const [rows] = await conn.query(`SELECT id FROM schema_migrations;`);
	return new Set(rows.map((r) => r.id));
}

async function up() {
	const conn = await connect();
	try {
		await ensureTable(conn);
		const applied = await appliedSet(conn);
		const pending = listUpMigrations().filter((m) => !applied.has(m.id));

		if (!pending.length) {
			console.log("✓ No pending migrations. Database is up to date.");
			return;
		}

		for (const m of pending) {
			const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, m.file), "utf8");
			console.log(`→ Applying ${m.file} ...`);
			await conn.query(sql);
			await conn.query(`INSERT INTO schema_migrations (id) VALUES (?);`, [
				m.id,
			]);
			console.log(`  ✓ Applied ${m.id}`);
		}
		console.log(`✓ Applied ${pending.length} migration(s).`);
	} finally {
		await conn.end();
	}
}

async function status() {
	const conn = await connect();
	try {
		await ensureTable(conn);
		const applied = await appliedSet(conn);
		for (const m of listUpMigrations()) {
			console.log(`${applied.has(m.id) ? "[applied]" : "[pending]"} ${m.id}`);
		}
	} finally {
		await conn.end();
	}
}

async function down(id) {
	if (!id) {
		console.error("Usage: node db/migrate.js down <migration-id>");
		process.exit(1);
	}
	const file = path.join(MIGRATIONS_DIR, `${id}.down.sql`);
	if (!fs.existsSync(file)) {
		console.error(`No down migration found: ${file}`);
		process.exit(1);
	}
	const conn = await connect();
	try {
		await ensureTable(conn);
		console.log(`→ Reverting ${id} ...`);
		await conn.query(fs.readFileSync(file, "utf8"));
		await conn.query(`DELETE FROM schema_migrations WHERE id = ?;`, [id]);
		console.log(`✓ Reverted ${id}`);
	} finally {
		await conn.end();
	}
}

const [cmd, arg] = process.argv.slice(2);
const run =
	cmd === "status" ? status() : cmd === "down" ? down(arg) : up();

run.catch((err) => {
	console.error("Migration failed:", err.message);
	process.exit(1);
});
