/**
 * Look requests — Athena asking a device to open a camera.
 *
 * Weighted toward the cases where she must NOT get a look: a request that
 * piles onto others, one answered twice, one answered by the wrong person.
 * The authority to ask at all is the action layer's business and is tested
 * there; this is about what happens after she has been allowed to ask.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("crypto", () => ({ ...jest.requireActual("crypto"), randomUUID: () => "look-uuid" }));

const pool = require("../helpers/db");
const lookRequests = require("./lookRequests");

const outstanding = (n) => [[{ outstanding: n }]];

beforeEach(() => pool.query.mockReset());

describe("create", () => {
	test("records the reason she gave", async () => {
		pool.query.mockResolvedValueOnce(outstanding(0));
		pool.query.mockResolvedValueOnce([{ insertId: 1 }]);
		const r = await lookRequests.create(7, { reason: "You asked what I think", prefer: "front" });
		expect(r).toMatchObject({ uuid: "look-uuid", reason: "You asked what I think" });
		const [, params] = pool.query.mock.calls[1];
		expect(params[3]).toBe("You asked what I think");
		expect(params[4]).toBe("front");
	});

	test("refuses to pile up — a queue means several cameras at once", async () => {
		pool.query.mockResolvedValueOnce(outstanding(lookRequests.MAX_PENDING));
		expect(await lookRequests.create(7, { reason: "again" })).toBeNull();
		expect(pool.query).toHaveBeenCalledTimes(1); // counted, never inserted
	});

	test("an unrecognised camera hint is stored as none, never passed through", async () => {
		pool.query.mockResolvedValueOnce(outstanding(0));
		pool.query.mockResolvedValueOnce([{ insertId: 1 }]);
		await lookRequests.create(7, { reason: "ok", prefer: "rear" });
		expect(pool.query.mock.calls[1][1][4]).toBeNull();
	});

	test("a profile that is not a profile never reaches the database", async () => {
		// Number(null) is 0 and passes a naive finite check — the same trap the
		// session work hit. None of these is a person.
		for (const nobody of [null, undefined, "", 0, NaN, -1]) {
			expect(await lookRequests.create(nobody, { reason: "ok" })).toBeNull();
		}
		expect(pool.query).not.toHaveBeenCalled();
	});
});

describe("pendingFor", () => {
	test("excludes anything already expired", async () => {
		pool.query.mockResolvedValueOnce([[]]);
		await lookRequests.pendingFor(7);
		const [sql] = pool.query.mock.calls[0];
		expect(sql).toContain("status = 'pending'");
		expect(sql).toContain("expires_at > NOW()");
	});

	test("oldest first — she asked for that one first", async () => {
		pool.query.mockResolvedValueOnce([[]]);
		await lookRequests.pendingFor(7);
		expect(pool.query.mock.calls[0][0]).toContain("ORDER BY created_at ASC");
	});
});

describe("fulfil", () => {
	test("two tabs answering the same request produce one fulfilment", async () => {
		pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
		expect(await lookRequests.fulfil(7, "look-uuid")).toBe(true);
		pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
		expect(await lookRequests.fulfil(7, "look-uuid")).toBe(false);
		// The guard, not a check this code remembers.
		expect(pool.query.mock.calls[0][0]).toContain("status = 'pending'");
	});

	test("is scoped to the profile, so a uuid is not authority", async () => {
		pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
		await lookRequests.fulfil(7, "look-uuid");
		expect(pool.query.mock.calls[0][1]).toEqual(["look-uuid", 7]);
		expect(pool.query.mock.calls[0][0]).toContain("profile_id = ?");
	});

	test("nonsense arguments never reach the database", async () => {
		expect(await lookRequests.fulfil(7, "")).toBe(false);
		expect(await lookRequests.fulfil(null, "look-uuid")).toBe(false);
		expect(pool.query).not.toHaveBeenCalled();
	});
});

describe("decline", () => {
	test("a refusal is recorded, not silently dropped", async () => {
		// "She asked and the device refused" and "she never asked" must not look
		// the same to someone reading back what her camera access was used for.
		pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
		expect(await lookRequests.decline(7, "look-uuid", "no camera")).toBe(true);
		expect(pool.query.mock.calls[0][0]).toContain("status = 'declined'");
	});

	test("cannot decline something already answered", async () => {
		pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
		expect(await lookRequests.decline(7, "look-uuid")).toBe(false);
	});
});
