const oauth = require("./oauth");
const { getProvider } = require("./registry");

/**
 * Authenticated HTTP to a linked provider's API.
 *
 * Every Phase 4 connector goes through here so token resolution, refresh,
 * timeouts, and the "the user must reconnect" signal are handled once.
 *
 * Two failure modes callers care about, both typed so a context builder can
 * skip a provider without special-casing strings:
 *   not_connected  — nothing linked, or the link needs re-authorization
 *   provider_error — the provider answered, but not usefully
 */

const REQUEST_TIMEOUT_MS = 12000;

function httpError(message, status, code) {
	return Object.assign(new Error(message), { status, code });
}

/**
 * Join a provider's apiBase with a root-relative path.
 *
 * Concatenated rather than resolved with `new URL(path, base)`, because that
 * form discards a path prefix on the base — Whoop's base ends in /developer,
 * and "/v2/recovery" would silently resolve to the host root.
 */
function buildUrl(base, path, query) {
	if (typeof path !== "string" || !path.startsWith("/")) {
		throw httpError("Path must be root-relative", 400, "bad_path");
	}
	if (path.includes("://") || path.includes("..")) {
		throw httpError("Path must not contain a host or traversal", 400, "bad_path");
	}
	const url = new URL(`${base.replace(/\/$/, "")}${path}`);
	for (const [key, value] of Object.entries(query || {})) {
		if (value === undefined || value === null || value === "") continue;
		url.searchParams.set(key, String(value));
	}
	return url.toString();
}

/**
 * Reasons a provider answers 403 that have nothing to do with the grant.
 *
 * Google Calendar says 403 for a rate limit, for quota, and for a single
 * calendar the account can see but not read in detail — a subscribed
 * holiday calendar, or one shared at free/busy access. None of those mean
 * the user revoked anything, and treating them as revocation tore down a
 * healthy link and sent the user back through consent, over and over.
 *
 * A 403 we cannot explain is still treated as the grant being gone, because
 * that is what an unexplained 403 usually is, and the flag is now
 * recoverable: the next refresh puts a wrongly-flagged link back to active.
 */
const NON_AUTH_403_REASONS = new Set([
	"ratelimitexceeded",
	"userratelimitexceeded",
	"dailylimitexceeded",
	"quotaexceeded",
	// Google's domain for every quota and rate-limit refusal.
	"usagelimits",
	"resource_exhausted",
	"backenderror",
	"forbiddenfornonorganizer",
	"notacalendaruser",
	"requiredaccesslevel",
]);

/** Every reason-ish string a provider's error body offers, lowercased. */
function errorReasons(data) {
	const error = (data && data.error) || {};
	const list = Array.isArray(error.errors) ? error.errors : [];
	return [
		...list.map((e) => e && e.reason),
		...list.map((e) => e && e.domain),
		error.status,
		typeof data?.error === "string" ? data.error : null,
	]
		.filter((v) => typeof v === "string")
		.map((v) => v.toLowerCase());
}

/**
 * The most specific thing the provider said about this failure.
 *
 * Google nests its message under `error`, so the flat read alone logged
 * [object Object] for exactly the errors worth reading.
 */
function providerDetail(data, status) {
	const error = data && data.error;
	return String(
		(data && data.error_description) ||
			(data && data.message) ||
			(error && typeof error === "object" ? error.message || error.status : error) ||
			`HTTP ${status}`
	);
}

/** True when this response says the user's grant is gone, not that this
 *  particular request was refused. */
function grantIsGone(status, data) {
	if (status === 401) return true;
	if (status !== 403) return false;
	return !errorReasons(data).some((r) => NON_AUTH_403_REASONS.has(r));
}

/**
 * One authenticated request against a provider's API.
 *
 * @param {number} profileId   whose credential to use
 * @param {string} providerId  registry id
 * @param {string} path        root-relative path, e.g. "/v2/recovery"
 * @param {boolean} [opts.invalidateOnAuthFailure=true]  whether a 401/403 may
 *        flag the whole link. False for reads that fan out over many
 *        sub-resources, where one of them failing says nothing about the link.
 * @returns {Promise<any>} parsed JSON body
 */
async function providerRequest(
	profileId,
	providerId,
	path,
	{ method = "GET", query, body, actor = "athena", invalidateOnAuthFailure = true } = {}
) {
	const provider = getProvider(providerId);
	let token;
	try {
		token = await oauth.accessToken(profileId, providerId, { actor });
	} catch (err) {
		// A credential we hold but cannot open. Reported as not_connected so
		// every caller's existing "skip this provider" path keeps working, but
		// tagged with `reason` so the grounding layer can say what actually
		// happened instead of telling the user to reconnect a healthy link.
		if (err && err.code === "credential_unreadable") {
			throw Object.assign(
				httpError(
					`${provider.label} credential cannot be read on this server`,
					409,
					"not_connected"
				),
				{ reason: "unreadable" }
			);
		}
		throw err;
	}
	if (!token) {
		throw Object.assign(
			httpError(`${provider.label} is not connected`, 409, "not_connected"),
			{ reason: "absent" }
		);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	let response;
	try {
		response = await fetch(buildUrl(provider.apiBase, path, query), {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
	} catch (err) {
		throw Object.assign(
			httpError(
				`${provider.label} request failed: ${err.message}`,
				504,
				"provider_error"
			),
			{ providerDetail: err.message }
		);
	} finally {
		clearTimeout(timer);
	}

	const text = await response.text();
	let data;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = null;
	}

	// The body is parsed first because a 403 only means something once you
	// have read why the provider said it.
	if (grantIsGone(response.status, data)) {
		// The token was live as far as we knew, so the grant was revoked at the
		// provider. Flag it rather than retrying into the same wall.
		if (invalidateOnAuthFailure) {
			await oauth.invalidate(
				profileId,
				providerId,
				`provider returned ${response.status}`
			);
		}
		throw Object.assign(
			httpError(
				`${provider.label} access was revoked; reconnect required`,
				409,
				"not_connected"
			),
			{
				reason: "revoked",
				providerStatus: response.status,
				providerDetail: providerDetail(data, response.status),
			}
		);
	}

	if (!response.ok) {
		const detail = providerDetail(data, response.status);
		throw Object.assign(
			httpError(
				`${provider.label}: ${String(detail).slice(0, 200)}`,
				502,
				"provider_error"
			),
			// The provider's OWN status and wording, kept as fields rather than
			// only baked into our message, so the grounding layer can quote
			// them without unpicking a string we composed. Nothing reads these
			// without sanitizing first — see connectors/context.js.
			{ providerStatus: response.status, providerDetail: detail }
		);
	}
	return data;
}

const providerGet = (profileId, providerId, path, opts = {}) =>
	providerRequest(profileId, providerId, path, { ...opts, method: "GET" });

/** True for the "nothing usable is linked" case, which callers skip quietly. */
const isNotConnected = (err) => err && err.code === "not_connected";

module.exports = { providerRequest, providerGet, isNotConnected, buildUrl };
