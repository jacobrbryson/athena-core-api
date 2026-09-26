#!/usr/bin/env node
/**
 * One-time setup for Athena's own database — the place she dreams into.
 *
 *   ATHENA_MIND_DB_PASS=<new password> node db/mind-setup.js
 *
 * Runs with the ADMIN connection from .env (DB_HOST / DB_USER / DB_PASS) and:
 *   1. creates the `athena_mind` database,
 *   2. creates the `athena_mind` MySQL user (or resets its password),
 *   3. grants that user rights on athena_mind.* and NOTHING else,
 *   4. checks the admin user can read it (the chat path reads her tables with
 *      the main connection, through queries code builds — never hers).
 *
 * Idempotent: safe to re-run, e.g. to rotate the password.
 *
 * The grant list is the boundary, so it is spelled out rather than ALL: no
 * routines, triggers or events (things that would run later, outside a dream
 * and outside the audit log), no FILE, no GRANT OPTION, nothing global.
 *
 * Env:
 *   ATHENA_MIND_DB_PASS   required — the new user's password
 *   ATHENA_MIND_DB_USER   default athena_mind
 *   ATHENA_MIND_DB_NAME   default athena_mind
 *   ATHENA_MIND_DB_HOSTS  MySQL host pattern for the user, default '%'
 */
require("dotenv").config();
const mysql = require("mysql2/promise");

const IDENT = /^[A-Za-z0-9_]{1,64}$/;

const GRANTS = [
	"SELECT",
	"INSERT",
	"UPDATE",
	"DELETE",
	"CREATE",
	"DROP",
	"ALTER",
	"INDEX",
	"REFERENCES",
	"CREATE VIEW",
	"SHOW VIEW",
	"CREATE TEMPORARY TABLES",
	"LOCK TABLES",
];

async function main() {
	const pass = process.env.ATHENA_MIND_DB_PASS;
	const user = process.env.ATHENA_MIND_DB_USER || "athena_mind";
	const db = process.env.ATHENA_MIND_DB_NAME || "athena_mind";
	const hosts = process.env.ATHENA_MIND_DB_HOSTS || "%";
	if (!pass || pass.length < 16) throw new Error("Set ATHENA_MIND_DB_PASS (16+ characters).");
	if (!IDENT.test(user) || !IDENT.test(db)) throw new Error("User and database names must be plain identifiers.");
	if (db === process.env.DB_NAME) throw new Error("athena_mind must not be the main database.");

	const conn = await mysql.createConnection({
		host: process.env.DB_HOST,
		user: process.env.DB_USER,
		password: process.env.DB_PASS,
		port: process.env.DB_PORT || 3306,
	});
	try {
		console.log(`==> database ${db}`);
		await conn.query(`CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);

		console.log(`==> user '${user}'@'${hosts}'`);
		await conn.query(`CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?;`, [user, hosts, pass]);
		await conn.query(`ALTER USER ?@? IDENTIFIED BY ?;`, [user, hosts, pass]);

		// Start from nothing, so a re-run also takes away anything granted by hand.
		await conn.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ?@?;`, [user, hosts]).catch(() => undefined);
		await conn.query(`GRANT ${GRANTS.join(", ")} ON \`${db}\`.* TO ?@?;`, [user, hosts]);

		const [grants] = await conn.query(`SHOW GRANTS FOR ?@?;`, [user, hosts]);
		for (const g of grants) console.log("    ", Object.values(g)[0]);

		// The chat path reads her tables through the main connection.
		await conn.query(`CREATE TABLE IF NOT EXISTS \`${db}\`._setup_check (id INT PRIMARY KEY);`);
		await conn.query(`SELECT COUNT(*) FROM \`${db}\`._setup_check;`);
		await conn.query(`DROP TABLE \`${db}\`._setup_check;`);
		console.log(`==> main user ${process.env.DB_USER} can read ${db}`);
		console.log("\nDone. Give the nightly job ATHENA_MIND_DB_USER and ATHENA_MIND_DB_PASS —");
		console.log("see deploy/scripts/setup-athena-mind.sh. Then apply migration 0046_athena_dreams.");
	} finally {
		await conn.end();
	}
}

main().catch((err) => {
	console.error("[mind-setup]", err.message);
	process.exit(1);
});
