/**
 * OAuth connector framework: authorize-URL construction, the single-use
 * state contract, token exchange, refresh-on-use, and the consent gate.
 */
process.env.JWT_SECRET = "test-jwt-secret";
process.env.PUBLIC_API_BASE_URL = "https://api.athena.test/api/v1";
process.env.INTEGRATION_REDIRECT_ALLOWLIST =
	"https://app.athena.test,https://guardians.athena.test";
process.env.STRAVA_CLIENT_ID = "strava-client";
process.env.STRAVA_CLIENT_SECRET = "strava-secret";
process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "google-secret";

const mockQuery = jest.fn();
jest.mock("../../helpers/db", () => ({ query: mockQuery }));

const mockCredentials = {
	put: jest.fn(),
	get: jest.fn(),
	status: jest.fn(),
	revoke: jest.fn(),
	updateTokens: jest.fn(),
	markNeedsReauth: jest.fn(),
};
jest.mock("../credentials", () => mockCredentials);

const mockHasConsent = jest.fn();
jest.mock("../consent", () => ({ hasConsent: mockHasConsent }));

const oauth = require("./oauth");

const ACTOR = { profileId: 42, googleId: "google-42" };

/** Capture inserted state rows and serve them back on the SELECT. */
let stateRows = [];
let consumeAffected = 1;

function wireDb() {
	mockQuery.mockImplementation(async (sql, params) => {
		if (/INSERT INTO oauth_state/.test(sql)) {
			stateRows.push({
				state_hash: params[0],
				profile_id: params[1],
				provider: params[2],
				code_verifier: params[3],
				redirect_to: params[4],
			});
			return [{ affectedRows: 1 }, []];
		}
		if (/UPDATE oauth_state/.test(sql)) {
			return [{ affectedRows: consumeAffected }, []];
		}
		if (/SELECT .*FROM oauth_state/s.test(sql)) {
			const found = stateRows.find((r) => r.state_hash === params[0]);
			return [found ? [found] : [], []];
		}
		if (/DELETE FROM oauth_state/.test(sql)) {
			return [{ affectedRows: 3 }, []];
		}
		return [[], []];
	});
}

/** The state value out of an authorize URL. */
function stateFrom(url) {
	return new URL(url).searchParams.get("state");
}

function tokenResponse(body, { ok = true, status = 200 } = {}) {
	return {
		ok,
		status,
		text: async () => JSON.stringify(body),
		headers: new Map(),
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	stateRows = [];
	consumeAffected = 1;
	wireDb();
	mockHasConsent.mockResolvedValue(true);
	mockCredentials.put.mockResolvedValue({ provider: "strava", status: "active" });
	global.fetch = jest.fn();
	jest.spyOn(console, "warn").mockImplementation(() => {});
	jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("begin", () => {
	it("builds an authorize URL with the registered redirect URI", async () => {
		const { authorize_url } = await oauth.begin(ACTOR, "strava");
		const url = new URL(authorize_url);

		expect(url.origin + url.pathname).toBe("https://www.strava.com/oauth/authorize");
		expect(url.searchParams.get("client_id")).toBe("strava-client");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("redirect_uri")).toBe(
			"https://api.athena.test/api/v1/integrations/strava/callback"
		);
		expect(url.searchParams.get("state")).toBeTruthy();
	});

	it("joins Strava scopes with commas and Google's with spaces", async () => {
		const strava = new URL((await oauth.begin(ACTOR, "strava")).authorize_url);
		expect(strava.searchParams.get("scope")).toBe("read,activity:read");

		const google = new URL((await oauth.begin(ACTOR, "google_calendar")).authorize_url);
		expect(google.searchParams.get("scope").split(" ")).toContain("openid");
	});

	it("asks Google for offline access so a refresh token comes back", async () => {
		const url = new URL((await oauth.begin(ACTOR, "google_calendar")).authorize_url);
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("prompt")).toBe("consent");
	});

	it("sends a PKCE challenge only for providers that support it", async () => {
		const google = new URL((await oauth.begin(ACTOR, "google_calendar")).authorize_url);
		expect(google.searchParams.get("code_challenge_method")).toBe("S256");
		expect(google.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);

		const strava = new URL((await oauth.begin(ACTOR, "strava")).authorize_url);
		expect(strava.searchParams.get("code_challenge")).toBeNull();
	});

	it("stores the state hashed, never the state itself", async () => {
		const { authorize_url } = await oauth.begin(ACTOR, "strava");
		const state = stateFrom(authorize_url);
		expect(stateRows).toHaveLength(1);
		expect(stateRows[0].state_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(stateRows[0].state_hash).not.toBe(state);
		expect(stateRows[0].profile_id).toBe(42);
	});

	it("stores the PKCE verifier, and never puts it in the URL", async () => {
		const { authorize_url } = await oauth.begin(ACTOR, "google_calendar");
		expect(stateRows[0].code_verifier).toMatch(/^[\w-]{64}$/);
		expect(authorize_url).not.toContain(stateRows[0].code_verifier);
	});

	it("refuses a health provider until health_data consent exists", async () => {
		mockHasConsent.mockResolvedValue(false);
		await expect(oauth.begin(ACTOR, "whoop")).rejects.toMatchObject({
			status: 412,
			code: "consent_required",
		});
		expect(mockHasConsent).toHaveBeenCalledWith("google-42", "health_data");
		expect(stateRows).toHaveLength(0);
	});

	it("does not gate a provider that carries no health data", async () => {
		mockHasConsent.mockResolvedValue(false);
		await expect(oauth.begin(ACTOR, "google_calendar")).resolves.toBeDefined();
	});

	it("reports a provider that is not configured on this server", async () => {
		delete process.env.STRAVA_CLIENT_SECRET;
		await expect(oauth.begin(ACTOR, "strava")).rejects.toMatchObject({ status: 503 });
		process.env.STRAVA_CLIENT_SECRET = "strava-secret";
	});

	it("rejects an unknown provider", async () => {
		await expect(oauth.begin(ACTOR, "facebook")).rejects.toMatchObject({ status: 404 });
	});

	it("requires an authenticated actor", async () => {
		await expect(oauth.begin(null, "strava")).rejects.toMatchObject({ status: 401 });
	});
});

describe("return-target allowlist", () => {
	it("keeps an allowlisted target", () => {
		expect(oauth.resolveReturnTarget("https://app.athena.test/settings")).toBe(
			"https://app.athena.test/settings"
		);
	});

	it("falls back to the first allowed origin for anything else", () => {
		// The callback is public, so an unchecked redirect_to would make it an
		// open redirect worth abusing in phishing.
		expect(oauth.resolveReturnTarget("https://evil.test/steal")).toBe(
			"https://app.athena.test"
		);
		// A prefix that merely starts with an allowed origin must not pass.
		expect(oauth.resolveReturnTarget("https://app.athena.test.evil.test")).toBe(
			"https://app.athena.test"
		);
		expect(oauth.resolveReturnTarget(undefined)).toBe("https://app.athena.test");
	});
});

describe("complete", () => {
	async function startFlow(provider = "strava") {
		const { authorize_url } = await oauth.begin(ACTOR, provider, {
			redirectTo: "https://app.athena.test/settings",
		});
		return stateFrom(authorize_url);
	}

	it("exchanges the code and stores the credential against the state's profile", async () => {
		const state = await startFlow();
		global.fetch.mockResolvedValue(
			tokenResponse({
				access_token: "at-1",
				refresh_token: "rt-1",
				token_type: "Bearer",
				scope: "read,activity:read",
				expires_at: Math.floor(Date.now() / 1000) + 21600,
				athlete: { id: 99, firstname: "Ross", lastname: "B" },
			})
		);

		const result = await oauth.complete("strava", { code: "auth-code", state });

		const [url, init] = global.fetch.mock.calls[0];
		expect(url).toBe("https://www.strava.com/oauth/token");
		const sent = new URLSearchParams(init.body);
		expect(sent.get("grant_type")).toBe("authorization_code");
		expect(sent.get("code")).toBe("auth-code");
		expect(sent.get("client_secret")).toBe("strava-secret");

		expect(mockCredentials.put).toHaveBeenCalledWith(
			expect.objectContaining({
				profileId: 42,
				provider: "strava",
				accessToken: "at-1",
				refreshToken: "rt-1",
				externalAccountId: "99",
				displayName: "Ross B",
				actor: "oauth-callback",
			})
		);
		expect(result.redirectTo).toBe("https://app.athena.test/settings");
	});

	it("converts Strava's absolute expires_at into a Date", async () => {
		const state = await startFlow();
		const epoch = Math.floor(Date.now() / 1000) + 21600;
		global.fetch.mockResolvedValue(
			tokenResponse({ access_token: "at", expires_at: epoch, athlete: { id: 1 } })
		);
		await oauth.complete("strava", { code: "c", state });
		const stored = mockCredentials.put.mock.calls[0][0];
		expect(stored.expiresAt).toBeInstanceOf(Date);
		expect(Math.floor(stored.expiresAt.getTime() / 1000)).toBe(epoch);
		expect(stored.expiresIn).toBeNull();
	});

	it("sends the stored PKCE verifier on the exchange", async () => {
		const state = await startFlow("google_calendar");
		global.fetch.mockResolvedValue(tokenResponse({ access_token: "at" }));
		await oauth.complete("google_calendar", { code: "c", state });
		const sent = new URLSearchParams(global.fetch.mock.calls[0][1].body);
		expect(sent.get("code_verifier")).toBe(stateRows[0].code_verifier);
	});

	it("refuses a state that was already consumed", async () => {
		const state = await startFlow();
		consumeAffected = 0; // the guarded UPDATE matched nothing
		await expect(oauth.complete("strava", { code: "c", state })).rejects.toMatchObject({
			code: "state_invalid",
		});
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("refuses a missing state, and a state issued for another provider", async () => {
		await expect(oauth.complete("strava", { code: "c" })).rejects.toMatchObject({
			code: "state_missing",
		});
		const state = await startFlow("strava");
		consumeAffected = 0; // the UPDATE filters on provider
		await expect(
			oauth.complete("google_calendar", { code: "c", state })
		).rejects.toMatchObject({ code: "state_invalid" });
	});

	it("stores nothing when the provider rejects the exchange", async () => {
		const state = await startFlow();
		global.fetch.mockResolvedValue(
			tokenResponse({ error: "invalid_grant", error_description: "Code is expired" }, {
				ok: false,
				status: 400,
			})
		);
		await expect(oauth.complete("strava", { code: "c", state })).rejects.toMatchObject({
			message: "Code is expired",
		});
		expect(mockCredentials.put).not.toHaveBeenCalled();
	});

	it("burns the state and carries the return target when the user declines", async () => {
		const state = await startFlow();
		const err = await oauth
			.complete("strava", { state, error: "access_denied" })
			.catch((e) => e);
		expect(err.code).toBe("access_denied");
		expect(err.redirectTo).toBe("https://app.athena.test/settings");
		expect(mockQuery).toHaveBeenCalledWith(
			expect.stringMatching(/UPDATE oauth_state/),
			expect.anything()
		);
	});
});

describe("accessToken", () => {
	it("returns a live token without contacting the provider", async () => {
		mockCredentials.get.mockResolvedValue({
			uuid: "cred-1",
			accessToken: "still-good",
			refreshToken: "rt",
			expired: false,
		});
		expect(await oauth.accessToken(42, "strava")).toBe("still-good");
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("returns null when nothing is linked", async () => {
		mockCredentials.get.mockResolvedValue(null);
		expect(await oauth.accessToken(42, "strava")).toBeNull();
	});

	it("refreshes an expired token and persists the rotated refresh token", async () => {
		mockCredentials.get.mockResolvedValue({
			uuid: "cred-1",
			accessToken: "stale",
			refreshToken: "rt-old",
			expired: true,
		});
		global.fetch.mockResolvedValue(
			tokenResponse({
				access_token: "at-new",
				refresh_token: "rt-new",
				expires_in: 21600,
			})
		);

		expect(await oauth.accessToken(42, "strava")).toBe("at-new");

		const sent = new URLSearchParams(global.fetch.mock.calls[0][1].body);
		expect(sent.get("grant_type")).toBe("refresh_token");
		expect(sent.get("refresh_token")).toBe("rt-old");
		// Strava rotates on every refresh; dropping the new one kills the link.
		expect(mockCredentials.updateTokens).toHaveBeenCalledWith(
			"cred-1",
			expect.objectContaining({ accessToken: "at-new", refreshToken: "rt-new" })
		);
	});

	it("collapses concurrent refreshes of the same credential", async () => {
		mockCredentials.get.mockResolvedValue({
			uuid: "cred-1",
			accessToken: "stale",
			refreshToken: "rt-old",
			expired: true,
		});
		global.fetch.mockResolvedValue(
			tokenResponse({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 })
		);

		const results = await Promise.all([
			oauth.accessToken(42, "strava"),
			oauth.accessToken(42, "strava"),
			oauth.accessToken(42, "strava"),
		]);

		expect(results).toEqual(["at-new", "at-new", "at-new"]);
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it("flags for reconnection when the grant is rejected", async () => {
		mockCredentials.get.mockResolvedValue({
			uuid: "cred-1",
			refreshToken: "rt-dead",
			expired: true,
		});
		global.fetch.mockResolvedValue(
			tokenResponse({ error: "invalid_grant" }, { ok: false, status: 400 })
		);

		expect(await oauth.accessToken(42, "strava")).toBeNull();
		expect(mockCredentials.markNeedsReauth).toHaveBeenCalledWith(
			"cred-1",
			expect.objectContaining({ detail: "invalid_grant" })
		);
	});

	it("does not tear down a link over a transient provider failure", async () => {
		mockCredentials.get.mockResolvedValue({
			uuid: "cred-1",
			refreshToken: "rt",
			expired: true,
		});
		global.fetch.mockResolvedValue(
			tokenResponse({ message: "bad gateway" }, { ok: false, status: 502 })
		);

		await expect(oauth.accessToken(42, "strava")).rejects.toMatchObject({
			code: "refresh_failed",
		});
		expect(mockCredentials.markNeedsReauth).not.toHaveBeenCalled();
	});

	it("flags for reconnection when expired with no refresh token", async () => {
		mockCredentials.get.mockResolvedValue({
			uuid: "cred-1",
			refreshToken: null,
			expired: true,
		});
		expect(await oauth.accessToken(42, "strava")).toBeNull();
		expect(mockCredentials.markNeedsReauth).toHaveBeenCalled();
		expect(global.fetch).not.toHaveBeenCalled();
	});
});

describe("disconnect", () => {
	it("revokes upstream, then clears locally", async () => {
		mockCredentials.get.mockResolvedValue({ uuid: "c", accessToken: "at" });
		mockCredentials.revoke.mockResolvedValue({ provider: "strava", revoked: true });
		global.fetch.mockResolvedValue(tokenResponse({}));

		const result = await oauth.disconnect(ACTOR, "strava");
		expect(global.fetch.mock.calls[0][0]).toBe("https://www.strava.com/oauth/revoke");
		expect(new URLSearchParams(global.fetch.mock.calls[0][1].body).get("access_token")).toBe("at");
		expect(result).toEqual({ provider: "strava", revoked: true, revoked_upstream: true });
	});

	it("still clears locally when the provider's revocation fails", async () => {
		mockCredentials.get.mockResolvedValue({ uuid: "c", accessToken: "at" });
		mockCredentials.revoke.mockResolvedValue({ provider: "strava", revoked: true });
		global.fetch.mockRejectedValue(new Error("network down"));

		const result = await oauth.disconnect(ACTOR, "strava");
		expect(result.revoked).toBe(true);
		expect(result.revoked_upstream).toBe(false);
	});

	it("skips upstream revocation for a provider that has no revoke endpoint", async () => {
		mockCredentials.revoke.mockResolvedValue({ provider: "whoop", revoked: true });
		const result = await oauth.disconnect(ACTOR, "whoop");
		expect(global.fetch).not.toHaveBeenCalled();
		expect(result.revoked_upstream).toBe(false);
	});
});

describe("status", () => {
	it("reports a provider's consent requirement and link state", async () => {
		mockCredentials.status.mockResolvedValue(null);
		const state = await oauth.status(ACTOR, "whoop");
		expect(state).toMatchObject({
			provider: "whoop",
			label: "Whoop",
			connected: false,
			requires_consent: "health_data",
		});
	});

	it("lists every supported provider", async () => {
		mockCredentials.status.mockResolvedValue(null);
		const all = await oauth.statusAll(ACTOR);
		expect(all.map((p) => p.provider).sort()).toEqual([
			"google_calendar",
			"strava",
			"whoop",
		]);
	});
});
