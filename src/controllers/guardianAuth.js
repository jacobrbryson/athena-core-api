const guardianAuthService = require("../services/guardianAuth");

/**
 * PUBLIC: validate Guardian credentials. Called by the proxy when minting a
 * Guardian session JWT (the proxy captures the real client IP / user agent
 * and signs the token). Returns the guardian identity, or 401 with a generic
 * message that never reveals which part of the credential was wrong.
 */
async function validateGuardian(req, res) {
	const body = req.body || {};
	try {
		const identity = await guardianAuthService.validateCredentials({
			guardianId: body.guardian_id,
			guardianSecret: body.guardian_secret,
			// The proxy forwards the real client context for attempt logging.
			ip: body.ip || req.ip,
			userAgent: body.user_agent || req.headers["user-agent"],
		});
		return res.json({ success: true, guardian: identity });
	} catch (err) {
		// Always the generic message — do not leak which field was wrong.
		return res.status(401).json({
			success: false,
			message: guardianAuthService.GENERIC_ERROR,
		});
	}
}

/**
 * PUBLIC: redeem a single-use QR login token. Called by the proxy when minting
 * a Guardian session JWT from a /q/<token> link. The token is consumed
 * server-side (single-use); on success returns the guardian identity, on any
 * failure a generic 401.
 */
async function redeemGuardianToken(req, res) {
	const body = req.body || {};
	try {
		const identity = await guardianAuthService.redeemLoginToken({
			token: body.token,
			ip: body.ip || req.ip,
			userAgent: body.user_agent || req.headers["user-agent"],
		});
		return res.json({ success: true, guardian: identity });
	} catch (err) {
		// Permanent QR token already used — tell the client to redirect to the
		// manual gate. Not a 401 (that's a hard failure); this is an expected
		// post-first-use flow. No session is issued.
		if (err.redirectGuardianId) {
			return res.json({
				success: false,
				redirect_to_gate: true,
				guardian_id: err.redirectGuardianId,
			});
		}
		return res.status(401).json({
			success: false,
			message: guardianAuthService.GENERIC_ERROR,
		});
	}
}

module.exports = { validateGuardian, redeemGuardianToken };
