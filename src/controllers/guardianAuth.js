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

module.exports = { validateGuardian };
