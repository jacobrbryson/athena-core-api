const { decodeUserToken } = require("./auth");
const { extractIp } = require("../helpers/utils");
const access = require("../security/access");

async function identityFromRequest(req) {
	const deviceToken = req.headers["x-athena-device-token"];
	if (deviceToken) {
		const device = await require("../services/devices").authenticateDeviceToken(deviceToken);
		return device ? { kind: "device", ...device } : null;
	}
	const header = req.headers["x-user-authorization"] || req.headers.authorization || "";
	return decodeUserToken(header.startsWith("Bearer ") ? header.slice(7) : null, extractIp(req));
}

const publicPaths = new Set(["/modes", "/llm/manifest", "/devices/pair", "/auth/child/validate", "/auth/guardian/validate", "/auth/guardian/redeem-token"]);

// The connector OAuth callback is a provider-initiated BROWSER navigation: no
// Athena session rides on it (and the session JWT is IP-pinned, so it could not
// be trusted here anyway). Identity comes from the single-use `state` recorded
// when the flow began — see services/connectors/oauth.js. It is a pattern
// rather than a publicPaths entry only because the provider is a path
// parameter; routes/integration.js still 404s an unknown provider, and the
// state lookup is what actually authenticates the request.
const publicPatterns = [/^\/integrations\/[A-Za-z0-9_-]{1,64}\/callback$/];

function isPublicPath(req) {
	if (publicPaths.has(req.path)) return true;
	return req.method === "GET" && publicPatterns.some((re) => re.test(req.path));
}

async function accessBoundary(req, res, next) {
	res.set("Cache-Control", "no-store");
	try {
		const identity = await identityFromRequest(req);
		return access.context.run({ identity }, async () => {
			try {
				if (req.path === "/access" && ["GET", "POST"].includes(req.method)) {
					if (!identity) return res.status(401).json({ message: "Sign in required" });
					return res.json(await access.recordVisit(identity, req.method === "POST"));
				}
				if (isPublicPath(req)) return next();
				if (!identity) return res.status(401).json({ message: "Sign in required" });
				if (!(await access.allowed(identity))) return res.status(403).json({ code: "ACCESS_REQUIRED", message: "Guardian access or owner approval required" });
				return next();
			} catch (err) {
				return res.status(err.status || 503).json({ code: "ACCESS_UNAVAILABLE", message: "Access could not be verified. Please retry." });
			}
		});
	} catch {
		return res.status(503).json({ message: "Access could not be verified. Please retry." });
	}
}

module.exports = { accessBoundary, identityFromRequest };
