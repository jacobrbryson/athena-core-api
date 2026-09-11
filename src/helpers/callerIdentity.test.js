/**
 * callerIdentity regressions: the legacy `profile` table has no deleted_at
 * column, and a failed lookup must degrade to "anonymous" — not reject and
 * take down /session (500) and /speech (401) for every signed-in user.
 */
process.env.JWT_SECRET = "test-secret";
jest.mock("./db", () => ({ query: jest.fn() }));

const jwt = require("jsonwebtoken");
const pool = require("./db");
const { resolveCallerProfileId } = require("./callerIdentity");

const reqWith = (claims) => ({
	headers: { "x-user-authorization": `Bearer ${jwt.sign(claims, "test-secret")}` },
});

beforeEach(() => pool.query.mockReset());

test("a Google (parent / Companion) token resolves to its profile", async () => {
	pool.query.mockResolvedValueOnce([[{ id: 42 }]]);
	await expect(resolveCallerProfileId(reqWith({ google_id: "g-1", app: "companion" }))).resolves.toBe(42);
});

test("profile lookups never filter on the nonexistent deleted_at column", async () => {
	pool.query.mockResolvedValue([[{ id: 7 }]]);
	await resolveCallerProfileId(reqWith({ google_id: "g-1" }));
	await resolveCallerProfileId(reqWith({ kind: "child", profile_uuid: "p-1" }));
	for (const [sql] of pool.query.mock.calls) expect(sql).not.toMatch(/deleted_at/);
});

test("a failing lookup yields null instead of rejecting the request", async () => {
	pool.query.mockRejectedValueOnce(Object.assign(new Error("Unknown column"), { code: "ER_BAD_FIELD_ERROR" }));
	await expect(resolveCallerProfileId(reqWith({ google_id: "g-1" }))).resolves.toBeNull();
});

test("no token means anonymous, with no DB hit", async () => {
	await expect(resolveCallerProfileId({ headers: {} })).resolves.toBeNull();
	expect(pool.query).not.toHaveBeenCalled();
});
