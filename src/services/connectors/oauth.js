const crypto = require("crypto");
const pool = require("../../helpers/db");
const config = require("../../config");
const secrets = require("../secrets");
const credentials = require("../credentials");
const consent = require("../consent");
const { getProvider, describe, PROVIDER_IDS } = require("./registry");

/**
 * Generic OAuth 2.0 authorization-code flow for outbound integrations.
 *
 * Three entry points:
 *   begin()     authenticated — returns the URL to send the browser to
 *   complete()  PUBLIC callback — proves the flow was one we started, then
 *               exchanges the code and stores the credential
 *   accessToken() what every Phase 4 connector calls; refreshes on use
 *
 * The callback is public by necessity: the provider redirects a browser that
 * carries no Athena JWT. `state` is therefore the credential that carries
 * identity across the round trip, so it is random, hashed at rest,
 * single-use, and expires in minutes (table oauth_state, migration 0025).
 */

const STATE_TTL_MINUTES = 10;
const TOKEN_REQUEST_TIMEOUT_MS = 15000;

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function httpError(message, status, code) {
	return Object.assign(new Error(message), { status, code });
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Where the provider sends the browser back. Must match the app registration. */
function redirectUri(providerId) {
	const base = config.PUBLIC_API_BASE_URL;
	if (!base) {
		throw httpError(
			"PUBLIC_API_BASE_URL is not configured; cannot build an OAuth redirect URI",
			500
		);
	}
	return `${base.replace(/\/$/, "")}/integrations/${providerId}/callback`;
}

/**
 * Validate where the browser should land after the callback. An unchecked
 * value here would make the callback an open redirect, so anything not on
 * the allowlist falls back to the first allowed origin.
 */
function resolveReturnTarget(requested) {
	const allowed = config.INTEGRATION_REDIRECT_ALLOWLIST;
	if (!allowed.length) return null; // local dev: respond with JSON instead
	if (typeof requested === "string" && requested) {
		const ok = allowed.some(
			(origin) => requested === origin || requested.startsWith(`${origin}/`)
		);
		if (ok) return requested.slice(0, 255);
	}
	return allowed[0];
}

async function clientCredentials(provider) {
	const [clientId, clientSecret] = await Promise.all([
		secrets.getSecret(provider.clientIdSecret),
		secrets.getSecret(provider.clientSecretSecret),
	]);
	if (!clientId || !clientSecret) {
		throw httpError(
			`${provider.label} is not configured on this server (missing ${provider.clientIdSecret} / ${provider.clientSecretSecret})`,
			503
		);
	}
	return { clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function pkcePair() {
	const verifier = crypto.randomBytes(48).toString("base64url"); // 64 chars
	const challenge = crypto
		.createHash("sha256")
		.update(verifier)
		.digest("base64url");
	return { verifier, challenge };
}

async function issueState(profileId, providerId, { codeVerifier, redirectTo }) {
	const state = crypto.randomBytes(32).toString("base64url");
	await pool.query(
		`INSERT INTO oauth_state
			(state_hash, profile_id, provider, code_verifier, redirect_to, expires_at)
		 VALUES (?, ?, ?, ?, ?, NOW() + INTERVAL ${STATE_TTL_MINUTES} MINUTE)`,
		[sha256(state), profileId, providerId, codeVerifier || null, redirectTo || null]
	);
	return state;
}

/**
 * Consume a state exactly once. The UPDATE is the guard: two callbacks racing
 * the same state means only one gets affectedRows === 1.
 */
async function consumeState(state, providerId) {
	if (typeof state !== "string" || !state) {
		throw httpError("Missing OAuth state", 400, "state_missing");
	}
	const hash = sha256(state);
	const [result] = await pool.query(
		`UPDATE oauth_state SET consumed_at = NOW()
		 WHERE state_hash = ? AND provider = ? AND consumed_at IS NULL AND expires_at > NOW()`,
		[hash, providerId]
	);
	if (result.affectedRows !== 1) {
		throw httpError("OAuth state is invalid, expired, or already used", 400, "state_invalid");
	}
	const [rows] = await pool.query(
		`SELECT profile_id, code_verifier, redirect_to FROM oauth_state WHERE state_hash = ? LIMIT 1`,
		[hash]
	);
	return rows[0];
}

/** Housekeeping: drop states that can no longer be used. */
async function purgeExpiredStates() {
	const [result] = await pool.query(
		`DELETE FROM oauth_state WHERE expires_at < NOW() - INTERVAL 1 DAY`
	);
	return result.affectedRows;
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

async function postForm(url, params, { headers = {} } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
				...headers,
			},
			body: new URLSearchParams(params).toString(),
			signal: controller.signal,
		});
		const text = await response.text();
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			body = { raw: text };
		}
		return { ok: response.ok, status: response.status, body };
	} finally {
		clearTimeout(timer);
	}
}

function tokenRequestParams(provider, clientId, clientSecret, extra) {
	const params = { ...extra };
	if (provider.tokenAuth === "basic") return { params, headers: basicAuth(clientId, clientSecret) };
	params.client_id = clientId;
	params.client_secret = clientSecret;
	return { params, headers: {} };
}

function basicAuth(clientId, clientSecret) {
	const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
	return { Authorization: `Basic ${encoded}` };
}

/**
 * Normalize the many shapes of a token response into what credentials.put()
 * wants. Strava reports absolute `expires_at` (epoch seconds); most report
 * relative `expires_in`.
 */
function normalizeTokens(body) {
	const expiresAt =
		Number.isFinite(Number(body.expires_at)) && Number(body.expires_at) > 0
			? new Date(Number(body.expires_at) * 1000)
			: null;
	return {
		accessToken: body.access_token,
		refreshToken: body.refresh_token || null,
		tokenType: body.token_type || null,
		scopes: typeof body.scope === "string" ? body.scope.split(/[\s,]+/).filter(Boolean) : null,
		expiresAt,
		expiresIn: expiresAt ? null : body.expires_in,
	};
}

function tokenErrorMessage(body, fallback) {
	if (!body || typeof body !== "object") return fallback;
	if (body.error_description) return String(body.error_description).slice(0, 200);
	if (typeof body.error === "string") return body.error.slice(0, 200);
	if (body.message) return String(body.message).slice(0, 200);
	return fallback;
}

// ---------------------------------------------------------------------------
// begin
// ---------------------------------------------------------------------------

/**
 * Start an authorization flow.
 *
 * @param {{profileId:number, googleId?:string}} actor  resolved, authenticated
 * @returns {Promise<{authorize_url:string, provider:string, expires_in:number}>}
 */
async function begin(actor, providerId, { redirectTo } = {}) {
	const provider = getProvider(providerId);
	if (!actor || !actor.profileId) throw httpError("Authentication required", 401);

	// Consent gate. Health data is exactly the kind of thing the mission says
	// must be consented to, not merely possible.
	if (provider.consentType) {
		const granted = await consent.hasConsent(actor.googleId, provider.consentType);
		if (!granted) {
			throw httpError(
				`Connecting ${provider.label} requires the ${provider.consentType} consent first`,
				412,
				"consent_required"
			);
		}
	}

	const { clientId } = await clientCredentials(provider);
	const pkce = provider.pkce ? pkcePair() : null;
	const target = resolveReturnTarget(redirectTo);
	const state = await issueState(actor.profileId, provider.id, {
		codeVerifier: pkce ? pkce.verifier : null,
		redirectTo: target,
	});

	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri(provider.id),
		response_type: "code",
		scope: provider.scopes.join(provider.scopeSeparator),
		state,
		...provider.authorizeParams,
	});
	if (pkce) {
		params.set("code_challenge", pkce.challenge);
		params.set("code_challenge_method", "S256");
	}

	return {
		provider: provider.id,
		authorize_url: `${provider.authorizeUrl}?${params.toString()}`,
		expires_in: STATE_TTL_MINUTES * 60,
	};
}

// ---------------------------------------------------------------------------
// complete (the public callback)
// ---------------------------------------------------------------------------

/**
 * Finish an authorization flow. Called from the PUBLIC callback route, so it
 * trusts nothing but the state it can match in the database.
 *
 * @returns {Promise<{provider:string, credential:object, redirectTo:string|null}>}
 */
async function complete(providerId, { code, state, error, errorDescription }) {
	const provider = getProvider(providerId);

	// The user declined, or the provider refused. Burn the state anyway so it
	// cannot be reused, then report it.
	if (error) {
		const record = await consumeState(state, provider.id).catch(() => null);
		throw Object.assign(
			httpError(errorDescription || `Authorization was declined (${error})`, 400, error),
			{ redirectTo: record ? record.redirect_to : null }
		);
	}
	if (typeof code !== "string" || !code) {
		throw httpError("Missing authorization code", 400, "code_missing");
	}

	const record = await consumeState(state, provider.id);
	const redirectTo = record.redirect_to || null;

	try {
		const { clientId, clientSecret } = await clientCredentials(provider);
		const { params, headers } = tokenRequestParams(provider, clientId, clientSecret, {
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri(provider.id),
			...(record.code_verifier ? { code_verifier: record.code_verifier } : {}),
		});

		const { ok, body } = await postForm(provider.tokenUrl, params, { headers });
		if (!ok || !body.access_token) {
			throw httpError(
				tokenErrorMessage(body, `${provider.label} rejected the authorization`),
				502,
				"token_exchange_failed"
			);
		}

		const tokens = normalizeTokens(body);
		let identity = provider.identify ? provider.identify(body) : null;
		// Providers whose token response carries no account info need an
		// authenticated call to identify it. Best-effort: failing to learn the
		// account id must not throw away a grant the user just approved.
		if (!identity && provider.identifyAsync) {
			identity = await provider
				.identifyAsync(body, {
					accessToken: tokens.accessToken,
					apiBase: provider.apiBase,
				})
				.catch((err) => {
					console.warn(
						`[connectors] ${provider.label} identity lookup failed:`,
						err.message
					);
					return null;
				});
		}

		const credential = await credentials.put({
			profileId: record.profile_id,
			provider: provider.id,
			kind: "oauth2",
			externalAccountId: identity ? identity.externalAccountId : null,
			displayName: identity ? identity.displayName : provider.label,
			actor: "oauth-callback",
			...tokens,
		});

		return { provider: provider.id, credential, redirectTo };
	} catch (err) {
		// Carry the return target so the route can still send the browser home
		// with an error rather than rendering a bare 500.
		err.redirectTo = redirectTo;
		throw err;
	}
}

// ---------------------------------------------------------------------------
// accessToken (refresh on use)
// ---------------------------------------------------------------------------

/**
 * Two requests noticing the same expiry would both refresh; with a provider
 * that rotates refresh tokens (Strava, Whoop) the slower one then writes a
 * token the provider has already invalidated. Collapsing them per process
 * removes that within an instance. Across instances the compare-and-set in
 * credentials still leaves the link usable, but this is the cheap 90%.
 */
const refreshInFlight = new Map();

/**
 * A link flagged `needs_reauth` is retried rather than written off: the flag
 * is raised on evidence that is often wrong — a rate-limited 403, one shared
 * calendar the account cannot read — and a refresh token usually outlives it.
 * A successful refresh puts the row back to 'active' on its own.
 *
 * The cooldown is what keeps that from costing anything when the grant really
 * is dead. Process-local on purpose: a fresh instance retrying once is
 * harmless, and a column for it would be a migration to hold a hint.
 *
 * credential uuid -> epochMs of the last refusal.
 */
const reauthBackoff = new Map();
const REAUTH_RETRY_COOLDOWN_MS = 15 * 60 * 1000;
const REAUTH_BACKOFF_MAX = 500;

function backoffReauth(uuid) {
	if (reauthBackoff.size >= REAUTH_BACKOFF_MAX) {
		reauthBackoff.delete(reauthBackoff.keys().next().value);
	}
	reauthBackoff.set(uuid, Date.now());
}

/** True when a credential already flagged needs_reauth is due another try. */
function reauthRetryDue(uuid) {
	const last = reauthBackoff.get(uuid);
	return !last || Date.now() - last >= REAUTH_RETRY_COOLDOWN_MS;
}

async function refresh(provider, credential) {
	const key = credential.uuid;
	if (refreshInFlight.has(key)) return refreshInFlight.get(key);

	const promise = (async () => {
		const { clientId, clientSecret } = await clientCredentials(provider);
		const { params, headers } = tokenRequestParams(provider, clientId, clientSecret, {
			grant_type: "refresh_token",
			refresh_token: credential.refreshToken,
		});

		const { ok, status, body } = await postForm(provider.tokenUrl, params, { headers });
		if (!ok || !body.access_token) {
			// 400/401 from a token endpoint means the grant is dead (revoked at
			// the provider, or expired). Anything else may be transient, so
			// don't tear down a working link over a 502.
			if (status === 400 || status === 401) {
				await credentials.markNeedsReauth(credential.uuid, {
					actor: "connector",
					detail: tokenErrorMessage(body, "refresh rejected"),
				});
				backoffReauth(credential.uuid);
				return null;
			}
			throw httpError(
				tokenErrorMessage(body, `${provider.label} refresh failed`),
				502,
				"refresh_failed"
			);
		}

		const tokens = normalizeTokens(body);
		// Providers that rotate must have the new refresh token persisted, or
		// the link dies at the next expiry.
		await credentials.updateTokens(credential.uuid, { ...tokens, actor: "refresh" });
		// updateTokens puts the row back to 'active', so a link flagged over
		// something transient is simply working again.
		reauthBackoff.delete(credential.uuid);
		return tokens.accessToken;
	})().finally(() => refreshInFlight.delete(key));

	refreshInFlight.set(key, promise);
	return promise;
}

/**
 * The function every Phase 4 connector calls. Returns a usable access token,
 * refreshing transparently, or null when the user must reconnect.
 *
 * @returns {Promise<string|null>}
 */
async function accessToken(profileId, providerId, { actor = "athena" } = {}) {
	const provider = getProvider(providerId);
	const credential = await credentials.get(profileId, provider.id, { actor });
	if (!credential) return null;
	if (!credential.expired) return credential.accessToken;

	if (!credential.refreshToken) {
		await credentials.markNeedsReauth(credential.uuid, {
			actor,
			detail: "access token expired and no refresh token is stored",
		});
		return null;
	}
	// Already flagged as needing a reconnect: still worth another attempt,
	// because the flag is raised on evidence that is often wrong — but not on
	// every message, because if the grant really is dead each attempt is a
	// round trip that can only fail.
	if (
		credential.status &&
		credential.status === credentials.STATUS_NEEDS_REAUTH &&
		!reauthRetryDue(credential.uuid)
	) {
		return null;
	}
	return refresh(provider, credential);
}

// ---------------------------------------------------------------------------
// status / disconnect
// ---------------------------------------------------------------------------

/**
 * Mark a link unusable because the provider rejected a token we believed was
 * live — i.e. the user revoked access upstream. Called by the HTTP layer on a
 * 401/403 so the next request fails fast and the UI can say "reconnect".
 */
async function invalidate(profileId, providerId, detail) {
	const provider = getProvider(providerId);
	const linked = await credentials.status(profileId, provider.id);
	if (!linked) return false;
	await credentials.markNeedsReauth(linked.uuid, { actor: "connector", detail });
	return true;
}

/** Everything the UI needs to render one provider's card. */
async function status(actor, providerId) {
	const provider = getProvider(providerId);
	const linked = await credentials.status(actor.profileId, provider.id);
	return { ...describe(provider.id), connected: !!linked, link: linked };
}

/** Every provider this build supports, with the acting user's link state. */
async function statusAll(actor) {
	return Promise.all(PROVIDER_IDS.map((id) => status(actor, id)));
}

/**
 * Disconnect: tell the provider to drop the grant where it supports that,
 * then clear our side regardless. Revocation upstream is best-effort — a
 * provider being down must not leave a credential we refuse to delete.
 */
async function disconnect(actor, providerId, { actorLabel = "user" } = {}) {
	const provider = getProvider(providerId);
	let revokedUpstream = false;

	if (provider.revokeUrl) {
		// A credential we cannot decrypt must not block disconnecting: clearing
		// our side is the part the user actually asked for, and refusing to
		// release a link because its token is unreadable is the worst answer.
		const credential = await credentials
			.get(actor.profileId, provider.id, { actor: "disconnect" })
			.catch((err) => {
				console.warn(
					`[connectors] ${provider.label} credential unreadable; ` +
						`skipping upstream revocation:`,
					err.message
				);
				return null;
			});
		if (credential && credential.accessToken) {
			try {
				const { ok } = await postForm(
					provider.revokeUrl,
					provider.revokeBody(credential.accessToken)
				);
				revokedUpstream = ok;
			} catch (err) {
				console.warn(
					`[connectors] ${provider.label} revocation failed (clearing locally anyway):`,
					err.message
				);
			}
		}
	}

	const result = await credentials.revoke(actor.profileId, provider.id, {
		actor: actorLabel,
	});
	return { ...result, revoked_upstream: revokedUpstream };
}

module.exports = {
	begin,
	complete,
	accessToken,
	invalidate,
	status,
	statusAll,
	disconnect,
	purgeExpiredStates,
	redirectUri,
	REAUTH_RETRY_COOLDOWN_MS,
	clearReauthBackoff: () => reauthBackoff.clear(),
	resolveReturnTarget,
	normalizeTokens,
	STATE_TTL_MINUTES,
};
