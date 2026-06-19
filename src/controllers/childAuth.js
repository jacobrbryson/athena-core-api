const childAuthService = require("../services/childAuth");

/** Parent-authenticated: generate a login code for a child. */
async function createCode(req, res) {
	try {
		const code = await childAuthService.createLoginCode(
			req.user.googleId,
			req.params.childUuid,
			req.body || {}
		);
		return res.status(201).json({ success: true, ...code });
	} catch (err) {
		console.error("[childAuth] createCode", err.message);
		const known = /not found|Invalid|family/i.test(err.message || "");
		return res
			.status(known ? 400 : 500)
			.json({ success: false, message: err.message || "Failed to create code" });
	}
}

/** Parent-authenticated: list a child's codes. */
async function listCodes(req, res) {
	try {
		const codes = await childAuthService.listLoginCodes(
			req.user.googleId,
			req.params.childUuid
		);
		return res.json(codes);
	} catch (err) {
		console.error("[childAuth] listCodes", err.message);
		return res
			.status(400)
			.json({ success: false, message: err.message || "Failed to list codes" });
	}
}

/** Parent-authenticated: revoke a code. */
async function revokeCode(req, res) {
	try {
		const result = await childAuthService.revokeLoginCode(
			req.user.googleId,
			req.params.childUuid,
			req.params.codeUuid
		);
		return res.json(result);
	} catch (err) {
		console.error("[childAuth] revokeCode", err.message);
		const known = /not found/i.test(err.message || "");
		return res
			.status(known ? 404 : 500)
			.json({ success: false, message: err.message || "Failed to revoke code" });
	}
}

/**
 * PUBLIC: validate a login code. Called by the proxy when minting a child
 * session JWT (the proxy captures the real client IP and signs the token).
 * Returns the child identity, or 401 if the code is invalid.
 */
async function validateCode(req, res) {
	try {
		const code = req.body?.code || req.query?.code;
		const identity = await childAuthService.validateCode(code);
		return res.json({ success: true, child: identity });
	} catch (err) {
		console.warn("[childAuth] validateCode rejected:", err.message);
		return res.status(401).json({
			success: false,
			message: err.message || "Invalid login code",
		});
	}
}

module.exports = { createCode, listCodes, revokeCode, validateCode };
