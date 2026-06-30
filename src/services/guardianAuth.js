const pool = require("../helpers/db");
const { verifySecret } = require("../helpers/secret");
const { hashToken } = require("../helpers/loginToken");

/**
 * Resolve the Athena profile.id for a guardian's email address.
 * Returns null if the guardian has no email or no matching profile exists.
 * Never throws — a missing link is not an auth failure.
 */
async function resolveLinkedProfileId(email) {
	if (!email) return null;
	try {
		const [rows] = await pool.query(
			`SELECT id FROM profile WHERE email = ? AND deleted_at IS NULL LIMIT 1;`,
			[email.toLowerCase().trim()]
		);
		return rows[0] ? rows[0].id : null;
	} catch (err) {
		console.error("[guardianAuth] resolveLinkedProfileId failed:", err.message);
		return null;
	}
}

/**
 * Determine the effective adventure for a guardian login.
 *
 * Rules:
 *  1. Load all adventures the guardian is enrolled in.
 *  2. End campaigns whose scheduled window has elapsed.
 *  3. Activate pending campaigns only inside their scheduled window.
 *  4. Route enrolled players to Rescue Ratatouille only while it is active
 *     and inside that window; otherwise retain their primary adventure.
 *
 * Never throws — a state resolution failure falls back to the primary key.
 */
async function resolveActiveAdventure(guardianId, primaryAdventureKey) {
	try {
		// Load all enrolled adventure keys for this guardian.
		const [enrolled] = await pool.query(
			`SELECT adventure_key FROM guardian_adventure WHERE guardian_id = ?;`,
			[guardianId]
		);
		const enrolledKeys = enrolled.map((r) => r.adventure_key);

		// Load the current state for each enrolled adventure in one query.
		if (!enrolledKeys.length) return primaryAdventureKey;
		const placeholders = enrolledKeys.map(() => "?").join(",");
		const [states] = await pool.query(
			`SELECT adventure_key, state,
              (scheduled_start_at IS NULL OR scheduled_start_at <= UTC_TIMESTAMP()) AS has_started,
              (scheduled_end_at IS NOT NULL AND scheduled_end_at <= UTC_TIMESTAMP()) AS has_ended
       FROM adventure_state
       WHERE adventure_key IN (${placeholders});`,
			enrolledKeys
		);
		const stateMap = Object.fromEntries(states.map((r) => [r.adventure_key, r]));

		// End campaigns as soon as their exclusive scheduled end time passes.
		for (const key of enrolledKeys) {
			const adventure = stateMap[key];
			if (adventure && adventure.state !== "ended" && adventure.has_ended) {
				await pool.query(
					`UPDATE adventure_state
           SET state = 'ended', ended_at = UTC_TIMESTAMP()
           WHERE adventure_key = ? AND state <> 'ended'
             AND scheduled_end_at IS NOT NULL
             AND scheduled_end_at <= UTC_TIMESTAMP();`,
					[key]
				);
				adventure.state = "ended";
			}
		}

		// Trigger pending campaigns only after their start and before their end.
		for (const key of enrolledKeys) {
			const adventure = stateMap[key];
			if (
				adventure &&
				adventure.state === "pending" &&
				adventure.has_started &&
				!adventure.has_ended
			) {
				const [result] = await pool.query(
					`UPDATE adventure_state
           SET state = 'active', activated_at = UTC_TIMESTAMP(), activated_by_guardian_id = ?
           WHERE adventure_key = ? AND state = 'pending'
             AND (scheduled_start_at IS NULL OR scheduled_start_at <= UTC_TIMESTAMP())
             AND (scheduled_end_at IS NULL OR scheduled_end_at > UTC_TIMESTAMP());`,
					[guardianId, key]
				);
				if (result.affectedRows === 1) {
					adventure.state = "active";
					console.log(`[guardianAuth] Adventure '${key}' activated by guardian ${guardianId}`);
				}
			}
		}

		const ratatouille = stateMap.rescue_ratatouille;
		if (
			enrolledKeys.includes("rescue_ratatouille") &&
			ratatouille?.state === "active" &&
			ratatouille.has_started &&
			!ratatouille.has_ended
		) {
			return "rescue_ratatouille";
		}

		return primaryAdventureKey;
	} catch (err) {
		console.error("[guardianAuth] resolveActiveAdventure failed:", err.message);
		return primaryAdventureKey;
	}
}

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
	const secret = typeof guardianSecret === "string" ? guardianSecret.trim().toUpperCase() : "";

	// Shape validation first. Still logged as a failed attempt.
	if (!GUARDIAN_ID_RE.test(id) || !GUARDIAN_SECRET_RE.test(secret)) {
		await logAttempt({ guardianId: id, success: false, ip, userAgent });
		throw new Error(GENERIC_ERROR);
	}

	const [rows] = await pool.query(
		`SELECT id, guardian_id, guardian_secret_hash, display_name, email, city,
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

	const [effectiveAdventure, linkedProfileId] = await Promise.all([
		resolveActiveAdventure(row.guardian_id, row.adventure_key),
		resolveLinkedProfileId(row.email),
	]);

	return {
		credential_id: row.id,
		guardian_id: row.guardian_id,
		display_name: row.display_name,
		email: row.email || null,
		city: row.city || null,
		adventure_key: effectiveAdventure,
		participant_type: row.participant_type,
		is_first_login: isFirstLogin,
		linked_profile_id: linkedProfileId,
	};
}

/**
 * Redeem a QR login token.
 *
 * Tries two paths in order:
 *
 *  1. Single-use token (guardian_login_token) — issued by issue-guardian-token.js
 *     for one-off manual links. Consumed atomically on first redeem; expires.
 *
 *  2. Permanent QR token (guardian_credential.qr_token_hash) — generated once at
 *     seed time and encoded into printed QR codes. Reusable, never expires, never
 *     changes so the printed URL stays valid across campaign resets.
 *
 * Only the SHA-256 hash of the token is stored in either case; the plaintext
 * lives only in the QR code. Same generic error and attempt logging as the
 * password flow.
 *
 * @returns {Promise<object>} the guardian identity on success.
 * @throws {Error} with message === GENERIC_ERROR on any failure.
 */
async function redeemLoginToken({ token, ip, userAgent }) {
	const raw = typeof token === "string" ? token.trim() : "";
	if (!raw) {
		await logAttempt({ guardianId: null, success: false, ip, userAgent });
		throw new Error(GENERIC_ERROR);
	}

	const tokenHash = hashToken(raw);

	// Atomically consume the token. Only an unused, unexpired token is claimed,
	// and only the single winning redeemer sees affectedRows === 1.
	const [consume] = await pool.query(
		`UPDATE guardian_login_token
       SET used_at = NOW()
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW();`,
		[tokenHash]
	);

	if (consume && consume.affectedRows === 1) {
		// Single-use token matched — load the credential it points at.
		const [rows] = await pool.query(
			`SELECT c.id, c.guardian_id, c.display_name, c.email, c.city,
              c.adventure_key, c.participant_type, c.is_active, c.last_login_at
       FROM guardian_login_token t
       JOIN guardian_credential c ON c.id = t.credential_id
       WHERE t.token_hash = ?
       LIMIT 1;`,
			[tokenHash]
		);
		const row = rows[0];
		if (!row || !row.is_active) {
			await logAttempt({ guardianId: row?.guardian_id ?? null, success: false, ip, userAgent });
			throw new Error(GENERIC_ERROR);
		}
		return await _buildIdentity(row, { ip, userAgent });
	}

	// --- Path 2: permanent QR token (guardian_credential.qr_token_hash) ---
	// Printed QR codes embed a permanent token that never changes across resets.
	const [rows] = await pool.query(
		`SELECT id, guardian_id, display_name, email, city,
            adventure_key, participant_type, is_active, last_login_at,
            qr_token_first_used_at
     FROM guardian_credential
     WHERE qr_token_hash = ?
     LIMIT 1;`,
		[tokenHash]
	);
	const row = rows[0];

	if (!row || !row.is_active) {
		await logAttempt({ guardianId: null, success: false, ip, userAgent });
		throw new Error(GENERIC_ERROR);
	}

	// First use: sign in and stamp the timestamp.
	// Subsequent scans: don't issue a session — tell the client to redirect to
	// the manual gate so the Guardian enters their secret (unless the device
	// already has a valid session, which the frontend handles before calling us).
	if (row.qr_token_first_used_at !== null) {
		await logAttempt({ guardianId: row.guardian_id, success: false, ip, userAgent });
		const err = new Error('qr_gate_redirect');
		err.redirectGuardianId = row.guardian_id;
		throw err;
	}

	await pool.query(
		`UPDATE guardian_credential SET qr_token_first_used_at = NOW() WHERE id = ?;`,
		[row.id]
	);

	return await _buildIdentity(row, { ip, userAgent });
}

/** Shared post-auth identity builder used by all redeem paths. */
async function _buildIdentity(row, { ip, userAgent }) {
	const isFirstLogin = row.last_login_at == null;

	await pool.query(
		`UPDATE guardian_credential SET last_login_at = NOW() WHERE id = ?;`,
		[row.id]
	);
	await logAttempt({ guardianId: row.guardian_id, success: true, ip, userAgent });

	const [effectiveAdventure, linkedProfileId] = await Promise.all([
		resolveActiveAdventure(row.guardian_id, row.adventure_key),
		resolveLinkedProfileId(row.email),
	]);

	return {
		credential_id: row.id,
		guardian_id: row.guardian_id,
		display_name: row.display_name,
		email: row.email || null,
		city: row.city || null,
		adventure_key: effectiveAdventure,
		participant_type: row.participant_type,
		is_first_login: isFirstLogin,
		linked_profile_id: linkedProfileId,
	};
}

module.exports = {
	GENERIC_ERROR,
	GUARDIAN_ID_RE,
	GUARDIAN_SECRET_RE,
	validateCredentials,
	redeemLoginToken,
	logAttempt,
	resolveActiveAdventure,
};
