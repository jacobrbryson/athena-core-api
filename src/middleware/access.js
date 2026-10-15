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

// The shared Google callback (owner, 2026-10-04): Google returns the browser
// to a companion page, which posts the query here. Same reason, same proof —
// the single-use state — and the controller refuses any non-Google flow.
// POST and this exact path only.
const SHARED_CALLBACK = "/integrations/callback";

// Family Chores partner calls (owner, 2026-10-15). Server-to-server: Family
// Chores' backend calls these through the proxy with the shared partner secret
// (X-Partner-Key), never with an Athena user's session, so there is no
// identity for this boundary to read — and since 2026-09-11 every one of them
// was refused here as "Sign in required" before the controller could check the
// secret. The owner chose which may pass: linking and unlinking, and the two
// chore-suggestion endpoints. remember / children / connect-child /
// disconnect-child are deliberately NOT listed and stay refused.
//
// Passing here is not authorization. The controller rejects every one of them
// unless the partner secret matches (services/integration.js
// verifyPartnerSecret, which refuses everything when the secret is unset).
const PARTNER_PATHS = new Set(["/integrations/family-chores/connect", "/integrations/family-chores/disconnect"]);

// The suggestion endpoints call Gemini, and assertModelAccess() re-checks every
// model call against a live grant. With no person behind the request they are
// charged to one owner-configured identity, FAMILY_CHORES_PARTNER_GOOGLE_ID —
// the same rule background jobs follow with ATHENA_BACKGROUND_GOOGLE_ID, but a
// separate variable so it applies to these two paths and nothing else. Unset,
// or revoked, and the model call is denied as before.
const PARTNER_MODEL_PATHS = new Set(["/integrations/family-chores/suggest-chores", "/integrations/family-chores/suggest-ghost-chores"]);

function partnerIdentity(req) {
	if (req.method !== "POST") return undefined;
	if (PARTNER_PATHS.has(req.path)) return null;
	if (PARTNER_MODEL_PATHS.has(req.path)) {
		const googleId = (process.env.FAMILY_CHORES_PARTNER_GOOGLE_ID || "").trim();
		return googleId ? { google_id: googleId } : null;
	}
	return undefined;
}

function isPublicPath(req) {
	if (publicPaths.has(req.path)) return true;
	if (req.method === "POST" && req.path === SHARED_CALLBACK) return true;
	return req.method === "GET" && publicPatterns.some((re) => re.test(req.path));
}

async function accessBoundary(req, res, next) {
	res.set("Cache-Control", "no-store");
	// Partner calls carry the proxy's service token in Authorization, which is
	// not a user token, so they skip identityFromRequest entirely: no user
	// identity is ever taken from them.
	const partner = partnerIdentity(req);
	if (partner !== undefined) return access.context.run({ identity: partner, partner: "family_chores" }, next);
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
