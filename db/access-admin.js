#!/usr/bin/env node
// Operator-only utility. Never expose through an HTTP route or model tool.
require("dotenv").config();
const mysql = require("mysql2/promise");

async function main() {
	const [action, googleId, operator] = process.argv.slice(2);
	if (!["list", "grant", "revoke"].includes(action) || (action !== "list" && (!googleId || !operator))) {
		throw new Error("Usage: node db/access-admin.js list | grant <Google subject ID> <operator> | revoke <Google subject ID> <operator>");
	}
	// Explicit separate credentials: runtime/self-review must have SELECT only
	// on grants. Possession of these credentials is the owner's authorization.
	if (!process.env.ATHENA_ACCESS_ADMIN_DB_USER || !process.env.ATHENA_ACCESS_ADMIN_DB_PASS) {
		throw new Error("Owner-only ATHENA_ACCESS_ADMIN_DB_USER and ATHENA_ACCESS_ADMIN_DB_PASS are required");
	}
	const conn = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT || 3306, database: process.env.DB_NAME, user: process.env.ATHENA_ACCESS_ADMIN_DB_USER, password: process.env.ATHENA_ACCESS_ADMIN_DB_PASS });
	try {
		if (action === "list") {
			const [rows] = await conn.query(`SELECT i.google_id, i.verified_email, i.first_seen_at, i.requested_at,
				g.granted_at, g.revoked_at FROM athena_access_identity i LEFT JOIN athena_access_grant g USING (google_id)
				ORDER BY i.requested_at DESC, i.last_seen_at DESC`);
			console.table(rows);
			return;
		}
		await conn.beginTransaction();
		try {
			if (action === "grant") {
				await conn.query(`INSERT INTO athena_access_grant (google_id, granted_by) VALUES (?, ?)
					ON DUPLICATE KEY UPDATE granted_by = VALUES(granted_by), granted_at = NOW(), revoked_at = NULL`, [googleId, operator]);
			} else {
				await conn.query("UPDATE athena_access_grant SET revoked_at = NOW() WHERE google_id = ?", [googleId]);
			}
			await conn.query("INSERT INTO athena_access_audit (subject, action, actor) VALUES (?, ?, ?)", [googleId, action, operator]);
			await conn.commit();
			console.log(`Access ${action} recorded for ${googleId}`);
		} catch (err) { await conn.rollback(); throw err; }
	} finally { await conn.end(); }
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
