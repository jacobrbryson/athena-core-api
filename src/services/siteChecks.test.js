jest.mock("../helpers/db", () => ({ query: jest.fn() }));
const pool = require("../helpers/db");
const siteChecks = require("./siteChecks");

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("a site that answers 200 is up, with its time", async () => {
	const fetchImpl = jest.fn(async () => ({ status: 200, body: { cancel: async () => undefined } }));
	const r = await siteChecks.probe("orcwood.com", { fetchImpl, lookup: publicLookup });
	expect(r.ok).toBe(true);
	expect(r.statusCode).toBe(200);
	expect(typeof r.ms).toBe("number");
	expect(fetchImpl).toHaveBeenCalledWith("https://orcwood.com/", expect.objectContaining({ redirect: "manual" }));
});

test("a redirect is an answer, not followed", async () => {
	const r = await siteChecks.probe("orcwood.com", { fetchImpl: async () => ({ status: 301 }), lookup: publicLookup });
	expect(r.ok).toBe(true);
});

test("a 5xx is down and says so", async () => {
	const r = await siteChecks.probe("orcwood.com", { fetchImpl: async () => ({ status: 503 }), lookup: publicLookup });
	expect(r).toMatchObject({ ok: false, statusCode: 503, error: "Answered 503" });
});

test("a domain resolving to a private address is never contacted", async () => {
	const fetchImpl = jest.fn();
	for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1"]) {
		const r = await siteChecks.probe("evil.example", { fetchImpl, lookup: async () => [{ address }] });
		expect(r.ok).toBe(false);
	}
	expect(fetchImpl).not.toHaveBeenCalled();
});

test("a failed connection is down, not an exception", async () => {
	const r = await siteChecks.probe("orcwood.com", { fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, lookup: publicLookup });
	expect(r).toMatchObject({ ok: false, statusCode: null, error: "Couldn't connect" });
});

test("before migration 0079, latest and checkStale report nothing instead of failing", async () => {
	pool.query.mockRejectedValue(Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE" }));
	expect((await siteChecks.latest([1])).size).toBe(0);
	expect(await siteChecks.checkStale(7)).toBe(0);
});
