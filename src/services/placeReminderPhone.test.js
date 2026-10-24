// Whether the phone can hold its place fences (placeReminders.phoneStatus and
// friends). Its own suite: placeReminders.test.js loads the action registry.
jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./location", () => ({ getPref: jest.fn(), recordSample: jest.fn() }));
jest.mock("./pulsepoint/watch", () => ({ listPlaces: jest.fn() }));
jest.mock("./pulsepoint/geocode", () => ({ lookup: jest.fn() }));
jest.mock("./reminderWakeups", () => ({ wakeAt: jest.fn() }));

const db = require("../helpers/db");
const location = require("./location");
const placeReminders = require("./placeReminders");

const NOW = Date.parse("2026-10-24T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600_000);
const phoneRow = (over = {}) => ({
	id: 22, name: "Athena Android", last_seen_at: hoursAgo(0.1), state: "ok", fences: 2, detail: null,
	reported_at: hoursAgo(1), synced_at: hoursAgo(0.5), armed: 2, oldest: hoursAgo(48), ...over,
});
const status = (row) => {
	db.query.mockResolvedValueOnce([[row]]);
	return placeReminders.phoneStatus(1, { now: NOW });
};

beforeEach(() => jest.resetAllMocks());

describe("phoneStatus", () => {
	test("a phone that holds its fences and checked in lately has no problem", async () => {
		expect(await status(phoneRow())).toMatchObject({ problem: null, armed: 2, fences: 2 });
	});

	test("what the phone reports wins: a lost background permission is named, with the fix", async () => {
		const r = await status(phoneRow({ state: "no_background_location", fences: 0 }));
		expect(r.problem).toBe("no_background_location");
		expect(r.message).toMatch(/Allow all the time/);
	});

	test("a reported problem is said even with nothing armed, so it's known before the next reminder", async () => {
		expect((await status(phoneRow({ state: "location_off", armed: 0, oldest: null }))).problem).toBe("location_off");
	});

	test("a phone that stopped fetching its fences is noticed — the 10-08 case, an older app that never reports", async () => {
		expect((await status(phoneRow({ state: null, reported_at: null, synced_at: hoursAgo(16 * 24) }))).problem).toBe("not_syncing");
	});

	test("never synced: not_syncing only once a reminder has had an hour to reach the phone", async () => {
		const never = { state: null, reported_at: null, synced_at: null };
		expect((await status(phoneRow({ ...never, oldest: hoursAgo(0.2) }))).problem).toBeNull();
		expect((await status(phoneRow({ ...never, oldest: hoursAgo(3) }))).problem).toBe("not_syncing");
	});

	test("a quiet phone with nothing armed is no problem", async () => {
		expect((await status(phoneRow({ state: null, synced_at: hoursAgo(100), armed: 0, oldest: null }))).problem).toBeNull();
	});

	test("armed reminders and no paired phone", async () => {
		expect((await status({ id: null, armed: 1, oldest: hoursAgo(5) })).problem).toBe("no_phone");
	});

	test("unknown, not a problem, while migration 0094 isn't applied", async () => {
		db.query.mockRejectedValueOnce(Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE" }));
		expect(await placeReminders.phoneStatus(1, { now: NOW })).toBeNull();
	});
});

describe("recordPhoneStatus", () => {
	test("stores a known state and refuses anything else", async () => {
		db.query.mockResolvedValue([{ affectedRows: 1 }]);
		await placeReminders.recordPhoneStatus(1, 22, { state: "register_failed", fences: 3, detail: "status 1004" });
		expect(db.query.mock.calls[0][1]).toEqual([22, 1, "register_failed", 3, "status 1004", "register_failed"]);
		await expect(placeReminders.recordPhoneStatus(1, 22, { state: "drop table" })).rejects.toMatchObject({ status: 400 });
	});
});

describe("geofences notes the fetch", () => {
	test("even with location sharing off", async () => {
		db.query.mockResolvedValue([[]]);
		location.getPref.mockResolvedValue({ enabled: false });
		await placeReminders.geofences(1, 22);
		expect(db.query.mock.calls[0][0]).toMatch(/athena_place_fence_status/);
		expect(db.query.mock.calls[0][1]).toEqual([22, 1]);
	});
});

describe("promptBlock", () => {
	test("tells her the reminders can't fire, in the person's terms", async () => {
		db.query
			.mockResolvedValueOnce([[{ place_name: "Missy LKN", address: null, text: "Pick up the ladder", repeats: 0, status: "armed" }]])
			.mockResolvedValueOnce([[phoneRow({ state: "no_background_location" })]]);
		location.getPref.mockResolvedValue({ enabled: true });
		const block = await placeReminders.promptBlock(1);
		expect(block).toMatch(/PHONE PROBLEM/);
		expect(block).toMatch(/Allow all the time/);
	});

	test("says nothing extra while the phone is fine", async () => {
		db.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[phoneRow({ armed: 0 })]]);
		location.getPref.mockResolvedValue({ enabled: true });
		expect(await placeReminders.promptBlock(1)).toBeNull();
	});
});
