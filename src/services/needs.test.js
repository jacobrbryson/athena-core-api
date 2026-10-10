jest.mock("./llm", () => ({ decide: jest.fn() }));
jest.mock("./llm/adapters/jev", () => ({ configured: jest.fn(async () => true) }));
jest.mock("./connectors/context", () => ({ linkedProviders: jest.fn(), buildContext: jest.fn() }));
jest.mock("./heartRate", () => ({ getPref: jest.fn(), buildContext: jest.fn() }));
jest.mock("./webSearch", () => ({ buildContext: jest.fn() }));
jest.mock("./weather", () => ({ forecast: jest.fn() }));
jest.mock("./travel", () => ({ homeOf: jest.fn(), locate: jest.fn() }));
jest.mock("./family", () => ({ getFamilyForProfile: jest.fn(), listChildren: jest.fn() }));

const llm = require("./llm");
const jev = require("./llm/adapters/jev");
const connectorContext = require("./connectors/context");
const heartRate = require("./heartRate");
const webSearch = require("./webSearch");
const weather = require("./weather");
const travel = require("./travel");
const family = require("./family");
const needs = require("./needs");
const { NEEDS_SCHEMA, SOURCE_IDS } = require("./needsSchema");

const PROFILE = 42;
const ALL = ["calendar", "email", "whoop", "heart_rate", "weather", "web"];

beforeEach(() => {
	jest.clearAllMocks();
	connectorContext.linkedProviders.mockResolvedValue(new Set(["google_calendar"]));
	heartRate.getPref.mockResolvedValue({ enabled: false });
	family.getFamilyForProfile.mockResolvedValue({ id: 7 });
	family.listChildren.mockResolvedValue([{ display_name: "Ashlyn Bryson" }]);
	llm.decide.mockResolvedValue({ answers: { private: { noul: 0.05 } } });
	jest.spyOn(console, "warn").mockImplementation(() => {});
	jest.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test("the schema and the source list agree", () => {
	expect(NEEDS_SCHEMA.items.properties.source.enum).toEqual(SOURCE_IDS);
	expect(needs.SOURCES.map((s) => s.id)).toEqual(SOURCE_IDS);
});

describe("available", () => {
	test("only what they connected, plus weather and web", async () => {
		expect(await needs.available(PROFILE, { audience: "adult" })).toEqual(["calendar", "weather", "web"]);
	});

	test("live heart rate only when switched on", async () => {
		heartRate.getPref.mockResolvedValue({ enabled: true });
		expect(await needs.available(PROFILE, { audience: "adult" })).toContain("heart_rate");
	});

	test("never for a child, or without a profile", async () => {
		expect(await needs.available(PROFILE, { audience: "child" })).toEqual([]);
		expect(await needs.available(null, { audience: "adult" })).toEqual([]);
	});

	test("an unreadable link list offers no connectors, not all of them", async () => {
		connectorContext.linkedProviders.mockRejectedValue(new Error("db down"));
		expect(await needs.available(PROFILE, { audience: "adult" })).toEqual(["weather", "web"]);
	});
});

describe("promptBlock", () => {
	test("names only what is available, calendar before the web", () => {
		const block = needs.promptBlock(["calendar", "weather", "web"]);
		expect(block).toMatch(/source": "calendar"/);
		expect(block).not.toMatch(/source": "email"/);
		expect(block).toMatch(/calendar first/);
		expect(block).toMatch(/NEVER a family member/);
	});

	test("the final round tells her to answer", () => {
		expect(needs.promptBlock(["web"], { final: true })).toMatch(/Answer now/);
		expect(needs.promptBlock([])).toBeNull();
	});
});

describe("clean", () => {
	test("drops unknown, unavailable and already-read needs, and caps the round", () => {
		const out = needs.clean(
			[
				{ source: "email" },
				{ source: "nope" },
				{ source: "calendar", range: "forever" },
				{ source: "calendar", range: "this_week" },
				{ source: "web", query: "" },
				{ source: "weather" },
				{ source: "web", query: "a" },
				{ source: "web", query: "b" },
			],
			["calendar", "weather", "web"]
		);
		expect(out).toEqual([
			{ source: "calendar", range: "this_week" },
			{ source: "weather", place: "home", when: null },
			{ source: "web", query: "a" },
		]);
		const done = new Set(out.map(needs.keyOf));
		expect(needs.clean([{ source: "calendar", range: "this_week" }], ALL, done)).toEqual([]);
		expect(needs.clean("not a list", ALL)).toEqual([]);
	});
});

describe("fetch", () => {
	test("calendar reads only the calendar, for the asked range", async () => {
		connectorContext.buildContext.mockResolvedValue("# Calendar\n5:30 U10 soccer @ Clague Park");
		const out = await needs.fetch(PROFILE, [{ source: "calendar", range: "today" }], { audience: "adult" });
		expect(connectorContext.buildContext).toHaveBeenCalledWith(
			PROFILE,
			expect.objectContaining({ providers: ["google_calendar"], daysByProvider: { google_calendar: 1 }, message: "" })
		);
		expect(out.blocks[0]).toContain("Clague Park");
	});

	test("weather at an event's place and time, from NWS", async () => {
		travel.locate.mockResolvedValue({ name: "Clague Park", address: "Westlake, OH", latitude: 41.45, longitude: -81.9 });
		weather.forecast.mockResolvedValue({
			hours: [{ start: "2026-10-10T17:00:00-04:00", temperatureF: 58, shortForecast: "Chance Rain Showers", precipitationChance: 40, windSpeed: "10 mph" }],
		});
		const when = "2026-10-10T17:30:00-04:00";
		const out = await needs.fetch(PROFILE, [{ source: "weather", place: "Clague Park", when }], { audience: "adult", timeZone: "America/New_York" });
		expect(travel.locate).toHaveBeenCalledWith(PROFILE, "Clague Park");
		expect(weather.forecast).toHaveBeenCalledWith(41.45, -81.9, { hours: 4, from: when });
		expect(out.blocks[0]).toMatch(/Clague Park.*\n- .*58°F, Chance Rain Showers, 40% chance of rain/);
	});

	test("weather at home uses the saved home; a missing place says so instead of guessing", async () => {
		travel.homeOf.mockResolvedValue(null);
		const out = await needs.fetch(PROFILE, [{ source: "weather", place: "home", when: null }], { audience: "adult" });
		expect(travel.locate).not.toHaveBeenCalled();
		expect(out.blocks[0]).toMatch(/no home saved.*don't guess/s);
	});

	test("her own web query goes out when it's only places and times", async () => {
		webSearch.buildContext.mockResolvedValue({ block: "# From the web\n...", sources: [{ title: "nws", url: "u" }] });
		const out = await needs.fetch(PROFILE, [{ source: "web", query: "Westlake OH fall festival hours" }], { audience: "adult" });
		expect(webSearch.buildContext).toHaveBeenCalledWith("Westlake OH fall festival hours", { audience: "adult" });
		expect(out.sources).toHaveLength(1);
	});

	test("a query naming their child never leaves, without even asking Jev", async () => {
		const out = await needs.fetch(PROFILE, [{ source: "web", query: "ashlyn soccer schedule" }], { audience: "adult" });
		expect(webSearch.buildContext).not.toHaveBeenCalled();
		expect(llm.decide).not.toHaveBeenCalled();
		expect(out.blocks[0]).toMatch(/wasn't sent/);
	});

	test("a query Jev calls private is held back, and so is every query without Jev", async () => {
		llm.decide.mockResolvedValue({ answers: { private: { noul: 0.9 } } });
		await needs.fetch(PROFILE, [{ source: "web", query: "John Smith diabetes" }], { audience: "adult" });
		jev.configured.mockResolvedValueOnce(false);
		await needs.fetch(PROFILE, [{ source: "web", query: "weather Westlake" }], { audience: "adult" });
		expect(webSearch.buildContext).not.toHaveBeenCalled();
	});

	test("nothing is read for a child", async () => {
		const out = await needs.fetch(PROFILE, [{ source: "calendar", range: "today" }], { audience: "child" });
		expect(out.blocks).toEqual([]);
		expect(connectorContext.buildContext).not.toHaveBeenCalled();
	});

	test("a read that throws becomes a block saying so", async () => {
		connectorContext.buildContext.mockRejectedValue(new Error("boom"));
		const out = await needs.fetch(PROFILE, [{ source: "calendar", range: "today" }], { audience: "adult" });
		expect(out.blocks[0]).toMatch(/failed just now.*don't guess/s);
	});
});
