const { AsyncLocalStorage } = require("node:async_hooks");
const pool = require("../helpers/db");
const context = new AsyncLocalStorage();

function denied() {
	return Object.assign(new Error("Guardian access or owner approval required"), { status: 403, code: "ACCESS_REQUIRED" });
}

async function allowed(identity) {
	if (!identity) return false;
	if (identity.kind === "guardian") {
		const [rows] = await pool.query("SELECT id FROM guardian_credential WHERE guardian_id = ? AND is_active = 1 AND participant_type = 'guardian' LIMIT 1", [identity.guardian_id]);
		return rows.length > 0;
	}
	if (identity.kind === "device" || identity.kind === "child") {
		const [rows] = identity.kind === "device"
			? await pool.query("SELECT p.google_id FROM paired_device d JOIN profile p ON p.id = d.profile_id WHERE d.id = ? AND d.profile_id = ? AND d.revoked_at IS NULL LIMIT 1", [identity.deviceId, identity.profileId])
			: await pool.query("SELECT google_id FROM profile WHERE uuid = ? LIMIT 1", [identity.profile_uuid]);
		return rows[0]?.google_id ? allowed({ google_id: rows[0].google_id }) : false;
	}
	const googleId = identity.google_id || identity.googleId || identity.sub;
	if (!googleId) return false;
	const [grants] = await pool.query("SELECT google_id FROM athena_access_grant WHERE google_id = ? AND revoked_at IS NULL", [googleId]);
	if (grants.length) return true;
	// A verified Google email is the link to issued credentials. Never trust
	// profile.email, profile.is_guardian, body fields, or client app headers.
	const email = identity.email_verified === true && typeof identity.email === "string"
		? identity.email.toLowerCase().trim() : null;
	const [rows] = await pool.query(`SELECT g.id FROM guardian_credential g
		WHERE g.is_active = 1 AND g.participant_type = 'guardian'
		AND LOWER(TRIM(g.email)) = COALESCE(?, (SELECT verified_email FROM athena_access_identity WHERE google_id = ?)) COLLATE utf8mb4_unicode_ci LIMIT 1`, [email, googleId]);
	return rows.length > 0;
}

async function recordVisit(identity, requestAccess = false) {
	const googleId = identity.google_id || identity.googleId || identity.sub;
	if (!googleId || identity.kind) throw denied();
	const email = identity.email_verified === true && typeof identity.email === "string" ? identity.email.toLowerCase().trim() : null;
	await pool.query(`INSERT INTO athena_access_identity (google_id, verified_email, requested_at)
		VALUES (?, ?, ${requestAccess ? "NOW()" : "NULL"}) ON DUPLICATE KEY UPDATE
		verified_email = COALESCE(VALUES(verified_email), verified_email), last_seen_at = NOW()
		${requestAccess ? ", requested_at = COALESCE(requested_at, NOW())" : ""}`, [googleId, email]);
	const isAllowed = await allowed(identity);
	await pool.query("INSERT INTO athena_access_audit (subject, action) VALUES (?, ?)", [googleId, requestAccess ? "requested" : isAllowed ? "visit_allowed" : "visit_locked"]);
	const [rows] = await pool.query("SELECT requested_at FROM athena_access_identity WHERE google_id = ?", [googleId]);
	return { allowed: isAllowed, requested: !!rows[0]?.requested_at };
}

// Check again before EVERY provider dispatch, including fallback, speech,
// embeddings, tools, and async work inherited from a request. Missing context
// fails closed. A background job must be charged to an owner-configured identity
// that passes the same live database authorization check.
async function assertModelAccess() {
	const active = context.getStore();
	const identity = active ? active.identity : process.env.ATHENA_BACKGROUND_GOOGLE_ID ? { google_id: process.env.ATHENA_BACKGROUND_GOOGLE_ID } : null;
	if (!(await allowed(identity))) throw denied();
}

module.exports = { context, allowed, recordVisit, assertModelAccess, denied };
