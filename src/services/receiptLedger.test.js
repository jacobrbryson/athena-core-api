/**
 * receiptLedger — the filed-receipts read. Read-only, scoped to the caller,
 * summed per currency, and honest about receipts with no amount.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn() }));

const pool = require("../helpers/db");
const ledger = require("./receiptLedger");

const row = (over) => ({ uuid: "u", merchant: "USAA", category: "insurance", amount: "459.63", currency: "USD", purchased_at: new Date("2026-10-28T00:00:00Z"), created_at: new Date("2026-10-28T23:56:59Z"), subject: "Your payment", from_name: "USAA", from_address: "a@usaa.com", ...over });

beforeEach(() => jest.clearAllMocks());

test("reads only the caller's receipts, with a capped limit", async () => {
	pool.query.mockResolvedValue([[]]);
	await ledger.list(42, { limit: 99999 });
	const [sql, args] = pool.query.mock.calls[0];
	expect(sql).toMatch(/WHERE r\.profile_id = \?/);
	expect(sql).toMatch(/t\.profile_id = r\.profile_id/);
	expect(args).toEqual([42, 500]);
	expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
});

test("shapes a receipt and numbers the amount", async () => {
	pool.query.mockResolvedValue([[row()]]);
	const { receipts } = await ledger.list(42);
	expect(receipts[0]).toEqual({ uuid: "u", merchant: "USAA", category: "insurance", amount: 459.63, currency: "USD", date: "2026-10-28", dated: true, subject: "Your payment" });
});

test("falls back to the filing date, and to the sender when the merchant is missing", async () => {
	pool.query.mockResolvedValue([[row({ merchant: null, purchased_at: null, amount: null })]]);
	const { receipts } = await ledger.list(42);
	expect(receipts[0]).toMatchObject({ merchant: "USAA", date: "2026-10-28", dated: false, amount: null });
});

test("totals each month per currency, newest first, without converting or guessing", async () => {
	pool.query.mockResolvedValue([[
		row({ uuid: "a", amount: "10.10" }),
		row({ uuid: "b", amount: "20.20" }),
		row({ uuid: "c", amount: "5.00", currency: "CAD" }),
		row({ uuid: "d", amount: null }),
		row({ uuid: "e", amount: "7.00", purchased_at: new Date("2026-09-30T00:00:00Z") }),
	]]);
	const { months } = await ledger.list(42);
	expect(months.map((m) => m.month)).toEqual(["2026-10", "2026-09"]);
	expect(months[0].count).toBe(4);
	expect(months[0].totals).toEqual(expect.arrayContaining([{ currency: "USD", amount: 30.3 }, { currency: "CAD", amount: 5 }]));
	expect(months[1]).toEqual({ month: "2026-09", count: 1, totals: [{ currency: "USD", amount: 7 }] });
});

test("says when the list was cut off", async () => {
	pool.query.mockResolvedValue([Array.from({ length: 3 }, (_, i) => row({ uuid: String(i) }))]);
	expect((await ledger.list(42, { limit: 3 })).truncated).toBe(true);
	expect((await ledger.list(42, { limit: 4 })).truncated).toBe(false);
});
