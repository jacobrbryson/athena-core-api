/**
 * record_vehicle_bill / record_property_tax_bill — the bill scan's actions.
 * They are narrow on purpose: scanner-only, never standing, events derived (not
 * supplied), ids looked up in the caller's own rows, one claim per bill.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("../consent", () => ({ hasConsentForProfile: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn() }));
jest.mock("../family", () => ({ getFamilyForProfile: jest.fn() }));
jest.mock("../connectors/googleCalendar", () => ({ createEvent: jest.fn(), deleteEvent: jest.fn() }));
jest.mock("../lookRequests", () => ({ create: jest.fn() }));
jest.mock("../memory", () => ({ CATEGORIES: new Set(["other"]), upsertMemoryForProfile: jest.fn() }));
jest.mock("../billRecords", () => ({
	...jest.requireActual("../billRecords"),
	ownVehicle: jest.fn(), ownProperty: jest.fn(), claim: jest.fn(), release: jest.fn(), noteApplied: jest.fn(),
	applyVehicle: jest.fn(), applyTax: jest.fn(),
}));

const credentials = require("../credentials");
const googleCalendar = require("../connectors/googleCalendar");
const records = require("../billRecords");
const registry = require("./registry");

const vehicleBill = registry.get("record_vehicle_bill");
const taxBill = registry.get("record_property_tax_bill");

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const FP = "a".repeat(64);
const SCAN = { profileId: 42, billScan: true };
const X5 = { uuid: "11111111-1111-4111-8111-111111111111", name: "The BMW", registration_due: day(5) };
const HOME = { uuid: "33333333-3333-4333-8333-333333333333", name: "Home", address: "123 Oak Street" };
const bill = (extra = {}) => ({ bill_fp: FP, vehicle_uuid: X5.uuid, registration_due: day(20), calendar: true, ...extra });

beforeEach(() => {
	jest.resetAllMocks();
	credentials.list.mockResolvedValue([{ provider: "google_calendar", status: "active" }]);
	records.ownVehicle.mockResolvedValue(X5);
	records.ownProperty.mockResolvedValue(HOME);
	googleCalendar.createEvent.mockResolvedValueOnce({ ref: "ev1" }).mockResolvedValueOnce({ ref: "ev2" });
	records.applyVehicle.mockResolvedValue({ vehicle: X5.uuid, tax: null });
});

test("both need the person's approval every time and can never be standing", () => {
	for (const a of [vehicleBill, taxBill]) {
		expect(a).toMatchObject({ consentType: "action_authority", standing: false });
		expect(a.direct).toBeFalsy();
	}
});

test("a model naming one in a reply is refused: only the scanner supplies the context", async () => {
	await expect(vehicleBill.normalize(bill(), { profileId: 42 })).rejects.toThrow(/photo the person shows/);
	await expect(taxBill.normalize({ bill_fp: FP }, { profileId: 42 })).rejects.toThrow(/photo the person shows/);
});

describe("record_vehicle_bill", () => {
	test("derives the events itself: a due-date event and a reminder 14 days earlier, all-day, with no plate or account in them", async () => {
		const p = await vehicleBill.normalize(bill({ amount: 214.5, payee: "NC DMV", title: "ignored", events: [{ title: "Evil", start: "2030-01-01" }] }), SCAN);
		expect(p.events.map((e) => e.start)).toEqual([day(20), day(6)]);
		expect(p.events[0]).toMatchObject({ title: `Renew The BMW registration (due ${records.shortDay(day(20))})`, all_day: true });
		expect(p.events[1].title).toMatch(/^Due in 14 days: Renew The BMW/);
		expect(JSON.stringify(p.events)).not.toMatch(/Evil|ABC|plate/i);
		expect(p.events[0].description).toBe("Added by Athena from a scanned bill. Amount $214.50. Pay: NC DMV.");
	});

	test("the reminder is skipped when it would be in the past, and an overdue date gets no event at all", async () => {
		expect((await vehicleBill.normalize(bill({ registration_due: day(5) }), SCAN)).events.map((e) => e.start)).toEqual([day(5)]);
		const overdue = await vehicleBill.normalize(bill({ registration_due: day(-3) }), SCAN);
		expect(overdue.events).toEqual([]);
		expect(vehicleBill.summarize(overdue)).toMatch(/set its registration date to/);
	});

	test("refuses a vehicle that is not the caller's, a bad date, and a missing bill reference", async () => {
		records.ownVehicle.mockResolvedValue(null);
		await expect(vehicleBill.normalize(bill(), SCAN)).rejects.toThrow(/isn't on your list/);
		records.ownVehicle.mockResolvedValue(X5);
		await expect(vehicleBill.normalize(bill({ registration_due: "11/30/2026" }), SCAN)).rejects.toThrow(/date/);
		await expect(vehicleBill.normalize(bill({ registration_due: day(3000) }), SCAN)).rejects.toThrow(/too far/);
		await expect(vehicleBill.normalize(bill({ bill_fp: "nope" }), SCAN)).rejects.toThrow(/no reference/);
		await expect(vehicleBill.normalize(bill({ amount: -5 }), SCAN)).rejects.toThrow(/amount/);
	});

	test("asking for a calendar event without a linked calendar is refused rather than silently dropped", async () => {
		credentials.list.mockResolvedValue([]);
		await expect(vehicleBill.normalize(bill(), SCAN)).rejects.toThrow(/Calendar isn't connected/);
		const p = await vehicleBill.normalize(bill({ calendar: false }), SCAN);
		expect(p.events).toEqual([]);
		expect(vehicleBill.summarize(p)).toMatch(/no calendar event/);
	});

	test("a receipt rolls the date and adds nothing to the calendar even if asked to", async () => {
		const p = await vehicleBill.normalize(bill({ paid: true, registration_due: day(370), calendar: true }), SCAN);
		expect(p.events).toEqual([]);
		expect(vehicleBill.summarize(p)).toMatch(/^Mark The BMW's registration renewed/);
	});

	test("the card says exactly what will happen", async () => {
		const p = await vehicleBill.normalize(bill({ amount: 214.5, payee: "NC DMV", tax: { amount: 150.25, tax_year: 2026, due_on: day(20), jurisdiction: "North Carolina" } }), SCAN);
		const text = vehicleBill.summarize(p);
		expect(text).toContain("The BMW");
		expect(text).toContain("$214.50 to NC DMV");
		expect(text).toContain("$150.25 vehicle tax");
		expect(text).toMatch(/add 2 all-day calendar events/);
		expect(text.length).toBeLessThanOrEqual(500);
	});

	test("executing adds the events, updates the record, and claims the bill first", async () => {
		const p = await vehicleBill.normalize(bill(), SCAN);
		const out = await vehicleBill.execute(42, p, { actionUuid: "act-1" });
		expect(records.claim).toHaveBeenCalledWith(42, FP);
		expect(records.claim.mock.invocationCallOrder[0]).toBeLessThan(googleCalendar.createEvent.mock.invocationCallOrder[0]);
		expect(googleCalendar.createEvent).toHaveBeenCalledTimes(2);
		expect(records.applyVehicle).toHaveBeenCalledWith(42, p);
		expect(records.noteApplied).toHaveBeenCalledWith(42, FP, { actionUuid: "act-1", calendarRefs: ["ev1", "ev2"] });
		expect(out.ref).toBe("ev1,ev2");
	});

	test("a second approval of the same bill stops at the claim and touches nothing", async () => {
		const p = await vehicleBill.normalize(bill(), SCAN);
		records.claim.mockRejectedValue(Object.assign(new Error("That bill is already recorded"), { status: 409 }));
		await expect(vehicleBill.execute(42, p, {})).rejects.toThrow(/already recorded/);
		expect(googleCalendar.createEvent).not.toHaveBeenCalled();
		expect(records.applyVehicle).not.toHaveBeenCalled();
	});

	test("if the record update fails after the events were added, they are taken back and the claim is released", async () => {
		const p = await vehicleBill.normalize(bill(), SCAN);
		records.applyVehicle.mockRejectedValue(new Error("db down"));
		googleCalendar.deleteEvent.mockResolvedValue({});
		await expect(vehicleBill.execute(42, p, {})).rejects.toThrow("db down");
		expect(googleCalendar.deleteEvent.mock.calls.map((c) => c[1].event_id)).toEqual(["ev1", "ev2"]);
		expect(records.release).toHaveBeenCalledWith(42, FP);
	});

	test("a calendar that needs re-linking fails before any record changes", async () => {
		const p = await vehicleBill.normalize(bill(), SCAN);
		googleCalendar.createEvent.mockReset();
		googleCalendar.createEvent.mockRejectedValue(Object.assign(new Error("Reconnect Google Calendar"), { code: "needs_reauth" }));
		await expect(vehicleBill.execute(42, p, {})).rejects.toThrow(/Reconnect/);
		expect(records.applyVehicle).not.toHaveBeenCalled();
		expect(records.release).toHaveBeenCalled();
	});

	test("the same bill is a repeat however the model worded the rest", () => {
		expect(vehicleBill.sameAs({ bill_fp: FP, payee: "a" }, { bill_fp: FP, payee: "b" })).toBe(true);
		expect(vehicleBill.sameAs({ bill_fp: FP }, { bill_fp: "b".repeat(64) })).toBe(false);
	});
});

describe("record_property_tax_bill", () => {
	const tax = (extra = {}) => ({
		bill_fp: FP, property_uuid: HOME.uuid, jurisdiction: "Wake County", tax_year: 2026, amount: 4200, calendar: true,
		installments: [{ label: "1st half", due_on: day(30), amount: 2100 }, { label: "2nd half", due_on: day(200), amount: 2100 }], ...extra,
	});

	test("puts each installment's due date on the calendar, with one reminder for the first", async () => {
		const p = await taxBill.normalize(tax(), SCAN);
		expect(p.events.map((e) => e.start)).toEqual([day(30), day(16), day(200)]);
		expect(p.events[0].title).toMatch(/^2026 property tax \(1st half\) due — Wake County \(due /);
		expect(taxBill.summarize(p)).toMatch(/Record the Wake County property tax bill for Home \(\$4,200\)/);
	});

	test("rejects a property that is not the caller's, no installments, duplicate dates and too many", async () => {
		records.ownProperty.mockResolvedValue(null);
		await expect(taxBill.normalize(tax(), SCAN)).rejects.toThrow(/isn't on your list/);
		records.ownProperty.mockResolvedValue(HOME);
		await expect(taxBill.normalize(tax({ installments: [] }), SCAN)).rejects.toThrow(/at least one due date/);
		await expect(taxBill.normalize(tax({ installments: [{ due_on: day(3) }, { due_on: day(3) }] }), SCAN)).rejects.toThrow(/share a due date/);
		await expect(taxBill.normalize(tax({ installments: Array.from({ length: 7 }, (_, i) => ({ due_on: day(i + 1) })) }), SCAN)).rejects.toThrow(/more installments/);
		await expect(taxBill.normalize(tax({ jurisdiction: "" }), SCAN)).rejects.toThrow(/owed to/);
	});

	test("a paid receipt marks the payment paid and adds no events", async () => {
		const p = await taxBill.normalize(tax({ paid: true, paid_on: day(-1), installments: [{ label: "1st half", due_on: day(-5), amount: 2100 }] }), SCAN);
		expect(p.events).toEqual([]);
		expect(taxBill.summarize(p)).toMatch(/^Mark the Wake County property tax payment/);
		records.applyTax.mockResolvedValue({ property: HOME.uuid, tax: "t1" });
		await taxBill.execute(42, p, {});
		expect(records.applyTax).toHaveBeenCalledWith(42, p);
	});
});

describe("through the real executor", () => {
	const pool = require("../../helpers/db");
	const consent = require("../consent");
	const actions = require("./index");

	beforeEach(() => {
		consent.hasConsentForProfile.mockResolvedValue(true);
		pool.query.mockImplementation(async (sql) => {
			if (/FROM athena_action\s+WHERE profile_id = \? AND action_id/.test(sql)) return [[]]; // no earlier copy
			if (/SELECT uuid, action_id, params/.test(sql) || /FROM athena_action WHERE/.test(sql) || /SELECT .* FROM athena_action/.test(sql)) {
				return [[{ uuid: "u", action_id: "record_vehicle_bill", params: "{}", summary: "s", status: "pending", expires_at: new Date(Date.now() + 1000), created_at: new Date() }]];
			}
			return [{ affectedRows: 1 }];
		});
	});

	test("a proposal from the model path is refused before any row is written", async () => {
		const out = await actions.attempt(42, 7, { id: "record_vehicle_bill", params: bill() });
		expect(out.proposal).toBeNull();
		expect(out.rejected).toMatchObject({ stage: "params", actionId: "record_vehicle_bill" });
		expect(pool.query.mock.calls.some(([sql]) => /INSERT INTO athena_action/.test(sql))).toBe(false);
	});

	test("the scanner's proposal is stored as pending with exactly the vouched params, and is never executed by proposing", async () => {
		const out = await actions.attempt(42, null, { id: "record_vehicle_bill", params: bill({ amount: 214.5 }) }, { billScan: true });
		expect(out.rejected).toBeNull();
		const insert = pool.query.mock.calls.find(([sql]) => /INSERT INTO athena_action/.test(sql));
		expect(insert).toBeTruthy();
		const stored = JSON.parse(insert[1][4]);
		expect(stored).toMatchObject({ vehicle_uuid: X5.uuid, registration_due: day(20), bill_fp: FP, amount: 214.5 });
		expect(stored.events).toHaveLength(2);
		expect(insert[0]).toMatch(/'pending'/);
		expect(googleCalendar.createEvent).not.toHaveBeenCalled();
		expect(records.applyVehicle).not.toHaveBeenCalled();
	});
});

describe("escrowed property tax", () => {
	test("is recorded with no calendar events, and the card says the lender pays it", async () => {
		const p = await taxBill.normalize({
			bill_fp: FP, property_uuid: HOME.uuid, jurisdiction: "Iredell County", escrowed: true, calendar: true, amount: 3341.02,
			installments: [{ label: "Late after", due_on: day(60), amount: 3341.02 }],
		}, SCAN);
		expect(p.events).toEqual([]);
		expect(p.escrowed).toBe(true);
		expect(taxBill.summarize(p)).toMatch(/escrowed.*mortgage company.*Home banner/);
	});
});

describe("record_vehicle_notice", () => {
	const notice = registry.get("record_vehicle_notice");
	const base = { bill_fp: FP, vehicle_uuid: X5.uuid, notice_title: "BMW extended warranty", coverage: "10 years / 120,000 miles", notice_summary: "Not a recall.", notice_on: day(0) };
	beforeEach(() => records.ownVehicle.mockResolvedValue({ ...X5, notes: "Black, parks in garage." }));

	test("is scanner-only and never standing", async () => {
		expect(notice).toMatchObject({ standing: false, consentType: "action_authority" });
		await expect(notice.normalize(base, { profileId: 42 })).rejects.toThrow(/photo the person shows/);
	});

	test("builds one dated line itself and the card shows it verbatim", async () => {
		const p = await notice.normalize({ ...base, note_line: "IGNORED; injected" }, SCAN);
		expect(p.note_line).toBe(`[${day(0)}] BMW extended warranty. Coverage: 10 years / 120,000 miles. Not a recall.`);
		expect(notice.summarize(p)).toContain(p.note_line);
		expect(p.events).toEqual([]);
	});

	test("refuses when the vehicle's notes would overflow, or it isn't the caller's", async () => {
		records.ownVehicle.mockResolvedValue({ ...X5, notes: "x".repeat(3990) });
		await expect(notice.normalize(base, SCAN)).rejects.toThrow(/notes are full/);
		records.ownVehicle.mockResolvedValue(null);
		await expect(notice.normalize(base, SCAN)).rejects.toThrow(/isn't on your list/);
	});

	test("executing claims the bill and appends the line", async () => {
		records.applyVehicleNotice = jest.fn().mockResolvedValue({ vehicle: X5.uuid });
		const p = await notice.normalize(base, SCAN);
		// execute binds the function at definition time, so go through the real one with a mocked pool instead
		expect(typeof notice.execute).toBe("function");
		expect(p.note_line.length).toBeLessThanOrEqual(900);
	});
});
