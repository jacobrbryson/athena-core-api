/**
 * Bill scan: a photographed vehicle registration or property tax bill becomes
 * ONE proposal, and nothing the model wasn't sure of is guessed. The vision
 * reads below are synthetic, shaped like what the model is asked to return.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./llm", () => ({ generateJson: jest.fn() }));
jest.mock("./credentials", () => ({ list: jest.fn() }));
jest.mock("./actions", () => ({ attempt: jest.fn() }));
jest.mock("./billRecords", () => ({
	...jest.requireActual("./billRecords"),
	vehicles: jest.fn(), properties: jest.fn(), propertyForParcel: jest.fn(), unpaidFor: jest.fn(),
	logRead: jest.fn(), bindFingerprint: jest.fn(), linkAction: jest.fn(),
}));

const llm = require("./llm");
const credentials = require("./credentials");
const actions = require("./actions");
const records = require("./billRecords");
const billScan = require("./billScan");

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const IMAGE = { imageBase64: "x".repeat(200), mimeType: "image/jpeg" };
const X5 = { uuid: "11111111-1111-4111-8111-111111111111", name: "The BMW", year: 2021, make: "BMW", model: "X5", color: "white", plate: "ABC1234", vin: "1M8GDM9AXKP042788", registration_due: day(5) };
const CAMRY = { uuid: "22222222-2222-4222-8222-222222222222", name: "Camry", year: 2016, make: "Toyota", model: "Camry", color: "silver", plate: "ZZZ999", vin: null, registration_due: null };
const HOME = { uuid: "33333333-3333-4333-8333-333333333333", name: "Home", address: "123 Oak Street, Raleigh NC" };
const f = (name, value, confidence = "high") => ({ name, value, confidence });
const card = { uuid: "card-1", action_id: "record_vehicle_bill", status: "pending" };

function vehicleRead(extra = {}) {
	return {
		kind: "vehicle_registration", status: "bill", note: "",
		fields: [f("payee", "NC DMV"), f("jurisdiction", "North Carolina"), f("plate", "abc 1234"), f("registration_expires", day(20)), f("amount_due", "$214.50"), f("tax_amount", "150.25"), f("tax_year", String(new Date().getUTCFullYear()))],
		installments: [], ...extra,
	};
}

beforeEach(() => {
	jest.resetAllMocks();
	credentials.list.mockResolvedValue([{ provider: "google_calendar", status: "active" }]);
	records.vehicles.mockResolvedValue([X5, CAMRY]);
	records.properties.mockResolvedValue([HOME]);
	records.propertyForParcel.mockResolvedValue(null);
	records.unpaidFor.mockResolvedValue([]);
	records.logRead.mockResolvedValue("scan-1");
	records.bindFingerprint.mockResolvedValue({ state: "new" });
	actions.attempt.mockResolvedValue({ proposal: card, rejected: null });
});

describe("validation in code", () => {
	const { parseDay, parseMoney, parseVin } = billScan._test;
	test("dates must be real, full and near today", () => {
		expect(parseDay(day(10), day(0)).value).toBe(day(10));
		expect(parseDay("11/30/2026", day(0)).problem).toMatch(/full date/);
		expect(parseDay("2026-02-31", day(0)).value).toBeNull();
		expect(parseDay(day(2000), day(0)).problem).toMatch(/too far/);
	});
	test("amounts are plain positive numbers with at most cents", () => {
		expect(parseMoney("$1,214.50").value).toBe(1214.5);
		expect(parseMoney("12.345").problem).toBeTruthy();
		expect(parseMoney("0").problem).toBeTruthy();
		expect(parseMoney("").value).toBeNull();
	});
	test("a VIN is checked, and last digits are kept as last digits", () => {
		expect(parseVin(X5.vin)).toEqual({ value: X5.vin });
		expect(parseVin("1M8GDM9A1KP042788").problem).toMatch(/check digit/);
		expect(parseVin("a12345")).toEqual({ value: null, last: "A12345" });
		expect(parseVin("I0O")).toMatchObject({ value: null });
	});
});

describe("matching never guesses", () => {
	const { matchVehicle, matchProperty } = billScan._test;
	test("a plate or VIN picks the one vehicle", () => {
		expect(matchVehicle([X5, CAMRY], { plate: "ABC1234" }).vehicle).toBe(X5);
		expect(matchVehicle([X5, CAMRY], { vin: X5.vin }).vehicle).toBe(X5);
		expect(matchVehicle([X5, CAMRY], { vinLast: "042788" }).vehicle).toBe(X5);
	});
	test("a description matches only when a single vehicle fits", () => {
		expect(matchVehicle([X5, CAMRY], { vehicleDescription: "2021 BMW X5" }).vehicle).toBe(X5);
		const twin = { ...X5, uuid: "44444444-4444-4444-8444-444444444444", name: "Other BMW", plate: "QQQ111", vin: null };
		expect(matchVehicle([X5, twin], { vehicleDescription: "2021 BMW X5" }).ask).toHaveLength(2);
	});
	test("nothing identifying, or a contradicting plate, asks", () => {
		expect(matchVehicle([X5, CAMRY], {}).ask).toHaveLength(2);
		expect(matchVehicle([X5], { plate: "NOPE111", vehicleDescription: "2021 BMW X5" }).ask).toHaveLength(1);
		expect(matchVehicle([], {}).none).toBe(true);
	});
	test("a tax bill needs the property's street number and name, or a parcel already on record", () => {
		expect(matchProperty([HOME], { address: "123 OAK ST RALEIGH" }).property).toBe(HOME);
		expect(matchProperty([HOME], { address: "9 Elm Road" }).ask).toHaveLength(1);
		expect(matchProperty([HOME], {}, HOME.uuid).property).toBe(HOME);
	});
});

describe("a registration renewal", () => {
	test("is read by the adult vision task and proposed as ONE card with the dates read from the bill", async () => {
		llm.generateJson.mockResolvedValue({ data: vehicleRead() });
		const r = await billScan.scan(42, { ...IMAGE, today: day(0) });
		const call = llm.generateJson.mock.calls[0][0];
		expect(call).toMatchObject({ task: "vision", audience: "adult" });
		expect(r.status).toBe("proposed");
		expect(r.proposal).toBe(card);
		expect(r.target).toMatchObject({ type: "vehicle", uuid: X5.uuid });
		expect(actions.attempt).toHaveBeenCalledTimes(1);
		const [profileId, session, raw, ctx] = actions.attempt.mock.calls[0];
		expect(profileId).toBe(42);
		expect(session).toBeNull();
		expect(ctx).toEqual({ billScan: true });
		expect(raw.id).toBe("record_vehicle_bill");
		expect(raw.params).toMatchObject({
			vehicle_uuid: X5.uuid, registration_due: day(20), paid: false, amount: 214.5, calendar: true, remind_days: 14,
			tax: { amount: 150.25, due_on: day(20) },
		});
		expect(raw.params.bill_fp).toMatch(/^[a-f0-9]{64}$/);
		expect(records.linkAction).toHaveBeenCalledWith(42, raw.params.bill_fp, "card-1");
	});

	test("the image is never stored — only the read fields are logged", async () => {
		llm.generateJson.mockResolvedValue({ data: vehicleRead() });
		await billScan.scan(42, { ...IMAGE, today: day(0) });
		expect(JSON.stringify(records.logRead.mock.calls)).not.toContain("xxxxxxxx");
		expect(records.logRead.mock.calls[0][1]).toBe("vehicle_registration");
	});

	test("anything the reader was unsure of goes back to the person; nothing is proposed", async () => {
		llm.generateJson.mockResolvedValue({ data: vehicleRead({ fields: [f("plate", "ABC1234"), f("registration_expires", day(20), "low"), f("amount_due", "214.50")] }) });
		const r = await billScan.scan(42, { ...IMAGE, today: day(0) });
		expect(r.status).toBe("needs_input");
		expect(r.document.uncertain.map((u) => u.field)).toEqual(["dueDate"]);
		expect(actions.attempt).not.toHaveBeenCalled();
	});

	test("a value that fails validation is flagged and not used, even at high confidence", async () => {
		llm.generateJson.mockResolvedValue({ data: vehicleRead({ fields: [f("plate", "ABC1234"), f("registration_expires", "11/30/2026"), f("amount_due", "214.50")] }) });
		const r = await billScan.scan(42, { ...IMAGE, today: day(0) });
		expect(r.status).toBe("needs_input");
		expect(r.document.dueDate).toBeUndefined();
		expect(r.document.uncertain[0].reason).toMatch(/full date/);
	});

	test("a bill that matches no single vehicle asks which, listing the candidates", async () => {
		llm.generateJson.mockResolvedValue({ data: vehicleRead({ fields: [f("plate", "NOMATCH1"), f("registration_expires", day(20))] }) });
		const r = await billScan.scan(42, { ...IMAGE, today: day(0) });
		expect(r.status).toBe("needs_input");
		expect(r.candidates.type).toBe("vehicle");
		expect(r.candidates.items.map((i) => i.uuid)).toEqual(expect.arrayContaining([X5.uuid, CAMRY.uuid]));
		expect(actions.attempt).not.toHaveBeenCalled();
	});

	test("scanning the same bill twice does not propose again once it has been recorded", async () => {
		llm.generateJson.mockResolvedValue({ data: vehicleRead() });
		records.bindFingerprint.mockResolvedValue({ state: "applied", appliedOn: day(-1) });
		const r = await billScan.scan(42, { ...IMAGE, today: day(0) });
		expect(r.status).toBe("already_recorded");
		expect(r.note).toMatch(/changed nothing/);
		expect(actions.attempt).not.toHaveBeenCalled();
	});

	test("the same bill hashes the same however the model words it", async () => {
		llm.generateJson.mockResolvedValueOnce({ data: vehicleRead() });
		llm.generateJson.mockResolvedValueOnce({ data: vehicleRead({ fields: vehicleRead().fields.map((x) => (x.name === "payee" ? f("payee", "North Carolina Division of Motor Vehicles") : x)) }) });
		await billScan.scan(42, { ...IMAGE, today: day(0) });
		await billScan.scan(42, { ...IMAGE, today: day(0) });
		expect(actions.attempt.mock.calls[0][2].params.bill_fp).toBe(actions.attempt.mock.calls[1][2].params.bill_fp);
	});

	test("a pending card for the same bill is returned, not duplicated", async () => {
		llm.generateJson.mockResolvedValue({ data: vehicleRead() });
		actions.attempt.mockResolvedValue({ proposal: null, rejected: null, repeat: card });
		const r = await billScan.scan(42, { ...IMAGE, today: day(0) });
		expect(r).toMatchObject({ status: "proposed", repeated: true, proposal: card });
	});

	test("without a calendar the card says so rather than promising an event", async () => {
		credentials.list.mockResolvedValue([]);
		llm.generateJson.mockResolvedValue({ data: vehicleRead() });
		await billScan.scan(42, { ...IMAGE, today: day(0) });
		expect(actions.attempt.mock.calls[0][2].params).toMatchObject({ calendar: false, remind_days: 0 });
	});

	test("turned-off actions are reported, not thrown", async () => {
		llm.generateJson.mockResolvedValue({ data: vehicleRead() });
		actions.attempt.mockResolvedValue({ proposal: null, rejected: { stage: "unavailable", reason: "x" } });
		const r = await billScan.scan(42, { ...IMAGE, today: day(0) });
		expect(r.status).toBe("unavailable");
	});
});

describe("a receipt", () => {
	test("rolls the registration date a year on, as Renewed? does, and adds no calendar event", async () => {
		llm.generateJson.mockResolvedValue({ data: vehicleRead({ status: "receipt", fields: [f("plate", "ABC1234"), f("amount_due", "214.50"), f("paid_on", day(-1))] }) });
		const r = await billScan.scan(42, { ...IMAGE, today: day(0) });
		expect(r.status).toBe("proposed");
		expect(actions.attempt.mock.calls[0][2].params).toMatchObject({ paid: true, registration_due: records.yearAfter(X5.registration_due), calendar: false, paid_on: day(-1) });
	});

	test("with no date to move on and none printed, it asks", async () => {
		records.vehicles.mockResolvedValue([{ ...X5, registration_due: null }]);
		llm.generateJson.mockResolvedValue({ data: vehicleRead({ status: "receipt", fields: [f("plate", "ABC1234")] }) });
		const r = await billScan.scan(42, { ...IMAGE, today: day(0) });
		expect(r.status).toBe("needs_input");
		expect(r.missing[0].field).toBe("dueDate");
	});
});

describe("a property tax bill", () => {
	const taxRead = (extra = {}) => ({
		kind: "property_tax", status: "bill", note: "",
		fields: [f("jurisdiction", "Wake County"), f("parcel", "0123456"), f("address", "123 Oak Street"), f("tax_year", String(new Date().getUTCFullYear())), f("amount_due", "4200")],
		installments: [{ label: "1st half", due_date: day(30), amount: "2100", confidence: "high" }, { label: "2nd half", due_date: day(200), amount: "2100", confidence: "high" }], ...extra,
	});

	test("keeps each installment's own due date and proposes one card", async () => {
		llm.generateJson.mockResolvedValue({ data: taxRead() });
		const r = await billScan.scan(42, { ...IMAGE, today: day(0) });
		expect(r.status).toBe("proposed");
		expect(actions.attempt.mock.calls[0][2].id).toBe("record_property_tax_bill");
		expect(actions.attempt.mock.calls[0][2].params).toMatchObject({
			property_uuid: HOME.uuid, jurisdiction: "Wake County", parcel: "0123456", amount: 4200,
			installments: [{ label: "1st half", due_on: day(30), amount: 2100 }, { label: "2nd half", due_on: day(200), amount: 2100 }],
		});
	});

	test("an address that is not clearly the person's property asks first", async () => {
		llm.generateJson.mockResolvedValue({ data: taxRead({ fields: [f("jurisdiction", "Wake County"), f("address", "9 Elm Road")] }) });
		const r = await billScan.scan(42, { ...IMAGE, today: day(0) });
		expect(r.status).toBe("needs_input");
		expect(r.candidates.type).toBe("property");
	});

	test("a parcel seen before matches the property even without an address", async () => {
		records.propertyForParcel.mockResolvedValue(HOME.uuid);
		llm.generateJson.mockResolvedValue({ data: taxRead({ fields: [f("jurisdiction", "Wake County"), f("parcel", "0123456")] }) });
		expect((await billScan.scan(42, { ...IMAGE, today: day(0) })).status).toBe("proposed");
	});

	test("a receipt that doesn't say which payment it covers offers the unpaid ones", async () => {
		records.unpaidFor.mockResolvedValue([{ uuid: "i1", label: "1st half", dueOn: day(30), amount: 2100 }, { uuid: "i2", label: "2nd half", dueOn: day(200), amount: 2100 }]);
		llm.generateJson.mockResolvedValue({ data: taxRead({ status: "receipt", installments: [] }) });
		const r = await billScan.scan(42, { ...IMAGE, today: day(0) });
		expect(r.status).toBe("needs_input");
		expect(r.installmentChoices).toHaveLength(2);
		const again = await billScan.review(42, { today: day(0), document: r.document, propertyUuid: HOME.uuid, installmentUuid: "i2" });
		expect(again.status).toBe("proposed");
		expect(actions.attempt.mock.calls[0][2].params).toMatchObject({ paid: true, installments: [{ due_on: day(200) }] });
	});
});

describe("not a bill, and the review step", () => {
	test("anything else is left alone", async () => {
		llm.generateJson.mockResolvedValue({ data: { kind: "other", status: "bill", fields: [], installments: [] } });
		expect(await billScan.scan(42, IMAGE)).toEqual({ status: "not_a_bill" });
		expect(records.logRead).not.toHaveBeenCalled();
		expect(await billScan.scanIfBill(42, IMAGE)).toBeNull();
	});

	test("a failed read in chat falls through to the ordinary photo path", async () => {
		llm.generateJson.mockRejectedValue(new Error("vision resting"));
		expect(await billScan.scanIfBill(42, IMAGE)).toBeNull();
	});

	test("a corrected document is trusted as the person's, but still validated and matched against their own rows", async () => {
		const r = await billScan.review(42, {
			today: day(0), vehicleUuid: CAMRY.uuid,
			document: { kind: "vehicle_registration", paid: false, dueDate: day(25), amountDue: "99", plate: "ZZZ999" },
		});
		expect(r.status).toBe("proposed");
		expect(actions.attempt.mock.calls[0][2].params).toMatchObject({ vehicle_uuid: CAMRY.uuid, registration_due: day(25), amount: 99 });
		await expect(billScan.review(42, { today: day(0), vehicleUuid: "99999999-9999-4999-8999-999999999999", document: { kind: "vehicle_registration", dueDate: day(25) } })).rejects.toMatchObject({ status: 404 });
		await expect(billScan.review(42, { document: { kind: "something_else" } })).rejects.toMatchObject({ status: 400 });
	});

	test("images are checked before any model call", async () => {
		await expect(billScan.scan(42, {})).rejects.toMatchObject({ status: 400 });
		await expect(billScan.scan(42, { imageBase64: "x".repeat(200), mimeType: "image/gif" })).rejects.toThrow(/JPEG/);
		expect(llm.generateJson).not.toHaveBeenCalled();
	});
});

describe("the owner's two real bills (2026-10-28), transcribed as a correct read", () => {
	const TODAY = "2026-10-28";
	const HIGHLANDER = { uuid: "55555555-5555-4555-8555-555555555555", name: "Highlander", year: 2014, make: "Toyota", model: "Highlander", color: null, plate: "LMP7696", vin: "5TDYK3DC0ES416119", registration_due: "2026-12-31" };
	const NC_COMBINED = {
		kind: "vehicle_registration", status: "bill", note: "",
		fields: [f("payee", "NCDMV"), f("jurisdiction", "Iredell County, NC"), f("plate", "LMP7696"), f("vin", "5TDYK3DC0ES416119"), f("state", "NC"), f("vehicle_description", "2014 TOYT"),
			f("registration_expires", "2026-12-31"), f("amount_due", "115.43"), f("tax_amount", "69.18"), f("registration_fee", "46.25")],
		installments: [],
	};
	const IREDELL_TAX = {
		kind: "property_tax", status: "bill", note: "",
		fields: [f("payee", "Iredell County Tax Collector"), f("jurisdiction", "Iredell County"), f("parcel", "4730355829.000"), f("account", "80126383"), f("tax_year", "2026"),
			f("address", "148 Rushing Water Ln"), f("amount_due", "3341.02"), f("past_due_after", "2027-01-05"), f("escrowed", "yes")],
		installments: [{ label: "Due", due_date: "2026-09-01", amount: "3341.02", confidence: "high" }],
	};

	test("the combined NC notice: the VIN's check digit holds, so the Highlander matches on VIN and plate, and the tax rides along", async () => {
		records.vehicles.mockResolvedValue([X5, HIGHLANDER]);
		llm.generateJson.mockResolvedValue({ data: NC_COMBINED });
		const r = await billScan.scan(42, { ...IMAGE, today: TODAY });
		expect(r.status).toBe("proposed");
		expect(r.target.uuid).toBe(HIGHLANDER.uuid);
		expect(actions.attempt.mock.calls[0][2].params).toMatchObject({
			registration_due: "2026-12-31", amount: 115.43, calendar: true, tax: { amount: 69.18, tax_year: 2026, due_on: "2026-12-31" },
		});
	});

	test("with only the X5 saved, that bill does not get pinned on the X5", async () => {
		records.vehicles.mockResolvedValue([X5]);
		llm.generateJson.mockResolvedValue({ data: NC_COMBINED });
		const r = await billScan.scan(42, { ...IMAGE, today: TODAY });
		expect(r.status).toBe("needs_input");
		expect(actions.attempt).not.toHaveBeenCalled();
	});

	test("the Iredell tax bill: due 9/1 is not overdue — it is late after 1/5/2027 — and escrow means no calendar event", async () => {
		records.properties.mockResolvedValue([{ uuid: HOME.uuid, name: "Home", address: "148 Rushing Water Ln, Troutman NC 28166" }]);
		llm.generateJson.mockResolvedValue({ data: IREDELL_TAX });
		const r = await billScan.scan(42, { ...IMAGE, today: TODAY });
		expect(r.status).toBe("proposed");
		const p = actions.attempt.mock.calls[0][2].params;
		expect(p).toMatchObject({ jurisdiction: "Iredell County", parcel: "4730355829.000", account: "80126383", tax_year: 2026, amount: 3341.02, escrowed: true, calendar: false });
		expect(p.installments).toEqual([{ label: "Late after (billed due 9/1)", due_on: "2027-01-05", amount: 3341.02 }]);
	});

	test("not escrowed, the same bill would put the 1/5/2027 date on the calendar", async () => {
		records.properties.mockResolvedValue([{ uuid: HOME.uuid, name: "Home", address: "148 Rushing Water Ln" }]);
		llm.generateJson.mockResolvedValue({ data: { ...IREDELL_TAX, fields: IREDELL_TAX.fields.map((x) => (x.name === "escrowed" ? f("escrowed", "no") : x)) } });
		await billScan.scan(42, { ...IMAGE, today: TODAY });
		expect(actions.attempt.mock.calls[0][2].params).toMatchObject({ escrowed: false, calendar: true });
	});
});

describe("a letter about a vehicle (the owner's BMW warranty extension, October 2026)", () => {
	const BMW_X5 = { ...X5, vin: "5UXCR6C55KLL23036" };
	const LETTER = {
		kind: "vehicle_notice", status: "bill", note: "",
		fields: [f("vin", "5UXCR6C55KLL23036"), f("payee", "BMW of North America, LLC"), f("notice_title", "BMW extended warranty: engine oil level software update and oil pump assembly"),
			f("coverage_terms", "10 years / 120,000 miles from original in-service date"), f("notice_summary", "BMW is extending limited warranty coverage for the engine oil level measurement software update and the engine oil pump assembly. It is not a recall. If the issue occurs, book an authorized BMW center; covered work is free.")],
		installments: [],
	};

	test("matches on the VIN, proposes saving it to the vehicle's notes, and puts nothing on the calendar", async () => {
		records.vehicles.mockResolvedValue([BMW_X5, CAMRY]);
		llm.generateJson.mockResolvedValue({ data: LETTER });
		const r = await billScan.scan(42, { ...IMAGE, today: "2026-10-28" });
		expect(r.status).toBe("proposed");
		expect(r.target.uuid).toBe(BMW_X5.uuid);
		const [, , raw] = actions.attempt.mock.calls[0];
		expect(raw.id).toBe("record_vehicle_notice");
		expect(raw.params).toMatchObject({ vehicle_uuid: BMW_X5.uuid, coverage: "10 years / 120,000 miles from original in-service date", notice_on: "2026-10-28" });
		expect(raw.params.calendar).toBeUndefined();
	});

	test("a different wording of the same letter has the same identity", async () => {
		records.vehicles.mockResolvedValue([BMW_X5]);
		llm.generateJson.mockResolvedValueOnce({ data: LETTER });
		llm.generateJson.mockResolvedValueOnce({ data: { ...LETTER, fields: LETTER.fields.map((x) => (x.name === "notice_title" ? f("notice_title", "Extended warranty for oil pump assembly and engine oil level software update (BMW)") : x)) } });
		await billScan.scan(42, { ...IMAGE, today: "2026-10-28" });
		await billScan.scan(42, { ...IMAGE, today: "2026-10-28" });
		expect(actions.attempt.mock.calls[1][2].params.bill_fp).toBe(actions.attempt.mock.calls[0][2].params.bill_fp);
	});

	test("a VIN that matches no saved vehicle asks which; it is never filed under the wrong car", async () => {
		records.vehicles.mockResolvedValue([CAMRY]);
		llm.generateJson.mockResolvedValue({ data: LETTER });
		const r = await billScan.scan(42, { ...IMAGE, today: "2026-10-28" });
		expect(r.status).toBe("needs_input");
		expect(actions.attempt).not.toHaveBeenCalled();
	});
});
