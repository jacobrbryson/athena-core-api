const pool = require("../helpers/db");
const { verifySecret } = require("../helpers/secret");

/**
 * Guardian authentication service.
 *
 * Validates a Guardian ID + Guardian Secret against the guardian_credential
 * table and returns the identity used to mint a session JWT (the proxy mints
 * the token so it can bind it to the real client IP, mirroring the child and
 * Google flows). Every attempt is logged to guardian_login_attempt.
 *
 * Security notes:
 *   - The secret is compared against a salted hash (helpers/secret.js).
 *   - Callers MUST surface a single generic error to clients and never reveal
 *     whether the Guardian ID or the Guardian Secret was wrong.
 *   - We always run a hash verification (even when no credential is found,
 *     against a dummy hash) to keep timing uniform.
 */

const GUARDIAN_ID_RE = /^\d{8}$/;
const GUARDIAN_SECRET_RE = /^[A-Za-z0-9]{6}$/;

// A throwaway hash with the real format, used to equalize timing when the
// Guardian ID does not exist (so "unknown id" and "wrong secret" cost the
// same). It will never match a real secret.
const DUMMY_HASH =
	"scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const GENERIC_ERROR = "Guardian credentials not recognized.";

/** Record a login attempt. Never throws (logging must not block auth). */
async function logAttempt({ guardianId, success, ip, userAgent }) {
	try {
		await pool.query(
			`INSERT INTO guardian_login_attempt (guardian_id, success, ip, user_agent)
       VALUES (?, ?, ?, ?);`,
			[
				typeof guardianId === "string" ? guardianId.slice(0, 32) : null,
				success ? 1 : 0,
				ip ? String(ip).slice(0, 64) : null,
				userAgent ? String(userAgent).slice(0, 255) : null,
			]
		);
	} catch (err) {
		console.error("[guardianAuth] logAttempt failed:", err.message);
	}
}

/**
 * Validate Guardian credentials.
 *
 * @returns {Promise<object>} the guardian identity on success.
 * @throws {Error} with message === GENERIC_ERROR on any failure.
 */
async function validateCredentials({ guardianId, guardianSecret, ip, userAgent }) {
	const id = typeof guardianId === "string" ? guardianId.trim() : "";
	const secret = typeof guardianSecret === "string" ? guardianSecret.trim() : "";

	// Shape validation first. Still logged as a failed attempt.
	if (!GUARDIAN_ID_RE.test(id) || !GUARDIAN_SECRET_RE.test(secret)) {
		await logAttempt({ guardianId: id, success: false, ip, userAgent });
		throw new Error(GENERIC_ERROR);
	}

	const [rows] = await pool.query(
		`SELECT id, guardian_id, guardian_secret_hash, display_name,
            adventure_key, participant_type, is_active, last_login_at
     FROM guardian_credential
     WHERE guardian_id = ?
     LIMIT 1;`,
		[id]
	);
	const row = rows[0];

	// Always verify against *some* hash to keep timing uniform.
	const hash = row ? row.guardian_secret_hash : DUMMY_HASH;
	const secretOk = verifySecret(secret, hash);

	if (!row || !row.is_active || !secretOk) {
		await logAttempt({ guardianId: id, success: false, ip, userAgent });
		throw new Error(GENERIC_ERROR);
	}

	// First-ever login is detected by a NULL last_login_at *before* this login.
	// Used to drive the new-vs-returning "first contact" greeting. We stamp
	// last_login_at now, so every subsequent login reads as returning.
	const isFirstLogin = row.last_login_at == null;

	await pool.query(
		`UPDATE guardian_credential SET last_login_at = NOW() WHERE id = ?;`,
		[row.id]
	);
	await logAttempt({ guardianId: id, success: true, ip, userAgent });

	return {
		credential_id: row.id,
		guardian_id: row.guardian_id,
		display_name: row.display_name,
		adventure_key: row.adventure_key,
		participant_type: row.participant_type,
		is_first_login: isFirstLogin,
	};
}

module.exports = {
	GENERIC_ERROR,
	GUARDIAN_ID_RE,
	GUARDIAN_SECRET_RE,
	validateCredentials,
	logAttempt,
};
