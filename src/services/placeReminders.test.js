jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./location", () => ({ getPref: jest.fn(), recordSample: jest.fn() }));
jest.mock("./pulsepoint/watch", () => ({ listPlaces: jest.fn() }));
jest.mock("./pulsepoint/geocode", () => ({ lookup: jest.fn() }));
jest.mock("./push", () => ({ deliverNudge: jest.fn() }));
// The registry's other actions' writers, which this suite never reaches.
jest.mock("./connectors/googleCalendar", () => ({}));
jest.mock("./connectors/gmail", () => ({}));
jest.mock("./emailTriage", () => ({}));
jest.mock("./memory", () => ({ CATEGORIES: new Set(["preference"]) }));
jest.mock("./lookRequests", () => ({}));
jest.mock("./unsubscribe", () => ({}));
jest.mock("./emailDraft", () => ({ MAX_BODY: 4000 }));

const db = require("../helpers/db");
const location = require("./location");
const watch = require("./pulsepoint/watch");
const geocode = require("./pulsepoint/geocode");
const push = require("./push");
const placeReminders = require("./placeReminders");
const registry = require("./actions/registry");

const MISSY = {
	uuid: "p-missy", name: "Missy's", kind: "family", address: "412 OAK ST, TROUTMAN, NC, 28166",
	latitude: 35.7001, longitude: -80.8802, radiusMiles: 1, enabled: true,
};
const ARMED = {
	id: 7, uuid: "r-1", profile_id: 1, place_uuid: "p-missy", place_name: "Missy's", address: MISSY.address,
	latitude: "35.700100", longitude: "-80.880200", radius_m: 150, text: "Bring back her casserole dish",
	repeats: 0, status: "armed", fire_count: 0, last_fired_at: null,
};

beforeEach(() => {
	jest.resetAllMocks();
	watch.listPlaces.mockResolvedValue([MISSY]);
	location.getPref.mockResolvedValue({ enabled: true });
	location.recordSample.mockResolvedValue({ accepted: true });
});

describe("remind_at_place normalize", () => {
	const action = registry.get("remind_at_place");

	it("resolves a point of interest by name, ignoring case and apostrophes", async () => {
		const p = await action.normalize({ place: "missys", reminder: "Bring back her casserole dish" }, { profileId: 1 });
		expect(p).toMatchObject({ place_uuid: "p-missy", place_name: "Missy's", latitude: 35.7001, repeats: "next_visit" });
		expect(action.summarize(p)).toBe(`Next time you get to Missy's (${MISSY.address}), remind you: "Bring back her casserole dish"`);
	});

	it("geocodes an address when the place is not a point of interest, and shows what it found", async () => {
		geocode.lookup.mockResolvedValue([{ label: "9 ELM ST, MOORESVILLE, NC, 28115", latitude: 35.58, longitude: -80.81 }]);
		const p = await action.normalize(
			{ place: "Dana's", address: "9 Elm St Mooresville NC", reminder: "Return the drill", repeats: "every_visit" },
			{ profileId: 1 }
		);
		expect(p).toMatchObject({ place_uuid: null, place_name: "Dana's", address: "9 ELM ST, MOORESVILLE, NC, 28115", repeats: "every_visit" });
		expect(action.summarize(p)).toMatch(/^Every time you get to Dana's/);
	});

	it("refuses a place it cannot vouch for rather than guessing a point", async () => {
		await expect(action.normalize({ place: "Somewhere", reminder: "x" }, { profileId: 1 })).rejects.toThrow(/not one of their points of interest/);
		geocode.lookup.mockResolvedValue([]);
		await expect(action.normalize({ address: "1 Nowhere Rd", reminder: "x" }, { profileId: 1 })).rejects.toThrow(/could not be found/);
	});

	it("never takes coordinates from the model", async () => {
		const p = await action.normalize({ place: "Missy's", reminder: "x", latitude: 1, longitude: 2 }, { profileId: 1 });
		expect(p.latitude).toBe(35.7001);
		expect(p.longitude).toBe(-80.8802);
	});

	it("needs words to remind, a known repeat, and a person", async () => {
		await expect(action.normalize({ place: "Missy's" }, { profileId: 1 })).rejects.toThrow(/something to remind/);
		await expect(action.normalize({ place: "Missy's", reminder: "x", repeats: "daily" }, { profileId: 1 })).rejects.toThrow(/Repeats/);
		await expect(action.normalize({ place: "Missy's", reminder: "x" }, {})).rejects.toThrow(/needs a person/);
	});
});

describe("arrived", () => {
	const fresh = (over = {}) => ({ latitude: 35.7003, longitude: -80.8801, accuracy_m: 20, observed_at: new Date().toISOString(), ...over });

	function mockDb({ rows = [ARMED], claim = 1 } = {}) {
		db.query.mockImplementation(async (sql) => {
			if (/SELECT \* FROM athena_place_reminder/.test(sql)) return [rows];
			if (/SET fire_count/.test(sql)) return [{ affectedRows: claim }];
			return [{ affectedRows: 1 }];
		});
	}
	const ran = (pattern) => db.query.mock.calls.some(([sql]) => pattern.test(sql));

	it("fires when the phone is inside the fence, and marks a next-visit reminder done once pushed", async () => {
		mockDb();
		push.deliverNudge.mockResolvedValue({ sent: 1 });
		const out = await placeReminders.arrived(1, 3, fresh());
		expect(out.fired).toEqual([{ uuid: "r-1", pushed: true }]);
		expect(push.deliverNudge).toHaveBeenCalledWith(1, expect.objectContaining({
			text: "You're at Missy's — you asked me to remind you: Bring back her casserole dish",
			trigger_id: "place_reminder",
		}));
		expect(ran(/SET status = 'done'/)).toBe(true);
	});

	it("keeps a next-visit reminder armed when no push got through; it waits in the app instead", async () => {
		mockDb();
		push.deliverNudge.mockResolvedValue({ sent: 0, skipped: "not enabled" });
		const out = await placeReminders.arrived(1, 3, fresh());
		expect(out.fired).toEqual([{ uuid: "r-1", pushed: false }]);
		expect(ran(/INSERT IGNORE INTO athena_nudge/)).toBe(true);
		expect(ran(/SET status = 'done'/)).toBe(false);
	});

	it("never marks an every-visit reminder done", async () => {
		mockDb({ rows: [{ ...ARMED, repeats: 1 }] });
		push.deliverNudge.mockResolvedValue({ sent: 1 });
		await placeReminders.arrived(1, 3, fresh());
		expect(ran(/SET status = 'done'/)).toBe(false);
	});

	it("checks the distance itself rather than trusting the phone's fence", async () => {
		mockDb();
		const out = await placeReminders.arrived(1, 3, fresh({ latitude: 35.72 }));
		expect(out.fired).toEqual([]);
		expect(push.deliverNudge).not.toHaveBeenCalled();
	});

	it("says nothing twice in one visit", async () => {
		mockDb({ claim: 0 });
		const out = await placeReminders.arrived(1, 3, fresh());
		expect(out.fired).toEqual([]);
		expect(push.deliverNudge).not.toHaveBeenCalled();
	});

	it("ignores a stale position", async () => {
		mockDb();
		const out = await placeReminders.arrived(1, 3, fresh({ observed_at: new Date(Date.now() - 60 * 60_000).toISOString() }));
		expect(out.skipped).toBe("stale position");
		expect(push.deliverNudge).not.toHaveBeenCalled();
	});

	it("refuses entirely while location sharing is off", async () => {
		location.recordSample.mockRejectedValue(Object.assign(new Error("Location sharing is not enabled"), { status: 403 }));
		await expect(placeReminders.arrived(1, 3, fresh())).rejects.toThrow(/not enabled/);
		expect(push.deliverNudge).not.toHaveBeenCalled();
	});
});

describe("geofences", () => {
	it("hands the phone nothing while location sharing is off", async () => {
		location.getPref.mockResolvedValue({ enabled: false });
		expect(await placeReminders.geofences(1)).toEqual({ enabled: false, fences: [] });
		expect(db.query).not.toHaveBeenCalled();
	});

	it("lists armed reminders as fences", async () => {
		db.query.mockResolvedValue([[{ uuid: "r-1", latitude: "35.700100", longitude: "-80.880200", radius_m: 150 }]]);
		expect(await placeReminders.geofences(1)).toEqual({
			enabled: true,
			fences: [{ id: "r-1", latitude: 35.7001, longitude: -80.8802, radius_m: 150 }],
		});
	});
});

describe("promptBlock", () => {
	it("tells her a reminder cannot fire while location sharing is off", async () => {
		location.getPref.mockResolvedValue({ enabled: false });
		db.query.mockResolvedValue([[]]);
		expect(await placeReminders.promptBlock(1)).toMatch(/Location sharing is OFF/);
	});

	it("lists what is armed", async () => {
		db.query.mockResolvedValue([[{ place_name: "Missy's", address: null, text: "Bring the dish", repeats: 0 }]]);
		const block = await placeReminders.promptBlock(1);
		expect(block).toContain(`At Missy's: "Bring the dish" — next visit only`);
		expect(block).not.toMatch(/OFF/);
	});
});
