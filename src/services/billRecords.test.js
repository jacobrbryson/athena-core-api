jest.mock("../helpers/db", () => ({ query: jest.fn() }));
const pool = require("../helpers/db");
const records = require("./billRecords");

beforeEach(() => jest.resetAllMocks());

test("the roll-forward matches the app's Renewed? button, including Feb 29", () => {
	expect(records.yearAfter("2026-11-30")).toBe("2027-11-30");
	expect(records.yearAfter("2024-02-29")).toBe("2025-03-01");
});

test("a tax record's key ignores casing and punctuation, so a second bill updates the first", () => {
	const a = records.taxKey({ kind: "property", jurisdiction: "Wake County", parcel: "0123-456", taxYear: 2026 });
	const b = records.taxKey({ kind: "property", jurisdiction: "WAKE  COUNTY", parcel: "0123 456", taxYear: 2026 });
	expect(a).toBe(b);
	expect(a).not.toBe(records.taxKey({ kind: "property", jurisdiction: "Wake County", parcel: "0123-456", taxYear: 2027 }));
});

describe("the bill claim", () => {
	test("the first approval wins", async () => {
		pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
		await expect(records.claim(42, "f".repeat(64))).resolves.toBeUndefined();
		expect(pool.query.mock.calls[0][0]).toMatch(/status <> 'applied'/);
	});
	test("a second approval of the same bill is refused", async () => {
		pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]).mockResolvedValueOnce([[{ status: "applied" }]]);
		await expect(records.claim(42, "f".repeat(64))).rejects.toMatchObject({ status: 409 });
	});
	test("a log row that was cleaned up is re-created rather than blocking the person", async () => {
		pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([{}]);
		await records.claim(42, "f".repeat(64));
		expect(pool.query.mock.calls[2][0]).toMatch(/INSERT INTO athena_bill_scan/);
	});
});

describe("binding a scan to its bill", () => {
	const fp = "e".repeat(64);
	test("a new bill takes the fingerprint on its own log row", async () => {
		pool.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([{}]);
		expect(await records.bindFingerprint(42, "scan-1", fp, "vehicle_registration", {})).toEqual({ state: "new" });
	});
	test("an already-applied bill is reported and the duplicate log row dropped", async () => {
		pool.query.mockResolvedValueOnce([[{ uuid: "old", status: "applied", applied_on: "2026-10-01" }]]).mockResolvedValueOnce([{}]);
		expect(await records.bindFingerprint(42, "scan-2", fp, "vehicle_registration", {})).toEqual({ state: "applied", appliedOn: "2026-10-01" });
		expect(pool.query.mock.calls[1][0]).toMatch(/DELETE FROM athena_bill_scan/);
	});
	test("a bill still waiting on its card is pending, not new", async () => {
		pool.query.mockResolvedValueOnce([[{ uuid: "old", status: "proposed" }]]).mockResolvedValueOnce([{}]);
		expect((await records.bindFingerprint(42, "scan-3", fp, "x", {})).state).toBe("pending");
	});
});

test("calendar drafts: no event in the past, and the reminder only when it is still ahead", () => {
	const today = "2026-11-01";
	expect(records.eventDrafts({ title: "T", dueOn: "2026-11-30", remindDays: 14, today }).map((e) => e.start)).toEqual(["2026-11-30", "2026-11-16"]);
	expect(records.eventDrafts({ title: "T", dueOn: "2026-11-05", remindDays: 14, today }).map((e) => e.start)).toEqual(["2026-11-05"]);
	expect(records.eventDrafts({ title: "T", dueOn: "2026-10-20", remindDays: 14, today })).toEqual([]);
	expect(records.eventDrafts({ title: "T", dueOn: "2026-11-30", remindDays: 0, today })).toHaveLength(1);
});

test("a bill never un-pays an installment: the upsert only sets paid_on when given one", async () => {
	pool.query.mockResolvedValue([[{ id: 1, uuid: "t1" }]]);
	await records.upsertTax(42, { kind: "property", jurisdiction: "Wake County", parcel: "1", taxYear: 2026, installments: [{ label: "A", dueOn: "2026-12-01", amount: 5, paidOn: null }] });
	const sql = pool.query.mock.calls.map((c) => c[0]).find((s) => /INSERT INTO athena_property_tax_installment/.test(s));
	expect(sql).toMatch(/paid_on = COALESCE\(VALUES\(paid_on\), paid_on\)/);
});

test("every read and write is scoped to the caller's profile", async () => {
	pool.query.mockResolvedValue([[]]);
	await records.ownVehicle(42, "u");
	await records.vehicles(42);
	await records.listTaxes(42);
	await records.removeTax(42, "u");
	for (const [sql, args] of pool.query.mock.calls) {
		expect(sql).toMatch(/profile_id = \?/);
		expect(args).toContain(42);
	}
});
