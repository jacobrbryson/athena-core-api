const jwt = require("jsonwebtoken");
const config = require("../config");

/**
 * Decode the Guardian session JWT the proxy forwards.
 *
 * The Guardians app authenticates with an httpOnly cookie; the proxy's
 * verifyAppToken re-exposes that token as the Authorization bearer and copies it
 * into `x-user-authorization` before swapping in the Cloud Run service token. So
 * the Guardian's own JWT reliably arrives as `x-user-authorization` (Cloud Run)
 * or `authorization` (local dev). Returns the decoded guardian payload (with
 * guardian_id, display_name, adventure_key, …), or null if absent / not a
 * guardian token / invalid.
 */
function decodeGuardianFromRequest(req) {
	if (!config.JWT_SECRET) return null;
	const header =
		req.headers["x-user-authorization"] || req.headers.authorization || "";
	if (!header.startsWith("Bearer ")) return null;
	try {
		const decoded = jwt.verify(header.slice("Bearer ".length), config.JWT_SECRET);
		return decoded && decoded.kind === "guardian" ? decoded : null;
	} catch {
		return null;
	}
}

module.exports = { decodeGuardianFromRequest };
