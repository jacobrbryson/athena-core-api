/**
 * Per-user credential store: encryption at rest, the no-plaintext-escapes
 * rule, upsert/revive semantics, and the audit trail.
 */
process.env.JWT_SECRET = "test-jwt-secret";

const mockKeyring = {
	active: "k1",
	keys: { k1: "a".repeat(64), k2: "b".repeat(64) },
};
jest.mock("../services/secrets", () => ({
	getSecretJson: jest.fn().mockResolvedValue(mockKeyring),
}));

const mockQuery = jest.fn();
jest.mock("../helpers/db", () => ({ query: mockQuery, getConnection: jest.fn() }));

// withTransaction hands back a connection; here that is the same fake pool, so
// every statement lands in one inspectable log.
jest.mock("./parent-helpers", () => ({
	withTransaction: (fn) => fn(require("../helpers/db")),
}));

jest.mock("uuid", () => ({ v4: () => "uuid-fixed" }));

const credentials = require("./credentials");
const { decrypt } = require("../helpers/crypto");

/** Every (sql, params) pair the code ran, in order. */
let statements = [];

function sqlLog(pattern) {
	return statements.filter((s) => pattern.test(s.sql));
}

/** A stored row as MySQL would hand it back. */
function row(over = {}) {
	return {
		id: 7,
		uuid: "uuid-existing",
		profile_id: 42,
		provider: "strava",
		kind: "oauth2",
		external_account_id: "athlete-1",
		display_name: "Ross",
		access_token_enc: null,
		refresh_token_enc: null,
		token_type: "Bearer",
		scopes: "read activity:read",
		expires_at: new Date(Date.now() + 3600_000),
		status: "active",
		last_refreshed_at: null,
		last_used_at: null,
		created_at: new Date(),
		updated_at: new Date(),
		revoked_at: null,
		...over,
	};
}

/**
 * Drive pool.query by shape: SELECTs return whatever the test queued next,
 * writes return an OK packet. Keeps tests about behavior, not call indexes.
 */
function respondWith(selectResults) {
	const queue = [...selectResults];
	mockQuery.mockImplementation(async (sql, params) => {
		statements.push({ sql, params });
		if (/^\s*SELECT/i.test(sql)) {
			const next = queue.length ? queue.shift() : [];
			return [next, []];
		}
		return [{ affectedRows: 1, insertId: 7 }, []];
	});
}

beforeEach(() => {
	jest.clearAllMocks();
	statements = [];
	jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("put", () => {
	it("encrypts both tokens and never writes plaintext", async () => {
		respondWith([[], [row({ access_token_enc: "v2:k1:x" })]]);

		await credentials.put({
			profileId: 42,
			provider: "strava",
			externalAccountId: "athlete-1",
			accessToken: "plain-access",
			refreshToken: "plain-refresh",
			expiresIn: 21600,
		});

		const insert = sqlLog(/INSERT INTO user_credential\b/)[0];
		expect(insert).toBeDefined();

		const flat = JSON.stringify(insert.params);
		expect(flat).not.toContain("plain-access");
		expect(flat).not.toContain("plain-refresh");

		// ...and what was written is genuinely our ciphertext.
		const [accessEnc, refreshEnc] = insert.params.slice(6, 8);
		expect(accessEnc.startsWith("v2:k1:")).toBe(true);
		expect(await decrypt(accessEnc)).toBe("plain-access");
		expect(await decrypt(refreshEnc)).toBe("plain-refresh");
	});

	it("turns expiresIn into an absolute expiry", async () => {
		respondWith([[], [row()]]);
		const before = Date.now();
		await credentials.put({
			profileId: 42,
			provider: "whoop",
			accessToken: "a",
			expiresIn: 3600,
		});
		const expiry = sqlLog(/INSERT INTO user_credential\b/)[0].params[10];
		expect(expiry.getTime()).toBeGreaterThanOrEqual(before + 3599_000);
		expect(expiry.getTime()).toBeLessThanOrEqual(Date.now() + 3600_000);
	});

	it("keeps an existing refresh token when a re-link omits one", async () => {
		// Google issues a refresh token on first consent only; a re-consent
		// without prompt=consent returns none, and must not wipe it.
		respondWith([[row()], [row()]]);
		await credentials.put({
			profileId: 42,
			provider: "google_calendar",
			accessToken: "fresh-access",
		});
		const insert = sqlLog(/INSERT INTO user_credential\b/)[0];
		expect(insert.sql).toMatch(
			/refresh_token_enc = COALESCE\(VALUES\(refresh_token_enc\), refresh_token_enc\)/
		);
		expect(insert.params[7]).toBeNull();
	});

	it("reuses the uuid when re-linking and revives a revoked row", async () => {
		respondWith([[row({ status: "revoked" })], [row()]]);
		await credentials.put({
			profileId: 42,
			provider: "strava",
			externalAccountId: "athlete-1",
			accessToken: "a",
		});
		const insert = sqlLog(/INSERT INTO user_credential\b/)[0];
		expect(insert.params[0]).toBe("uuid-existing");
		expect(insert.sql).toMatch(/status = 'active'/);
		expect(insert.sql).toMatch(/revoked_at = NULL/);
	});

	it("writes an audit row in the same transaction", async () => {
		respondWith([[], [row()]]);
		await credentials.put({
			profileId: 42,
			provider: "strava",
			accessToken: "a",
			actor: "oauth-callback",
		});
		const [audit] = sqlLog(/INSERT INTO user_credential_audit/);
		expect(audit.params).toEqual(
			expect.arrayContaining([42, "strava", "linked", "oauth-callback"])
		);
	});

	it("returns a public record carrying no token", async () => {
		respondWith([[], [row({ access_token_enc: "v2:k1:x", refresh_token_enc: "v2:k1:y" })]]);
		const result = await credentials.put({
			profileId: 42,
			provider: "strava",
			accessToken: "a",
		});
		expect(result).not.toHaveProperty("accessToken");
		expect(JSON.stringify(result)).not.toContain("v2:k1:");
		expect(result.scopes).toEqual(["read", "activity:read"]);
	});

	it("rejects an unknown provider and a missing token", async () => {
		respondWith([]);
		await expect(
			credentials.put({ profileId: 42, provider: "facebook", accessToken: "a" })
		).rejects.toThrow(/Unsupported credential provider/);
		await expect(
			credentials.put({ profileId: 42, provider: "strava", accessToken: "" })
		).rejects.toThrow(/accessToken is required/);
		expect(sqlLog(/INSERT INTO user_credential\b/)).toHaveLength(0);
	});
});

describe("get", () => {
	it("decrypts, stamps last_used_at, and audits the read", async () => {
		const { encrypt } = require("../helpers/crypto");
		const stored = row({
			access_token_enc: await encrypt("live-access"),
			refresh_token_enc: await encrypt("live-refresh"),
		});
		respondWith([[stored]]);

		const cred = await credentials.get(42, "strava", { actor: "strava-tool" });
		expect(cred.accessToken).toBe("live-access");
		expect(cred.refreshToken).toBe("live-refresh");
		expect(cred.expired).toBe(false);

		expect(sqlLog(/UPDATE user_credential SET last_used_at/)).toHaveLength(1);
		const [audit] = sqlLog(/INSERT INTO user_credential_audit/);
		expect(audit.params).toEqual(expect.arrayContaining(["read", "strava-tool"]));
	});

	it("flags a credential that is expired but refreshable", async () => {
		const { encrypt } = require("../helpers/crypto");
		respondWith([
			[
				row({
					access_token_enc: await encrypt("stale"),
					refresh_token_enc: await encrypt("refresh"),
					expires_at: new Date(Date.now() - 1000),
				}),
			],
		]);
		const cred = await credentials.get(42, "strava");
		expect(cred.expired).toBe(true);
		expect(cred.needsRefresh).toBe(true);
	});

	it("treats a token inside the expiry skew as expired", async () => {
		const { encrypt } = require("../helpers/crypto");
		respondWith([
			[
				row({
					access_token_enc: await encrypt("about-to-die"),
					expires_at: new Date(Date.now() + 30_000),
				}),
			],
		]);
		expect((await credentials.get(42, "strava")).expired).toBe(true);
	});

	it("returns null for a revoked or missing credential", async () => {
		respondWith([[row({ status: "revoked", access_token_enc: null })], []]);
		expect(await credentials.get(42, "strava")).toBeNull();
		expect(await credentials.get(42, "strava")).toBeNull();
		expect(sqlLog(/UPDATE user_credential SET last_used_at/)).toHaveLength(0);
	});

	it("audits and returns null when the ciphertext cannot be read", async () => {
		// What a key pruned too early would look like.
		respondWith([[row({ access_token_enc: "v2:k9:aaa:bbb:ccc" })]]);
		expect(await credentials.get(42, "strava")).toBeNull();
		const [audit] = sqlLog(/INSERT INTO user_credential_audit/);
		expect(audit.params).toContain("failed");
	});
});

describe("revoke", () => {
	it("clears both ciphertext columns but keeps the row", async () => {
		respondWith([[row({ access_token_enc: "v2:k1:x" })]]);
		expect(await credentials.revoke(42, "strava")).toEqual({
			provider: "strava",
			revoked: true,
		});
		const [update] = sqlLog(/UPDATE user_credential SET\s+status = \?, revoked_at/);
		expect(update.sql).toMatch(/access_token_enc = NULL, refresh_token_enc = NULL/);
		expect(sqlLog(/DELETE FROM user_credential/)).toHaveLength(0);
		expect(sqlLog(/INSERT INTO user_credential_audit/)[0].params).toContain("revoked");
	});

	it("is a no-op when nothing is linked", async () => {
		respondWith([[]]);
		expect(await credentials.revoke(42, "whoop")).toEqual({
			provider: "whoop",
			revoked: false,
		});
		expect(sqlLog(/INSERT INTO user_credential_audit/)).toHaveLength(0);
	});
});

describe("updateTokens", () => {
	it("re-encrypts on refresh and audits it", async () => {
		respondWith([[row()], [row()]]);
		await credentials.updateTokens("uuid-existing", {
			accessToken: "rotated-access",
			expiresIn: 3600,
		});
		const [update] = sqlLog(/UPDATE user_credential SET\s+access_token_enc/);
		expect(await decrypt(update.params[0])).toBe("rotated-access");
		expect(sqlLog(/INSERT INTO user_credential_audit/)[0].params).toContain("refreshed");
	});

	it("rejects an unknown credential", async () => {
		respondWith([[]]);
		await expect(
			credentials.updateTokens("nope", { accessToken: "a" })
		).rejects.toThrow(/Credential not found/);
	});
});

describe("markNeedsReauth", () => {
	it("drops the access token and flags the row for reconnection", async () => {
		respondWith([[row({ access_token_enc: "v2:k1:x" })]]);
		const result = await credentials.markNeedsReauth("uuid-existing", {
			detail: "refresh rejected",
		});
		expect(result.status).toBe("needs_reauth");
		const [update] = sqlLog(/UPDATE user_credential SET status = \?, access_token_enc = NULL/);
		expect(update.params[0]).toBe("needs_reauth");
		expect(sqlLog(/INSERT INTO user_credential_audit/)[0].params).toContain(
			"reauth_required"
		);
	});
});

describe("list and status", () => {
	it("never selects the ciphertext columns", async () => {
		respondWith([[row()]]);
		await credentials.list(42);
		const [select] = sqlLog(/SELECT [\s\S]*FROM user_credential\b/);
		expect(select.sql).not.toMatch(/access_token_enc/);
		expect(select.sql).not.toMatch(/refresh_token_enc/);
	});

	it("hides revoked credentials", async () => {
		respondWith([[row({ status: "revoked" })]]);
		expect(await credentials.status(42, "strava")).toBeNull();
	});

	it("reports a linked provider with its scopes", async () => {
		respondWith([[row()]]);
		const state = await credentials.status(42, "strava");
		expect(state.provider).toBe("strava");
		expect(state.scopes).toEqual(["read", "activity:read"]);
		expect(state).not.toHaveProperty("access_token_enc");
	});
});

describe("history", () => {
	it("caps the row limit", async () => {
		respondWith([[]]);
		await credentials.history(42, { limit: 99999 });
		const [select] = sqlLog(/FROM user_credential_audit/);
		expect(select.params[select.params.length - 1]).toBe(500);
	});
});
