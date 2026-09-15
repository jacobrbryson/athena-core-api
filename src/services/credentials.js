const { v4: uuidv4 } = require("uuid");
const pool = require("../helpers/db");
const { encrypt, decrypt } = require("../helpers/crypto");
const { withTransaction } = require("./parent-helpers");

/**
 * Per-user credential store for third-party integrations.
 *
 * Holds the credentials an Athena user grants directly — Google Calendar,
 * Strava, Whoop, a user's own API key — encrypted at rest under the rotating
 * keyring (helpers/crypto.js). The OAuth dance that produces them, and the
 * refresh-on-use logic, live in the connector layer (Phase 3); this module is
 * only storage, and it is deliberately dull.
 *
 * Two rules hold everywhere in here:
 *
 *   1. Plaintext tokens exist only inside get(). Every other function returns
 *      a "public" record with no ciphertext and no secrets, so a route can
 *      serialize the result without thinking about it.
 *   2. Every link, read, refresh and revoke writes a user_credential_audit
 *      row, in the same transaction as the change it describes.
 *
 * CALLER CONTRACT: `profileId` must already have been resolved from an
 * authenticated identity. This module does not authenticate or authorize —
 * the routes do, and pass down a profile the caller provably owns.
 */

const PROVIDERS = new Set(["google_calendar", "strava", "whoop", "openai"]);
const KINDS = new Set(["oauth2", "api_key"]);

const STATUS_ACTIVE = "active";
const STATUS_NEEDS_REAUTH = "needs_reauth";
const STATUS_REVOKED = "revoked";

/** Refresh this long before actual expiry, so a token never expires mid-call. */
const EXPIRY_SKEW_SECONDS = 120;

const PUBLIC_COLUMNS = `id, uuid, profile_id, provider, kind, external_account_id,
	display_name, token_type, scopes, expires_at, status,
	last_refreshed_at, last_used_at, created_at, updated_at, revoked_at`;

function httpError(message, status) {
	return Object.assign(new Error(message), { status });
}

function assertProvider(provider) {
	if (!PROVIDERS.has(provider)) {
		throw httpError(`Unsupported credential provider: ${provider}`, 400);
	}
	return provider;
}

function assertKind(kind) {
	if (!KINDS.has(kind)) throw httpError(`Unsupported credential kind: ${kind}`, 400);
	return kind;
}

function normalizeAccountId(value) {
	// '' rather than NULL: the unique key must actually constrain, and MySQL
	// treats NULLs as distinct.
	return value == null ? "" : String(value).trim().slice(0, 190);
}

/**
 * Provider expiry comes as `expires_in` seconds far more often than as a
 * timestamp. Accept either, and null for "does not expire".
 */
function resolveExpiry({ expiresAt, expiresIn }) {
	if (expiresAt instanceof Date) return expiresAt;
	if (typeof expiresAt === "string" && expiresAt.trim()) {
		const parsed = new Date(expiresAt);
		if (!Number.isNaN(parsed.getTime())) return parsed;
	}
	const seconds = Number(expiresIn);
	if (Number.isFinite(seconds) && seconds > 0) {
		return new Date(Date.now() + seconds * 1000);
	}
	return null;
}

/** Shape returned to callers. Never contains ciphertext or a token. */
function toPublic(row) {
	if (!row) return null;
	return {
		uuid: row.uuid,
		provider: row.provider,
		kind: row.kind,
		external_account_id: row.external_account_id || null,
		display_name: row.display_name,
		scopes: row.scopes ? row.scopes.split(/\s+/).filter(Boolean) : [],
		token_type: row.token_type,
		expires_at: row.expires_at,
		status: row.status,
		expired: isExpired(row),
		last_refreshed_at: row.last_refreshed_at,
		last_used_at: row.last_used_at,
		created_at: row.created_at,
		revoked_at: row.revoked_at,
	};
}

/** True when the access token is past (or within the skew of) its expiry. */
function isExpired(row) {
	if (!row || !row.expires_at) return false;
	const at = new Date(row.expires_at).getTime();
	if (Number.isNaN(at)) return false;
	return at - EXPIRY_SKEW_SECONDS * 1000 <= Date.now();
}

async function audit(conn, { credentialId, profileId, provider, action, actor, detail }) {
	await conn.query(
		`INSERT INTO user_credential_audit
			(credential_id, profile_id, provider, action, actor, detail)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[
			credentialId || null,
			profileId,
			provider,
			action,
			actor ? String(actor).slice(0, 120) : null,
			detail ? String(detail).slice(0, 255) : null,
		]
	);
}

async function findRow(conn, profileId, provider, externalAccountId) {
	const params = [profileId, provider];
	let sql = `SELECT * FROM user_credential WHERE profile_id = ? AND provider = ?`;
	if (externalAccountId !== undefined) {
		sql += ` AND external_account_id = ?`;
		params.push(normalizeAccountId(externalAccountId));
	}
	sql += ` ORDER BY (status = 'active') DESC, updated_at DESC LIMIT 1`;
	const [rows] = await conn.query(sql, params);
	return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Store (or replace) a credential. Re-linking the same account overwrites the
 * existing row, including reviving one that was revoked.
 *
 * @returns {Promise<object>} the public record — no tokens
 */
async function put({
	profileId,
	provider,
	kind = "oauth2",
	externalAccountId,
	displayName,
	accessToken,
	refreshToken,
	tokenType,
	scopes,
	expiresAt,
	expiresIn,
	actor = "user",
}) {
	if (!profileId) throw httpError("profileId is required", 400);
	assertProvider(provider);
	assertKind(kind);
	if (typeof accessToken !== "string" || !accessToken.trim()) {
		throw httpError("accessToken is required", 400);
	}

	const accountId = normalizeAccountId(externalAccountId);
	const accessEnc = await encrypt(accessToken);
	const refreshEnc =
		typeof refreshToken === "string" && refreshToken.trim()
			? await encrypt(refreshToken)
			: null;
	const expiry = resolveExpiry({ expiresAt, expiresIn });
	const scopeText = Array.isArray(scopes) ? scopes.join(" ") : scopes || null;

	return withTransaction(async (conn) => {
		const existing = await findRow(conn, profileId, provider, accountId);
		const uuid = existing ? existing.uuid : uuidv4();

		await conn.query(
			`INSERT INTO user_credential
				(uuid, profile_id, provider, kind, external_account_id, display_name,
				 access_token_enc, refresh_token_enc, token_type, scopes, expires_at,
				 status, last_refreshed_at, revoked_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW(), NULL)
			 ON DUPLICATE KEY UPDATE
				kind = VALUES(kind),
				display_name = VALUES(display_name),
				access_token_enc = VALUES(access_token_enc),
				-- A provider that only issues a refresh token on first consent
				-- must not have it wiped by a later re-link that omits one.
				refresh_token_enc = COALESCE(VALUES(refresh_token_enc), refresh_token_enc),
				token_type = VALUES(token_type),
				scopes = VALUES(scopes),
				expires_at = VALUES(expires_at),
				status = 'active',
				last_refreshed_at = NOW(),
				revoked_at = NULL`,
			[
				uuid,
				profileId,
				provider,
				kind,
				accountId,
				displayName ? String(displayName).slice(0, 160) : null,
				accessEnc,
				refreshEnc,
				tokenType || null,
				scopeText,
				expiry,
			]
		);

		const row = await findRow(conn, profileId, provider, accountId);
		await audit(conn, {
			credentialId: row.id,
			profileId,
			provider,
			action: "linked",
			actor,
			detail: existing ? "relinked" : "first link",
		});
		return toPublic(row);
	});
}

/**
 * Replace the tokens on an existing credential after a refresh. Used by the
 * connector layer's refresh path, which already holds the row.
 *
 * @returns {Promise<object>} the public record
 */
async function updateTokens(
	uuid,
	{ accessToken, refreshToken, tokenType, scopes, expiresAt, expiresIn, actor = "refresh" }
) {
	if (typeof accessToken !== "string" || !accessToken.trim()) {
		throw httpError("accessToken is required", 400);
	}
	const accessEnc = await encrypt(accessToken);
	const refreshEnc =
		typeof refreshToken === "string" && refreshToken.trim()
			? await encrypt(refreshToken)
			: null;
	const expiry = resolveExpiry({ expiresAt, expiresIn });
	const scopeText = Array.isArray(scopes) ? scopes.join(" ") : scopes || null;

	return withTransaction(async (conn) => {
		const [rows] = await conn.query(
			`SELECT * FROM user_credential WHERE uuid = ? LIMIT 1`,
			[uuid]
		);
		const row = rows[0];
		if (!row) throw httpError("Credential not found", 404);

		await conn.query(
			`UPDATE user_credential SET
				access_token_enc = ?,
				refresh_token_enc = COALESCE(?, refresh_token_enc),
				token_type = COALESCE(?, token_type),
				scopes = COALESCE(?, scopes),
				expires_at = ?,
				status = 'active',
				last_refreshed_at = NOW(),
				revoked_at = NULL
			 WHERE id = ?`,
			[accessEnc, refreshEnc, tokenType || null, scopeText, expiry, row.id]
		);

		await audit(conn, {
			credentialId: row.id,
			profileId: row.profile_id,
			provider: row.provider,
			action: "refreshed",
			actor,
		});

		const [after] = await conn.query(
			`SELECT * FROM user_credential WHERE id = ? LIMIT 1`,
			[row.id]
		);
		return toPublic(after[0]);
	});
}

/**
 * Mark a credential unusable without deleting it — the refresh token was
 * rejected, or the user revoked access at the provider. The row stays so the
 * UI can say "reconnect Strava" rather than silently showing nothing.
 */
async function markNeedsReauth(uuid, { actor = "connector", detail } = {}) {
	return withTransaction(async (conn) => {
		const [rows] = await conn.query(
			`SELECT * FROM user_credential WHERE uuid = ? LIMIT 1`,
			[uuid]
		);
		const row = rows[0];
		if (!row) return null;

		await conn.query(
			`UPDATE user_credential SET status = ?, access_token_enc = NULL WHERE id = ?`,
			[STATUS_NEEDS_REAUTH, row.id]
		);
		await audit(conn, {
			credentialId: row.id,
			profileId: row.profile_id,
			provider: row.provider,
			action: "reauth_required",
			actor,
			detail,
		});
		return toPublic({ ...row, status: STATUS_NEEDS_REAUTH });
	});
}

/**
 * Revoke a credential. The ciphertext is cleared — a revoked token is a
 * liability with no remaining use — but the row and its audit history stay.
 *
 * @returns {Promise<{provider: string, revoked: boolean}>}
 */
async function revoke(profileId, provider, { externalAccountId, actor = "user" } = {}) {
	assertProvider(provider);
	return withTransaction(async (conn) => {
		const row = await findRow(conn, profileId, provider, externalAccountId);
		if (!row || row.status === STATUS_REVOKED) {
			return { provider, revoked: false };
		}
		await conn.query(
			`UPDATE user_credential SET
				status = ?, revoked_at = NOW(),
				access_token_enc = NULL, refresh_token_enc = NULL
			 WHERE id = ?`,
			[STATUS_REVOKED, row.id]
		);
		await audit(conn, {
			credentialId: row.id,
			profileId,
			provider,
			action: "revoked",
			actor,
		});
		return { provider, revoked: true };
	});
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Decrypt and return a usable credential. THE ONLY function here that yields
 * plaintext — keep its result out of responses, logs and model prompts.
 *
 * Returns null when there is no active credential, so callers branch on
 * "connected or not" rather than catching.
 *
 * A credential flagged `needs_reauth` is NOT null. markNeedsReauth clears the
 * access token but keeps the grant, and that grant is usually still good — the
 * flag is raised by a rate-limited 403 or one unreadable shared calendar at
 * least as often as by a real revocation. Such a row comes back with a null
 * accessToken and `expired: true`, so the refresh path tries it and a link
 * flagged over something transient heals itself. Refusing it here is what made
 * every hiccup cost the user a manual reconnect.
 *
 * THROWS `credential_unreadable` when a credential IS stored but its
 * ciphertext cannot be opened. That is a server-side fault — a key pruned too
 * early, a keyring not configured on this host — and must never be conflated
 * with "not connected": the link is fine, and sending the user off to
 * reconnect it cannot fix anything.
 *
 * @returns {Promise<{uuid,provider,accessToken,refreshToken,expiresAt,expired,scopes,externalAccountId}|null>}
 */
async function get(profileId, provider, { externalAccountId, actor = "athena" } = {}) {
	assertProvider(provider);
	const row = await findRow(pool, profileId, provider, externalAccountId);
	if (!row || row.status === STATUS_REVOKED) return null;
	// Neither token is nothing to work with. Either one alone is something.
	if (!row.access_token_enc && !row.refresh_token_enc) return null;

	let accessToken = null;
	let refreshToken = null;
	try {
		if (row.access_token_enc) accessToken = await decrypt(row.access_token_enc);
		if (row.refresh_token_enc) refreshToken = await decrypt(row.refresh_token_enc);
	} catch (err) {
		// Unreadable ciphertext is a real incident (a key pruned too early, a
		// keyring missing on this host, a corrupt row) — record it and tell the
		// caller WHY. Returning null here made this indistinguishable from "not
		// connected" all the way up to the prompt, which is how a working link
		// came to look like an unbuilt feature.
		//
		// The row is deliberately left untouched: the plaintext is recoverable
		// the moment the right key is back on the keyring, so this must not
		// mark the credential dead or clear its ciphertext.
		console.error(
			`[credentials] Failed to decrypt ${provider} credential for profile ${profileId}:`,
			err.message
		);
		await audit(pool, {
			credentialId: row.id,
			profileId,
			provider,
			action: "failed",
			actor,
			detail: `decrypt failed: ${err.message}`,
		});
		throw Object.assign(new Error(`${provider} credential cannot be decrypted`), {
			status: 503,
			code: "credential_unreadable",
		});
	}

	await pool.query(`UPDATE user_credential SET last_used_at = NOW() WHERE id = ?`, [
		row.id,
	]);
	await audit(pool, {
		credentialId: row.id,
		profileId,
		provider,
		action: "read",
		actor,
	});

	// No access token means there is nothing to hand back that could work, so
	// the caller must refresh — the same branch an expiry takes.
	const expired = !accessToken || isExpired(row);
	return {
		uuid: row.uuid,
		provider: row.provider,
		kind: row.kind,
		status: row.status,
		accessToken,
		refreshToken,
		tokenType: row.token_type,
		expiresAt: row.expires_at,
		expired,
		needsRefresh: expired && !!refreshToken,
		scopes: row.scopes ? row.scopes.split(/\s+/).filter(Boolean) : [],
		externalAccountId: row.external_account_id || null,
	};
}

/** Every credential a profile has linked. Public records only. */
async function list(profileId) {
	const [rows] = await pool.query(
		`SELECT ${PUBLIC_COLUMNS} FROM user_credential
		 WHERE profile_id = ? AND status <> ? ORDER BY provider`,
		[profileId, STATUS_REVOKED]
	);
	return rows.map(toPublic);
}

/** One provider's connection state. Public record, or null when not linked. */
async function status(profileId, provider, { externalAccountId } = {}) {
	assertProvider(provider);
	const row = await findRow(pool, profileId, provider, externalAccountId);
	if (!row || row.status === STATUS_REVOKED) return null;
	return toPublic(row);
}

/** Recent audit entries for a profile, newest first. For the user's own view. */
async function history(profileId, { provider, limit = 50 } = {}) {
	const params = [profileId];
	let sql = `SELECT provider, action, actor, detail, created_at
		FROM user_credential_audit WHERE profile_id = ?`;
	if (provider) {
		assertProvider(provider);
		sql += ` AND provider = ?`;
		params.push(provider);
	}
	sql += ` ORDER BY created_at DESC LIMIT ?`;
	params.push(Math.min(Math.max(Number(limit) || 50, 1), 500));
	const [rows] = await pool.query(sql, params);
	return rows;
}

module.exports = {
	put,
	get,
	list,
	status,
	history,
	revoke,
	updateTokens,
	markNeedsReauth,
	isExpired,
	PROVIDERS,
	EXPIRY_SKEW_SECONDS,
	STATUS_ACTIVE,
	STATUS_NEEDS_REAUTH,
	STATUS_REVOKED,
};
