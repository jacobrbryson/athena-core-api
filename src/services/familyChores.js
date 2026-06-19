const config = require("../config");

/**
 * Thin client for the Family Chores Public API (read-only, scoped).
 *
 * Spec: GET /api/v1/me, /api/v1/players,
 *       /api/v1/players/{id}/coins, /api/v1/players/{id}/chores/today.
 * All requests are Bearer-authenticated with the user's Family Chores API
 * token. Responses are small JSON documents (see the OpenAPI doc shipped
 * with this integration).
 */

const DEFAULT_TIMEOUT_MS = 8000;

function normalizeBase(baseUrl) {
	const base = (baseUrl || config.FAMILY_CHORES_API_BASE || "").trim();
	return base.replace(/\/+$/, "");
}

/**
 * Perform an authenticated GET against the Family Chores API.
 * Throws an Error tagged with `.status` on non-2xx so callers can map it.
 */
async function fcGet(path, { token, baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
	const base = normalizeBase(baseUrl);
	if (!base) throw new Error("Family Chores API base URL is not configured");
	if (!token) throw new Error("Missing Family Chores API token");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetch(`${base}${path}`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
			},
			signal: controller.signal,
		});

		const body = await resp.json().catch(() => null);
		if (!resp.ok) {
			const message =
				body?.error?.message ||
				`Family Chores API error (${resp.status})`;
			const err = new Error(message);
			err.status = resp.status;
			err.code = body?.error?.code || null;
			throw err;
		}
		return body;
	} catch (err) {
		if (err.name === "AbortError") {
			const timeoutErr = new Error("Family Chores API request timed out");
			timeoutErr.status = 504;
			throw timeoutErr;
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/** GET /api/v1/me — token owner + family context (also validates the token). */
async function getMe(opts) {
	return fcGet("/api/v1/me", opts);
}

/** GET /api/v1/players — players visible to the token owner. */
async function listPlayers(opts) {
	const data = await fcGet("/api/v1/players", opts);
	return Array.isArray(data?.players) ? data.players : [];
}

/** GET /api/v1/players/{playerId}/coins — coin balance summary. */
async function getCoins(playerId, opts) {
	return fcGet(
		`/api/v1/players/${encodeURIComponent(playerId)}/coins`,
		opts
	);
}

/** GET /api/v1/players/{playerId}/chores/today — today's chores. */
async function getChoresToday(playerId, opts) {
	const data = await fcGet(
		`/api/v1/players/${encodeURIComponent(playerId)}/chores/today`,
		opts
	);
	return Array.isArray(data?.chores) ? data.chores : [];
}

/**
 * GET /api/v1/players/{playerId}/chores — flexible chore query.
 *
 * `query` accepts { range, from, to, status, category, includeRecurring }.
 * Used to answer "what's left today?", "what will I have tomorrow?",
 * "what did I complete last week?", and category questions. Future
 * occurrences of recurring chores are projected by the API (projected: true).
 */
async function getChores(playerId, query, opts) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query || {})) {
		if (value !== undefined && value !== null && value !== "") {
			params.set(key, String(value));
		}
	}
	const suffix = params.toString() ? `?${params.toString()}` : "";
	const data = await fcGet(
		`/api/v1/players/${encodeURIComponent(playerId)}/chores${suffix}`,
		opts
	);
	return Array.isArray(data?.chores) ? data.chores : [];
}

/**
 * GET the public OpenAPI document. Public (no auth), but we send the token
 * anyway since fcGet requires one. Lets the model review what endpoints and
 * parameters exist before building its own request.
 */
async function getOpenApiSpec(opts) {
	return fcGet("/api/docs/openapi.json", opts);
}

/**
 * Generic authenticated GET against an arbitrary public-API path. Callers MUST
 * validate `path` against the documented endpoints first (see
 * familyChoresTools). `path` must be a root-relative `/api/...` path; this is
 * the escape hatch the model uses for questions the typed tools don't cover.
 */
async function apiGet(path, opts) {
	if (typeof path !== "string" || !path.startsWith("/api/")) {
		const err = new Error("Path must be a root-relative /api/ path");
		err.status = 400;
		throw err;
	}
	if (path.includes("://") || path.includes("..")) {
		const err = new Error("Path must not contain a host or traversal");
		err.status = 400;
		throw err;
	}
	return fcGet(path, opts);
}

/**
 * Resolve which player the token represents. Prefers /me's memberId, then
 * falls back to the first visible player. Returns a normalized identity
 * used when establishing the link.
 */
async function resolveIdentity(opts) {
	const me = await getMe(opts);
	let playerId = me?.memberId || me?.userId || null;

	let players = [];
	try {
		players = await listPlayers(opts);
	} catch {
		// /players may be out of scope for some tokens; /me is enough to link.
		players = [];
	}

	if (!playerId && players.length) {
		playerId = players[0].playerId || players[0].uid || null;
	}

	const matched =
		players.find((p) => String(p.playerId) === String(playerId)) ||
		players[0] ||
		null;

	return {
		externalUserId: me?.userId || null,
		externalFamilyId: me?.familyId || null,
		email: me?.email || null,
		playerId: playerId ? String(playerId) : null,
		displayName: me?.displayName || matched?.displayName || null,
		familyName: me?.familyName || null,
		role: me?.role || null,
	};
}

module.exports = {
	getMe,
	listPlayers,
	getCoins,
	getChoresToday,
	getChores,
	getOpenApiSpec,
	apiGet,
	resolveIdentity,
};
