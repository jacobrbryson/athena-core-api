const jwt = require("jsonwebtoken");
const config = require("../config");
const { extractIp, normalizeIp } = require("../helpers/utils");

function ensureSecret() {
	if (!config.JWT_SECRET) {
		throw new Error(
			"JWT_SECRET is not configured on the API server. Refusing to process auth."
		);
	}
}

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
		ensureSecret();
		return jwt.verify(token, config.JWT_SECRET);
	} catch (err) {
		console.warn("Auth middleware: Failed to verify JWT", err.message);
		return null;
	}
}

function decodeUserToken(token, expectedIp) {
	const decoded = verifyToken(token);
	if (!decoded) return null;
	if (expectedIp) {
		const tokenIp = normalizeIp(decoded.client_ip);
		if (!tokenIp || tokenIp !== normalizeIp(expectedIp)) {
			return null;
		}
	}
	return decoded;
}

function extractForwardedClientIp(req) {
	const forwarded = req.headers["x-forwarded-for"];
	if (!forwarded) return null;

	const list = Array.isArray(forwarded)
		? forwarded
		: String(forwarded)
				.split(",")
				.map((ip) => ip.trim())
				.filter(Boolean);

	return normalizeIp(list[0] || null);
}

function requireAuth(req, res, next) {
	const token = extractToken(req);
	const decoded = verifyToken(token);

	if (!decoded) {
		return res
			.status(401)
			.json({ success: false, message: "Unauthorized" });
	}

	const tokenIp = normalizeIp(decoded.client_ip);
	const requestIp = extractIp(req);
	const forwardedClientIp = extractForwardedClientIp(req);

	const ipMatches =
		tokenIp &&
		(tokenIp === requestIp ||
			(!!forwardedClientIp && tokenIp === forwardedClientIp));

	if (!ipMatches) {
		console.warn(
			"Auth middleware: IP mismatch",
			JSON.stringify({
				tokenIp,
				requestIp,
				forwardedClientIp,
			})
		);
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
	decodeUserToken,
};
