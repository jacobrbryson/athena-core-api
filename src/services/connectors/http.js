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
 * One authenticated request against a provider's API.
 *
 * @param {number} profileId   whose credential to use
 * @param {string} providerId  registry id
 * @param {string} path        root-relative path, e.g. "/v2/recovery"
 * @returns {Promise<any>} parsed JSON body
 */
async function providerRequest(
	profileId,
	providerId,
	path,
	{ method = "GET", query, body, actor = "athena" } = {}
) {
	const provider = getProvider(providerId);
	const token = await oauth.accessToken(profileId, providerId, { actor });
	if (!token) {
		throw httpError(`${provider.label} is not connected`, 409, "not_connected");
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
		throw httpError(
			`${provider.label} request failed: ${err.message}`,
			504,
			"provider_error"
		);
	} finally {
		clearTimeout(timer);
	}

	if (response.status === 401 || response.status === 403) {
		// The token was live as far as we knew, so the grant was revoked at the
		// provider. Flag it rather than retrying into the same wall.
		await oauth.invalidate(profileId, providerId, `provider returned ${response.status}`);
		throw httpError(
			`${provider.label} access was revoked; reconnect required`,
			409,
			"not_connected"
		);
	}

	const text = await response.text();
	let data;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = null;
	}

	if (!response.ok) {
		const detail =
			(data && (data.error_description || data.message || data.error)) ||
			`HTTP ${response.status}`;
		throw httpError(
			`${provider.label}: ${String(detail).slice(0, 200)}`,
			502,
			"provider_error"
		);
	}
	return data;
}

const providerGet = (profileId, providerId, path, opts = {}) =>
	providerRequest(profileId, providerId, path, { ...opts, method: "GET" });

/** True for the "nothing usable is linked" case, which callers skip quietly. */
const isNotConnected = (err) => err && err.code === "not_connected";

module.exports = { providerRequest, providerGet, isNotConnected, buildUrl };
