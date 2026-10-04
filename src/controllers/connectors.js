const oauth = require("../services/connectors/oauth");
const { isProvider, isGroup, GROUPS } = require("../services/connectors/registry");

/** The group whose flow returns through this provider's callback, if any. */
const groupCarriedBy = (providerId) =>
	Object.values(GROUPS).find((g) => g.callbackVia === providerId)?.id || null;
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
	if (!isProvider(req.params.provider) && !isGroup(req.params.provider)) {
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
	if (isGroup(req.params.provider)) {
		return res.status(404).json({ success: false, message: "Ask for a group's members individually" });
	}
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
		const provider = req.params.provider;
		const result = isGroup(provider)
			? await oauth.beginGroup(actor, provider, {
					redirectTo: req.body?.redirect_to,
					// Only ever the caller's own verified address: a hint for some
					// other account would just be a confusing chooser.
					loginHint: req.user?.tokenPayload?.email_verified === true ? req.user.tokenPayload.email : null,
				})
			: await oauth.begin(actor, provider, { redirectTo: req.body?.redirect_to });
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
/**
 * Finish a flow for `provider` (a provider or a group id). Returns where the
 * browser goes next — `redirect`, the allowlisted return target with the
 * outcome appended — or, with no return target (local dev), a JSON `body`.
 * Errors that know their return target come back as a redirect too: a failed
 * callback is a browser navigation, not an API call.
 */
async function finishCallback(provider, callback) {
	try {
		if (isGroup(provider)) {
			const result = await oauth.completeGroup(provider, callback);
			const outcome = {
				integration: provider,
				status: result.linked.length ? "connected" : "error",
				...(result.linked.length ? {} : { reason: "nothing_granted" }),
				linked: result.linked.join(","),
				kept: result.kept.join(","),
				declined: result.declined.join(","),
			};
			if (result.redirectTo) return { redirect: appendParams(result.redirectTo, outcome) };
			return { body: { success: true, ...outcome } };
		}
		const result = await oauth.complete(provider, callback);
		if (result.redirectTo) {
			return { redirect: appendParams(result.redirectTo, { integration: provider, status: "connected" }) };
		}
		return { body: { success: true, provider, connected: true, link: result.credential } };
	} catch (err) {
		const status = Number.isInteger(err?.status) ? err.status : 500;
		if (status >= 500) console.error("[connectors] callback", err);
		if (err?.redirectTo) {
			return {
				redirect: appendParams(err.redirectTo, {
					integration: provider,
					status: "error",
					reason: err.code || "failed",
				}),
			};
		}
		throw err;
	}
}

const callbackFrom = (source) => ({
	code: source.code,
	state: source.state,
	error: source.error,
	errorDescription: source.error_description,
});

/** GET /integrations/:provider/callback — the provider redirects a browser here. */
async function handleCallback(req, res) {
	let provider = req.params.provider;
	try {
		const callback = callbackFrom(req.query);
		// A group returns through a member's registered callback (see
		// `callbackVia` in the registry). The state says which flow it was;
		// completeGroup still consumes it scoped to the group.
		const carried = groupCarriedBy(provider);
		if (carried && (await oauth.stateProvider(callback.state)) === carried) provider = carried;
		const done = await finishCallback(provider, callback);
		if (done.redirect) return res.redirect(302, done.redirect);
		return res.json(done.body);
	} catch (err) {
		return sendError(res, err, "Authorization failed");
	}
}

/**
 * POST /integrations/callback — the shared Google callback. Google sends the
 * browser to one page on the companion app (config.OAUTH_GOOGLE_CALLBACK_URL)
 * for every Google flow; that page posts the query here and navigates to the
 * `redirect` it gets back.
 *
 * Public for the same reason the GET callback is: identity comes only from the
 * single-use state. The state also names the flow, and only Google's flows may
 * finish here — any other provider's state is refused (and left unconsumed),
 * so this route can never complete a flow its redirect URI didn't start.
 */
async function completeCallback(req, res) {
	res.set("Cache-Control", "no-store");
	try {
		const callback = callbackFrom(req.body || {});
		const provider = await oauth.stateProvider(callback.state);
		if (!provider || !oauth.usesGoogleCallback(provider)) {
			return res.status(400).json({
				success: false,
				code: "state_invalid",
				message: "That sign-in link has expired or was already used. Start again from Connected apps.",
			});
		}
		const done = await finishCallback(provider, callback);
		return res.json(done.redirect ? { success: true, redirect: done.redirect } : done.body);
	} catch (err) {
		return sendError(res, err, "Authorization failed");
	}
}

/** DELETE /integrations/:provider — revoke upstream where possible, then clear. */
async function disconnectConnector(req, res) {
	try {
		const actor = await actingUser(req);
		const result = isGroup(req.params.provider)
			? await oauth.disconnectGroup(actor, req.params.provider)
			: await oauth.disconnect(actor, req.params.provider);
		// A disconnected source changes what every dashboard card can show.
		// Best effort: a socket problem must not fail the disconnect itself.
		try {
			require("../services/dashboardPriority").invalidate(actor.profileId);
			require("../websocket/wsServer").pushDashboardUpdate(actor.googleId, "connector_disconnected");
		} catch (e) {
			console.warn("[connectors] dashboard push failed:", e.message);
		}
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
	completeCallback,
	disconnectConnector,
};
