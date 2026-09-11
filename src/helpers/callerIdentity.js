const jwt = require("jsonwebtoken");
const config = require("../config");
const pool = require("./db");

/**
 * Resolve the VERIFIED profile identity behind a request.
 *
 * This exists so sessions can be authorized by *who you are* rather than by
 * what IP you happen to be on. The identity always comes out of a signed JWT —
 * never from a query parameter — because `profile_uuid` arrives from the client
 * and is trivially guessable/spoofable.
 *
 * Deliberately does NOT enforce the token's `client_ip` claim: the whole point
 * is that a child who walks outside and drops from wifi to cell data keeps
 * their session. The signature is the security boundary; the IP was only ever
 * a weak proxy for it.
 *
 * Three token shapes exist in this system (all signed with the same secret):
 *   - `kind: "child"`    → carries `profile_uuid` directly.
 *   - `kind: "guardian"` → carries `guardian_id`; the profile is resolved from
 *                          the credential's email.
 *   - parent/Google      → carries `google_id` / `email`.
 */

function verifiedToken(req) {
	if (!config.JWT_SECRET) return null;
	const header =
		req.headers["x-user-authorization"] || req.headers.authorization || "";
	if (!header.startsWith("Bearer ")) return null;
	try {
		return jwt.verify(header.slice("Bearer ".length), config.JWT_SECRET);
	} catch {
		return null;
	}
}

// NOTE: the legacy `profile` table predates the migrations and has no
// deleted_at column — filtering on it made every lookup throw (see the
// profile service, which never filters on it either).
async function profileIdForUuid(profileUuid) {
	if (typeof profileUuid !== "string" || !profileUuid.trim()) return null;
	const [rows] = await pool.query(
		`SELECT id FROM profile WHERE uuid = ? LIMIT 1;`,
		[profileUuid.trim()]
	);
	return rows[0]?.id ?? null;
}

async function profileIdForGoogleId(googleId) {
	if (!googleId) return null;
	const [rows] = await pool.query(
		`SELECT id FROM profile WHERE google_id = ? LIMIT 1;`,
		[String(googleId)]
	);
	return rows[0]?.id ?? null;
}

async function profileIdForGuardian(guardianId) {
	if (!guardianId) return null;
	const [rows] = await pool.query(
		`SELECT email FROM guardian_credential
      WHERE guardian_id = ? AND is_active = 1 LIMIT 1;`,
		[String(guardianId)]
	);
	const email = rows[0]?.email;
	if (!email) return null;
	// Same rule the login path uses to link a Guardian to a learning profile.
	const { resolveLinkedProfileId } = require("../services/guardianAuth");
	return resolveLinkedProfileId(email);
}

/**
 * The profile id this caller has cryptographically proven, or null when the
 * request carries no usable identity (an anonymous visitor).
 */
async function resolveCallerProfileId(req) {
	// Paired device (phone / car): opaque token checked against paired_device.
	const deviceToken = req.headers["x-athena-device-token"];
	if (typeof deviceToken === "string" && deviceToken) {
		const { authenticateDeviceToken } = require("../services/devices");
		const device = await authenticateDeviceToken(deviceToken).catch(() => null);
		return device?.profileId ?? null;
	}

	const decoded = verifiedToken(req);
	if (!decoded) return null;
	// `return await` (not bare `return`) so a failed lookup is caught here and
	// the caller is treated as anonymous, instead of the rejection escaping and
	// failing the whole request (500 on /session, 401 on /speech).
	try {
		if (decoded.kind === "child") return await profileIdForUuid(decoded.profile_uuid);
		if (decoded.kind === "guardian")
			return await profileIdForGuardian(decoded.guardian_id);
		if (decoded.google_id) return await profileIdForGoogleId(decoded.google_id);
	} catch (err) {
		console.warn("[callerIdentity] profile resolution failed:", err.message);
	}
	return null;
}

module.exports = { resolveCallerProfileId, verifiedToken };
