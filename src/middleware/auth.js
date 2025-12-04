const jwt = require("jsonwebtoken");
const config = require("../config");

function extractToken(req) {
	const authHeader =
		req.headers["x-user-authorization"] || req.headers.authorization || "";

	if (!authHeader.startsWith("Bearer ")) {
		return null;
	}

	return authHeader.slice("Bearer ".length);
}

function verifyToken(token) {
	if (!token) return null;
	try {
		return jwt.verify(token, config.JWT_SECRET);
	} catch (err) {
		console.warn("Auth middleware: Failed to verify JWT", err.message);
		return null;
	}
}

function requireAuth(req, res, next) {
	const token = extractToken(req);
	const decoded = verifyToken(token);

	if (!decoded) {
		return res
			.status(401)
			.json({ success: false, message: "Unauthorized" });
	}

	const googleId =
		decoded.googleId || decoded.google_id || decoded.sub || null;

	if (!googleId) {
		return res
			.status(401)
			.json({ success: false, message: "Unauthorized" });
	}

	req.user = {
		googleId,
		tokenPayload: decoded,
	};

	return next();
}

module.exports = {
	requireAuth,
};
