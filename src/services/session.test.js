/**
 * Session authorization tests.
 *
 * Sessions used to be resumable by (uuid + IP), so a child moving between wifi
 * and cell data silently lost their conversation. Identity is the key now:
 * a profile-bound session is authorized by a PROVEN profile, and only a truly
 * anonymous session still falls back to the IP check.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn() }));
// `uuid` ships ESM only, which jest can't transform here.
jest.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }));

const pool = require("../helpers/db");
const sessions = require("./session");

const row = (over = {}) => ({
	id: 7,
	uuid: "sess-abc",
	ip_address: "1.2.3.4",
	profile_id: null,
	family_id: null,
	mode: "companion",
	age: 5,
	is_busy: 0,
	wisdom_points: 0,
	...over,
});

beforeEach(() => pool.query.mockReset());

describe("getAuthorizedSession — profile-bound sessions", () => {
	test("the owning profile resumes from a DIFFERENT ip", async () => {
		pool.query.mockResolvedValueOnce([[row({ profile_id: 42 })]]);
		const s = await sessions.getAuthorizedSession("sess-abc", {
			ip: "9.9.9.9", // moved from wifi to cell data
			callerProfileId: 42,
		});
		expect(s).toMatchObject({ id: 7, profile_id: 42 });
	});

	test("the lookup no longer filters on ip", async () => {
		pool.query.mockResolvedValueOnce([[row({ profile_id: 42 })]]);
		await sessions.getAuthorizedSession("sess-abc", { ip: "9.9.9.9", callerProfileId: 42 });
		const [sql, params] = pool.query.mock.calls[0];
		expect(sql).not.toContain("s.ip_address = ?");
		expect(params).toEqual(["sess-abc"]);
	});

	test("a different profile is refused even on the ORIGINAL ip", async () => {
		pool.query.mockResolvedValueOnce([[row({ profile_id: 42 })]]);
		const s = await sessions.getAuthorizedSession("sess-abc", {
			ip: "1.2.3.4",
			callerProfileId: 43,
		});
		expect(s).toBeNull();
	});

	test("an unauthenticated caller cannot resume a bound session", async () => {
		// This is the case the old IP check was standing in for: knowing the
		// session uuid must not be enough.
		pool.query.mockResolvedValueOnce([[row({ profile_id: 42 })]]);
		expect(
			await sessions.getAuthorizedSession("sess-abc", {
				ip: "1.2.3.4",
				callerProfileId: null,
			})
		).toBeNull();
	});

	test("string/number profile ids compare correctly", async () => {
		pool.query.mockResolvedValueOnce([[row({ profile_id: 42 })]]);
		const s = await sessions.getAuthorizedSession("sess-abc", {
			ip: null,
			callerProfileId: "42",
		});
		expect(s).not.toBeNull();
	});
});

describe("getAuthorizedSession — anonymous sessions", () => {
	test("a matching ip still resumes", async () => {
		pool.query.mockResolvedValueOnce([[row()]]);
		const s = await sessions.getAuthorizedSession("sess-abc", { ip: "1.2.3.4" });
		expect(s).toMatchObject({ id: 7 });
	});

	test("a different ip is refused — there is no identity to fall back on", async () => {
		pool.query.mockResolvedValueOnce([[row()]]);
		expect(
			await sessions.getAuthorizedSession("sess-abc", { ip: "9.9.9.9" })
		).toBeNull();
	});

	test("no ip at all is refused", async () => {
		pool.query.mockResolvedValueOnce([[row()]]);
		expect(
			await sessions.getAuthorizedSession("sess-abc", { ip: null })
		).toBeNull();
	});

	test("a proven profile does NOT unlock somebody else's anonymous session", async () => {
		pool.query.mockResolvedValueOnce([[row()]]);
		expect(
			await sessions.getAuthorizedSession("sess-abc", {
				ip: "9.9.9.9",
				callerProfileId: 42,
			})
		).toBeNull();
	});
});

describe("getAuthorizedSession — basics", () => {
	test("an unknown session is null", async () => {
		pool.query.mockResolvedValueOnce([[]]);
		expect(
			await sessions.getAuthorizedSession("nope", { ip: "1.2.3.4" })
		).toBeNull();
	});

	test("a missing uuid never hits the database", async () => {
		expect(await sessions.getAuthorizedSession("", { ip: "1.2.3.4" })).toBeNull();
		expect(pool.query).not.toHaveBeenCalled();
	});
});
