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
				if (publicPaths.has(req.path)) return next();
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
