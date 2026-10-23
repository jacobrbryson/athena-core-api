jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./secrets", () => ({ getSecret: jest.fn() }));
jest.mock("./push", () => ({ requestLocation: jest.fn() }));
jest.mock("./pulsepoint/watch", () => ({ listPlaces: jest.fn() }));
jest.mock("./connectors/googleCalendar", () => ({
	collectEvents: jest.fn(),
	displayTimeZone: () => "America/New_York",
}));

const db = require("../helpers/db");
const secrets = require("./secrets");
const watch = require("./pulsepoint/watch");
const googleCalendar = require("./connectors/googleCalendar");
const whereabouts = require("./whereabouts");

const HOME = { name: "Home", kind: "home", latitude: 35.7, longitude: -80.88, radiusMiles: 1, enabled: true };
const FIELD = { latitude: 35.81, longitude: -80.86 };
const NOW = Date.parse("2026-10-20T22:00:00Z");
const GAME = {
	title: "Skylar softball",
	start: "2026-10-20T21:30:00Z",
	end: "2026-10-20T23:00:00Z",
	allDay: false,
	location: "Statesville Softball Complex",
	shared: false,
};

function mockGoogle({ nearby = [{ displayName: { text: "Statesville Softball Complex" }, location: FIELD }], found = FIELD } = {}) {
	global.fetch = jest.fn(async (url) => {
		if (url.includes("searchNearby")) return { ok: true, json: async () => ({ places: nearby }) };
		return {
			ok: true,
			json: async () => ({ places: found ? [{ id: "x", displayName: { text: "Field" }, location: found }] : [] }),
		};
	});
}

beforeEach(() => {
	jest.clearAllMocks();
	secrets.getSecret.mockResolvedValue("test-key");
	watch.listPlaces.mockResolvedValue([HOME]);
	googleCalendar.collectEvents.mockResolvedValue({ events: [GAME], calendars: [] });
	mockGoogle();
});

describe("matches", () => {
	test.each(["Where am I?", "where am i right now", "Where's my phone?", "where is my phone", "find my phone", "what's my location", "where are we"])(
		"%s",
		(message) => expect(whereabouts.matches(message)).toBe(true)
	);
	test.each(["where am I on the leaderboard", "where are we going for dinner", "where is my order", "how far is Target"])(
		"not %s",
		(message) => expect(whereabouts.matches(message)).toBe(false)
	);
});

describe("buildContext", () => {
	test("names the place and matches the calendar event there", async () => {
		const block = await whereabouts.buildContext(1, "Where am I?", { audience: "adult", fix: async () => FIELD, now: NOW });
		expect(block).toMatch(/Statesville Softball Complex/);
		expect(block).toMatch(/Skylar softball.*matches where the phone is/);
		expect(block).toMatch(/looks like they're at "Skylar softball"/);
	});

	test("an event elsewhere is not claimed", async () => {
		mockGoogle({ found: { latitude: 35.2, longitude: -80.8 } });
		const block = await whereabouts.buildContext(1, "Where am I?", { audience: "adult", fix: async () => FIELD, now: NOW });
		expect(block).toMatch(/NOT where the phone is/);
		expect(block).not.toMatch(/looks like they're at/);
	});

	test("at home says home without a Places lookup", async () => {
		googleCalendar.collectEvents.mockResolvedValue({ events: [], calendars: [] });
		const block = await whereabouts.buildContext(1, "where am i", { audience: "adult", fix: async () => ({ latitude: 35.7001, longitude: -80.88 }), now: NOW });
		expect(block).toMatch(/At home/);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	test("falls back to the last position the phone sent, aged", async () => {
		db.query.mockResolvedValue([[{ latitude: "35.81", longitude: "-80.86", accuracy_m: null, age_min: 40 }]]);
		googleCalendar.collectEvents.mockRejectedValue(Object.assign(new Error("no"), { code: "not_connected" }));
		const block = await whereabouts.buildContext(1, "Where's my phone?", { audience: "adult", fix: async () => null, now: NOW });
		expect(block).toMatch(/didn't answer.*40 minutes ago/);
		expect(block).toMatch(/Calendar isn't linked/);
	});

	test("no position at all says what would fix it", async () => {
		db.query.mockResolvedValue([[]]);
		const block = await whereabouts.buildContext(1, "Where am I?", { audience: "adult", fix: async () => null, now: NOW });
		expect(block).toMatch(/location context/);
		expect(googleCalendar.collectEvents).not.toHaveBeenCalled();
	});

	test("children get nothing", async () => {
		const fix = jest.fn();
		expect(await whereabouts.buildContext(1, "Where am I?", { audience: "child", fix })).toBe(null);
		expect(fix).not.toHaveBeenCalled();
	});
});
