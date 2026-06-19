const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const pool = require("../helpers/db");
const { authorizeChildForParent } = require("./family");
const { logChildActivity } = require("./parent-helpers");

/**
 * Child authentication service (Phase 3).
 *
 * Parents generate login credentials for their children:
 *   - 'token': a friendly, easy-to-type code (e.g. SUNNY-APPLE, DRAGON-42)
 *   - 'qr':    a long random token encoded into a QR code
 *
 * Codes are revocable, regeneratable, and support optional expiration.
 * `validateCode` is the public redeem path used by the proxy when minting
 * a child session JWT.
 */

const ADJECTIVES = [
	"SUNNY", "BLUE", "BRAVE", "HAPPY", "SWIFT", "CALM", "BRIGHT", "COZY",
	"JOLLY", "KIND", "LUCKY", "MIGHTY", "NOBLE", "PROUD", "QUICK", "SHINY",
	"CLEVER", "GENTLE", "GOLDEN", "SILVER",
];
const NOUNS = [
	"APPLE", "RIVER", "DRAGON", "TIGER", "PANDA", "ROBOT", "ROCKET", "COMET",
	"FOREST", "MOUNTAIN", "OCEAN", "MEADOW", "FALCON", "DOLPHIN", "MAPLE",
	"PUMPKIN", "LANTERN", "COMPASS", "GALAXY", "PHOENIX",
];

const CODE_TYPES = new Set(["token", "qr"]);

function randomItem(arr) {
	return arr[crypto.randomInt(0, arr.length)];
}

/** Build a friendly, low-collision child token like SUNNY-APPLE or DRAGON-42. */
function generateFriendlyCode() {
	const style = crypto.randomInt(0, 3);
	if (style === 0) {
		return `${randomItem(ADJECTIVES)}-${randomItem(NOUNS)}`;
	}
	if (style === 1) {
		return `${randomItem(NOUNS)}-${crypto.randomInt(10, 100)}`;
	}
	return `${randomItem(ADJECTIVES)}-${randomItem(NOUNS)}-${crypto.randomInt(
		10,
		100
	)}`;
}

/** Long, URL-safe token for QR codes. */
function generateQrToken() {
	return `q_${crypto.randomBytes(24).toString("base64url")}`;
}

function normalizeCodeInput(code) {
	if (typeof code !== "string") return null;
	const trimmed = code.trim();
	if (!trimmed) return null;
	// Friendly codes are case-insensitive; QR tokens preserve case.
	return trimmed.startsWith("q_") ? trimmed : trimmed.toUpperCase();
}

function computeExpiry(payload) {
	const hours = Number(payload.expires_in_hours ?? payload.expiresInHours);
	if (Number.isFinite(hours) && hours > 0) {
		return new Date(Date.now() + hours * 3600 * 1000);
	}
	return null; // no expiration
}

/** Insert a code, retrying on the (rare) friendly-code collision. */
async function insertWithRetry(row, conn, attempts = 5) {
	for (let i = 0; i < attempts; i++) {
		try {
			await conn.query(
				`INSERT INTO child_login_code
         (uuid, family_id, child_profile_id, code_type, code, label, created_by_profile_id, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
				[
					row.uuid,
					row.familyId,
					row.childProfileId,
					row.codeType,
					row.code,
					row.label,
					row.createdBy,
					row.expiresAt,
				]
			);
			return row.code;
		} catch (err) {
			if (err.code === "ER_DUP_ENTRY" && row.codeType === "token") {
				row.code = generateFriendlyCode();
				row.uuid = uuidv4();
				continue;
			}
			throw err;
		}
	}
	throw new Error("Could not generate a unique login code");
}

/** Parent generates a login code for one of their children. */
async function createLoginCode(googleId, childUuid, payload = {}) {
	const { parent, family, child } = await authorizeChildForParent(
		googleId,
		childUuid
	);
	const codeType = CODE_TYPES.has(payload.code_type)
		? payload.code_type
		: "token";
	const code =
		codeType === "qr" ? generateQrToken() : generateFriendlyCode();
	const uuid = uuidv4();
	const expiresAt = computeExpiry(payload);
	const label =
		typeof payload.label === "string" ? payload.label.slice(0, 120) : null;

	const finalCode = await insertWithRetry(
		{
			uuid,
			familyId: family.id,
			childProfileId: child.profile_id,
			codeType,
			code,
			label,
			createdBy: parent.id,
			expiresAt,
		},
		pool
	);

	await logChildActivity({
		childProfileId: child.profile_id,
		parentProfileId: parent.id,
		activity: `A ${codeType === "qr" ? "QR" : "login"} code was generated for ${
			child.display_name || "child"
		}`,
		tableName: "child_login_code",
		recordId: null,
		actorProfileId: parent.id,
	});

	return {
		uuid,
		code_type: codeType,
		code: finalCode,
		label,
		expires_at: expiresAt,
		child_uuid: child.child_uuid,
	};
}

/** List active (non-revoked) codes for a child. */
async function listLoginCodes(googleId, childUuid) {
	const { child } = await authorizeChildForParent(googleId, childUuid);
	const [rows] = await pool.query(
		`SELECT uuid, code_type, code, label, expires_at, revoked_at, last_used_at, use_count, created_at
     FROM child_login_code
     WHERE child_profile_id = ?
     ORDER BY (revoked_at IS NULL) DESC, created_at DESC;`,
		[child.profile_id]
	);
	const now = Date.now();
	return rows.map((r) => ({
		uuid: r.uuid,
		code_type: r.code_type,
		code: r.code,
		label: r.label,
		expires_at: r.expires_at,
		revoked: r.revoked_at != null,
		expired: r.expires_at != null && new Date(r.expires_at).getTime() < now,
		last_used_at: r.last_used_at,
		use_count: r.use_count,
		created_at: r.created_at,
		active:
			r.revoked_at == null &&
			(r.expires_at == null || new Date(r.expires_at).getTime() >= now),
	}));
}

/** Revoke a single code (by its uuid) within the parent's family. */
async function revokeLoginCode(googleId, childUuid, codeUuid) {
	const { child } = await authorizeChildForParent(googleId, childUuid);
	const [result] = await pool.query(
		`UPDATE child_login_code SET revoked_at = NOW()
     WHERE uuid = ? AND child_profile_id = ? AND revoked_at IS NULL;`,
		[codeUuid, child.profile_id]
	);
	if (!result.affectedRows) {
		throw new Error("Login code not found");
	}
	return { success: true };
}

/**
 * PUBLIC redeem path. Validates a code and returns the child identity used
 * to mint a session JWT. Does not require parent auth.
 */
async function validateCode(rawCode) {
	const code = normalizeCodeInput(rawCode);
	if (!code) throw new Error("Invalid code");

	const [rows] = await pool.query(
		`SELECT clc.id, clc.code_type, clc.expires_at, clc.revoked_at,
            clc.child_profile_id, clc.family_id,
            p.uuid AS profile_uuid, cp.uuid AS child_uuid, cp.display_name,
            f.uuid AS family_uuid
     FROM child_login_code clc
     JOIN profile p ON p.id = clc.child_profile_id
     LEFT JOIN child_profiles cp ON cp.profile_id = clc.child_profile_id
     LEFT JOIN families f ON f.id = clc.family_id
     WHERE clc.code = ?
     LIMIT 1;`,
		[code]
	);
	const row = rows[0];
	if (!row) throw new Error("Code not recognized");
	if (row.revoked_at) throw new Error("This code has been revoked");
	if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
		throw new Error("This code has expired");
	}

	await pool.query(
		`UPDATE child_login_code SET last_used_at = NOW(), use_count = use_count + 1 WHERE id = ?;`,
		[row.id]
	);

	return {
		profile_uuid: row.profile_uuid,
		child_profile_id: row.child_profile_id,
		child_uuid: row.child_uuid,
		family_id: row.family_id,
		family_uuid: row.family_uuid,
		display_name: row.display_name,
	};
}

module.exports = {
	CODE_TYPES,
	generateFriendlyCode,
	generateQrToken,
	createLoginCode,
	listLoginCodes,
	revokeLoginCode,
	validateCode,
};
