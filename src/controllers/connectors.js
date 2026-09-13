const oauth = require("../services/connectors/oauth");
const { isProvider } = require("../services/connectors/registry");
const { resolveActingProfile } = require("../services/integration");

/**
 * HTTP surface for outbound OAuth connectors.
 *
 * Every route except the callback runs behind requireAuth and acts only on
 * the caller's own profile — a provider is never addressed by profile id from
 * the request. The callback is public by necessity (see connectors/oauth.js)
 * and authenticates on the single-use state alone.
 */

function sendError(res, err, fallback = "Integration request failed") {
	const status = Number.isInteger(err?.status) ? err.status : 500;
	if (status >= 500) console.error("[connectors]", err);
	return res.status(status).json({
		success: false,
		message: err?.message || fallback,
		...(err?.code ? { code: err.code } : {}),
	});
}

/** 404 before anything else touches an unknown provider name. */
function requireKnownProvider(req, res, next) {
	if (!isProvider(req.params.provider)) {
		return res
			.status(404)
			.json({ success: false, message: `Unknown integration provider` });
	}
	return next();
}

/** GET /integrations — every supported provider plus this user's link state. */
async function listConnectors(req, res) {
	try {
		const actor = await actingUser(req);
		return res.json({ success: true, providers: await oauth.statusAll(actor) });
	} catch (err) {
		return sendError(res, err, "Failed to load integrations");
	}
}

/** GET /integrations/:provider — one provider's link state. */
async function getConnector(req, res) {
	try {
		const actor = await actingUser(req);
		return res.json({
			success: true,
			...(await oauth.status(actor, req.params.provider)),
		});
	} catch (err) {
		return sendError(res, err, "Failed to load integration status");
	}
}

/**
 * POST /integrations/:provider/connect
 *
 * Returns the authorize URL rather than redirecting: the caller is an XHR
 * carrying an IP-pinned JWT, and a 302 from XHR would be followed by fetch
 * without ever reaching the user's address bar. The SPA navigates itself.
 */
async function startConnect(req, res) {
	try {
		const actor = await actingUser(req);
		const result = await oauth.begin(actor, req.params.provider, {
			redirectTo: req.body?.redirect_to,
		});
		return res.json({ success: true, ...result });
	} catch (err) {
		return sendError(res, err, "Failed to start authorization");
	}
}

/**
 * GET /integrations/:provider/callback  — PUBLIC.
 *
 * The provider redirects a browser here with no Athena session. Identity
 * comes from the single-use state alone. Ends in a redirect back to the app
 * when an allowlisted return target is configured, or JSON in local dev.
 */
async function handleCallback(req, res) {
	const provider = req.params.provider;
	try {
		const result = await oauth.complete(provider, {
			code: req.query.code,
			state: req.query.state,
			error: req.query.error,
			errorDescription: req.query.error_description,
		});
		if (result.redirectTo) {
			return res.redirect(
				302,
				appendParams(result.redirectTo, { integration: provider, status: "connected" })
			);
		}
		return res.json({
			success: true,
			provider,
			connected: true,
			link: result.credential,
		});
	} catch (err) {
		// A failed callback is a browser navigation, not an API call: send the
		// user back to the app with a reason rather than a JSON error page.
		const status = Number.isInteger(err?.status) ? err.status : 500;
		if (status >= 500) console.error("[connectors] callback", err);
		if (err?.redirectTo) {
			return res.redirect(
				302,
				appendParams(err.redirectTo, {
					integration: provider,
					status: "error",
					reason: err.code || "failed",
				})
			);
		}
		return sendError(res, err, "Authorization failed");
	}
}

/** DELETE /integrations/:provider — revoke upstream where possible, then clear. */
async function disconnectConnector(req, res) {
	try {
		const actor = await actingUser(req);
		const result = await oauth.disconnect(actor, req.params.provider);
		return res.json({ success: true, ...result });
	} catch (err) {
		return sendError(res, err, "Failed to disconnect");
	}
}

/** Resolve req.user to { profileId, googleId } — the shape oauth.js expects. */
async function actingUser(req) {
	const { profileId } = await resolveActingProfile(req.user);
	return { profileId, googleId: req.user?.googleId || null };
}

function appendParams(url, params) {
	const separator = url.includes("?") ? "&" : "?";
	return `${url}${separator}${new URLSearchParams(params).toString()}`;
}

module.exports = {
	requireKnownProvider,
	listConnectors,
	getConnector,
	startConnect,
	handleCallback,
	disconnectConnector,
};
