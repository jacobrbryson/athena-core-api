/**
 * Phase 3 (2026-10-10): reminders with a time, and place reminders that wait
 * for something first — "when I get home from the gym, remind me to shower",
 * "when we get home after the last game, remind me to tell Ashlyn…".
 */
jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./location", () => ({ getPref: jest.fn(), recordSample: jest.fn() }));
jest.mock("./pulsepoint/watch", () => ({ listPlaces: jest.fn() }));
jest.mock("./pulsepoint/geocode", () => ({ lookup: jest.fn() }));
jest.mock("./push", () => ({ deliverNudge: jest.fn() }));
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
const push = require("./push");
const placeReminders = require("./placeReminders");
const timeReminders = require("./timeReminders");
const registry = require("./actions/registry");

const HOME = { uuid: "p-home", name: "The Bryson house", kind: "home", address: "1 MAIN ST, WESTLAKE, OH", latitude: 41.45, longitude: -81.9, enabled: true };
const GYM = { uuid: "p-gym", name: "Planet Fitness", kind: "other", address: "9 GYM RD, WESTLAKE, OH", latitude: 41.47, longitude: -81.95, enabled: true };
const HOUR = 3600_000;

beforeEach(() => {
	jest.resetAllMocks();
	watch.listPlaces.mockResolvedValue([HOME, GYM]);
	location.getPref.mockResolvedValue({ enabled: true });
	location.recordSample.mockResolvedValue({ accepted: true });
	push.deliverNudge.mockResolvedValue({ sent: 1 });
});

describe("remind_at_place with a condition", () => {
	const action = registry.get("remind_at_place");

	it('"home" means their home point of interest, whatever it is called', async () => {
		const p = await action.normalize({ place: "home", reminder: "Shower" }, { profileId: 1 });
		expect(p).toMatchObject({ place_uuid: "p-home", place_name: "The Bryson house" });
	});

	it("home from the gym: a place condition with a window, and a card that says both", async () => {
		const p = await action.normalize(
			{ place: "home", reminder: "Shower", after_place: "Planet Fitness", after_label: "the gym", within_hours: 4 },
			{ profileId: 1 }
		);
		expect(p.after).toMatchObject({ kind: "place", label: "the gym", latitude: 41.47, longitude: -81.95 });
		const window = new Date(p.after.expires_at).getTime() - Date.now();
		expect(window).toBeGreaterThan(3.9 * HOUR);
		expect(window).toBeLessThan(4.1 * HOUR);
		expect(action.summarize(p)).toMatch(/^When you get to The Bryson house .* after you've been at the gym, remind you: "Shower"\. If that hasn't happened by .*, I'll ask you about it\. I'll watch for you at the gym too\.$/);
	});

	it("home after the last game: a time condition from the calendar event's end", async () => {
		const end = new Date(Date.now() + 5 * HOUR).toISOString();
		const p = await action.normalize(
			{ place: "home", reminder: "Tell Ashlyn to text her brother", after_time: end, after_label: "the last soccer game" },
			{ profileId: 1 }
		);
		expect(p.after).toMatchObject({ kind: "time", label: "the last soccer game", at: end });
		expect(new Date(p.after.expires_at).getTime()).toBe(new Date(end).getTime() + 12 * HOUR);
	});

	it("refuses what it can't vouch for: both kinds, an unknown first place, every_visit, a far-off time", async () => {
		const base = { place: "home", reminder: "x" };
		await expect(action.normalize({ ...base, after_place: "Planet Fitness", after_time: new Date().toISOString() }, { profileId: 1 })).rejects.toThrow(/place or a time, not both/);
		await expect(action.normalize({ ...base, after_place: "Somewhere" }, { profileId: 1 })).rejects.toThrow(/not one of their points of interest/);
		await expect(action.normalize({ ...base, after_place: "Planet Fitness", repeats: "every_visit" }, { profileId: 1 })).rejects.toThrow(/fires once/);
		await expect(action.normalize({ ...base, after_time: new Date(Date.now() + 30 * 24 * HOUR).toISOString() }, { profileId: 1 })).rejects.toThrow(/at most a week/);
		await expect(action.normalize({ ...base, after_time: "2026-10-10T18:00:00" }, { profileId: 1 })).rejects.toThrow(/offset or a time_zone/);
	});

	it("caps the window at 48 hours", async () => {
		const p = await action.normalize({ place: "home", reminder: "x", after_place: "Planet Fitness", within_hours: 500 }, { profileId: 1 });
		expect(new Date(p.after.expires_at).getTime() - Date.now()).toBeLessThan(48.1 * HOUR);
	});
});

describe("arrivals with a condition", () => {
	const at = (point) => ({ latitude: point.latitude, longitude: point.longitude, accuracy_m: 20, observed_at: new Date().toISOString() });
	const later = new Date(Date.now() + 4 * HOUR);
	const WAITING_GYM = {
		id: 9, uuid: "r-gym", profile_id: 1, place_name: HOME.name, latitude: String(HOME.latitude), longitude: String(HOME.longitude),
		radius_m: 300, text: "Shower", repeats: 0, status: "waiting", fire_count: 0, last_fired_at: null,
		after_kind: "place", after_label: "the gym", after_latitude: String(GYM.latitude), after_longitude: String(GYM.longitude),
		after_at: null, expires_at: later,
	};
	function mockDb(rows) {
		db.query.mockImplementation(async (sql) => {
			if (/SELECT \* FROM athena_place_reminder/.test(sql)) return [rows];
			return [{ affectedRows: 1 }];
		});
	}
	const call = (pattern) => db.query.mock.calls.find(([sql]) => pattern.test(sql));

	it("home before the gym: nothing fires", async () => {
		mockDb([WAITING_GYM]);
		const out = await placeReminders.arrived(1, 3, at(HOME));
		expect(out.fired).toEqual([]);
		expect(push.deliverNudge).not.toHaveBeenCalled();
	});

	it("at the gym: the condition is met, nothing is said, and the window becomes 12 hours", async () => {
		mockDb([WAITING_GYM]);
		const out = await placeReminders.arrived(1, 3, at(GYM));
		expect(out).toEqual({ fired: [], met: [{ uuid: "r-gym" }] });
		expect(push.deliverNudge).not.toHaveBeenCalled();
		const [sql, params] = call(/SET status = 'armed', condition_met_at/);
		expect(sql).toContain("status = 'waiting'");
		expect(new Date(params[1]).getTime() - Date.now()).toBeGreaterThan(11.9 * HOUR);
	});

	it("home after the gym: it fires", async () => {
		mockDb([{ ...WAITING_GYM, status: "armed", condition_met_at: new Date() }]);
		const out = await placeReminders.arrived(1, 3, at(HOME));
		expect(out.fired).toEqual([{ uuid: "r-gym", pushed: true }]);
	});

	it("after the last game: home before it ends does nothing, home after it fires", async () => {
		const AFTER_GAME = { ...WAITING_GYM, uuid: "r-game", after_kind: "time", after_latitude: null, after_longitude: null, after_label: "the last game" };
		mockDb([{ ...AFTER_GAME, after_at: new Date(Date.now() + HOUR) }]);
		expect((await placeReminders.arrived(1, 3, at(HOME))).fired).toEqual([]);

		mockDb([{ ...AFTER_GAME, after_at: new Date(Date.now() - HOUR) }]);
		expect((await placeReminders.arrived(1, 3, at(HOME))).fired).toEqual([{ uuid: "r-game", pushed: true }]);
		expect(call(/SET status = 'armed', condition_met_at = \? WHERE id = \? AND status = 'waiting'/)).toBeTruthy();
	});

	it("past its window it never fires late — the sweep asks instead", async () => {
		mockDb([{ ...WAITING_GYM, status: "armed", expires_at: new Date(Date.now() - 1000) }]);
		expect((await placeReminders.arrived(1, 3, at(HOME))).fired).toEqual([]);
	});

	it("the phone holds the gym's fence too while the condition is unmet", async () => {
		db.query.mockResolvedValue([[{ ...WAITING_GYM }]]);
		const { fences } = await placeReminders.geofences(1);
		expect(fences.map((f) => f.id)).toEqual(["r-gym", "r-gym:after"]);
		db.query.mockResolvedValue([[{ ...WAITING_GYM, status: "armed" }]]);
		expect((await placeReminders.geofences(1)).fences.map((f) => f.id)).toEqual(["r-gym"]);
	});
});

describe("expireDue", () => {
	it("asks once whether they still want it, never drops it silently", async () => {
		const row = { id: 9, uuid: "r-gym", profile_id: 1, place_name: "home", text: "Shower", status: "waiting", after_label: "the gym" };
		db.query.mockImplementation(async (sql) => (/^\s*SELECT/.test(sql) ? [[row]] : [{ affectedRows: 1 }]));
		const out = await placeReminders.expireDue({ now: new Date() });
		expect(out.asked).toBe(1);
		expect(push.deliverNudge).toHaveBeenCalledWith(1, expect.objectContaining({
			text: `I didn't get to remind you to "Shower" — it looks like you didn't make it to the gym. Still want it? Just tell me and I'll set it again.`,
		}));
		const nudge = db.query.mock.calls.find(([sql]) => /INSERT IGNORE INTO athena_nudge/.test(sql));
		expect(nudge[1][3]).toBe("r-gym:expired");
	});

	it("a row another run already expired is not asked about twice", async () => {
		db.query.mockImplementation(async (sql) => (/^\s*SELECT/.test(sql) ? [[{ id: 1, uuid: "x", status: "waiting" }]] : [{ affectedRows: 0 }]));
		expect((await placeReminders.expireDue()).asked).toBe(0);
		expect(push.deliverNudge).not.toHaveBeenCalled();
	});
});

describe("remind_at_time", () => {
	const action = registry.get("remind_at_time");

	it("takes a time with an offset, and says it back", async () => {
		const at = new Date(Date.now() + 26 * HOUR);
		const p = action.normalize({ reminder: "Tell Ashlyn to text her brother", at: at.toISOString() });
		expect(p).toEqual({ reminder: "Tell Ashlyn to text her brother", at: at.toISOString() });
		expect(action.summarize(p)).toMatch(/^At .*, remind you: "Tell Ashlyn to text her brother"$/);
	});

	it("reads an offsetless time in the zone given", async () => {
		const p = action.normalize({ reminder: "x", at: "2027-01-15T19:00:00", time_zone: "America/New_York" });
		expect(p.at).toBe("2027-01-16T00:00:00.000Z"); // 7pm EST = midnight UTC
		const summer = action.normalize({ reminder: "x", at: "2027-07-15T19:00:00", time_zone: "America/New_York" });
		expect(summer.at).toBe("2027-07-15T23:00:00.000Z"); // EDT
	});

	it("refuses the past, a bare time with no zone, and nothing to say", async () => {
		expect(() => action.normalize({ reminder: "x", at: new Date(Date.now() - HOUR).toISOString() })).toThrow(/already passed/);
		expect(() => action.normalize({ reminder: "x", at: "2027-01-15T19:00:00" })).toThrow(/offset or a time_zone/);
		expect(() => action.normalize({ at: new Date(Date.now() + HOUR).toISOString() })).toThrow(/something to remind/);
	});
});

describe("fireDue", () => {
	const due = { id: 4, uuid: "t-1", profile_id: 1, text: "Tell Ashlyn", fire_at: new Date(), time_zone: "America/New_York", status: "armed", attempts: 0 };
	function mockDb({ rows = [due], claim = 1, inserted = 1 } = {}) {
		db.query.mockImplementation(async (sql) => {
			if (/SELECT \* FROM athena_time_reminder/.test(sql)) return [rows];
			if (/SET status = 'firing'/.test(sql)) return [{ affectedRows: claim }];
			if (/INSERT IGNORE INTO athena_nudge/.test(sql)) return [{ affectedRows: inserted }];
			if (/SELECT uuid FROM athena_nudge/.test(sql)) return [[{ uuid: "n-existing" }]];
			return [{ affectedRows: 1 }];
		});
	}
	const call = (pattern) => db.query.mock.calls.find(([sql]) => pattern.test(sql));

	it("claims, writes the card once, pushes, and marks it done", async () => {
		mockDb();
		expect(await timeReminders.fireDue()).toEqual({ fired: 1, retried: 0 });
		expect(push.deliverNudge).toHaveBeenCalledWith(1, expect.objectContaining({ text: "You asked me to remind you: Tell Ashlyn", trigger_id: "time_reminder" }));
		expect(call(/INSERT IGNORE INTO athena_nudge/)[1][3]).toBe("t-1:time");
		expect(call(/SET status = 'done'/)).toBeTruthy();
	});

	it("a row another run claimed is skipped", async () => {
		mockDb({ claim: 0 });
		expect(await timeReminders.fireDue()).toEqual({ fired: 0, retried: 0 });
		expect(push.deliverNudge).not.toHaveBeenCalled();
	});

	it("no push: back to armed for the next run, re-pushing the same card", async () => {
		mockDb({ inserted: 0 });
		push.deliverNudge.mockResolvedValue({ sent: 0 });
		expect(await timeReminders.fireDue()).toEqual({ fired: 0, retried: 1 });
		expect(push.deliverNudge.mock.calls[0][1].uuid).toBe("n-existing");
		expect(call(/SET status = 'armed', attempts = \?/)[1][0]).toBe(1);
	});

	it("after the last attempt it is done; the card stays in the app", async () => {
		mockDb({ rows: [{ ...due, attempts: timeReminders.MAX_ATTEMPTS - 1 }] });
		push.deliverNudge.mockResolvedValue({ sent: 0 });
		expect(await timeReminders.fireDue()).toEqual({ fired: 1, retried: 0 });
	});

	it("compares times from the app, never the database's clock", async () => {
		mockDb({ rows: [] });
		const now = new Date("2026-10-11T23:00:00Z");
		await timeReminders.fireDue({ now });
		const select = call(/SELECT \* FROM athena_time_reminder/);
		expect(select[0]).not.toMatch(/NOW\(\)/);
		expect(select[1][0]).toBe(now);
	});
});
