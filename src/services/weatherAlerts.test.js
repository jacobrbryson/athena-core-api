jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./pulsepoint/watch", () => ({ listPlaces: jest.fn() }));
jest.mock("./push", () => ({ deliverNudge: jest.fn() }));
jest.mock("./weather", () => {
	const actual = jest.requireActual("./weather");
	return { ...actual, hourlyRows: jest.fn() };
});

const db = require("../helpers/db");
const watch = require("./pulsepoint/watch");
const push = require("./push");
const weather = require("./weather");
const weatherAlerts = require("./weatherAlerts");

const HOME = { uuid: "p-home", name: "Home", kind: "home", latitude: 35.7, longitude: -80.89, enabled: true };

/** An hourly row in EDT, the way weather.hourlyRows returns it. */
const hour = (date, h, extra = {}) => ({
	start: `${date}T${String(h).padStart(2, "0")}:00:00-04:00`,
	temperatureF: 50,
	precipitationChance: 0,
	windMph: 5,
	windDirection: "N",
	shortForecast: "Clear",
	isDaytime: h >= 7 && h < 19,
	...extra,
});
/** Monday 18:00 to Wednesday 12:00 local, with the cold night of Monday into Tuesday. */
function forecast(lows = { "2026-10-19": 31 }) {
	const hours = [];
	for (const [date, from, to] of [["2026-10-19", 18, 23], ["2026-10-20", 0, 23], ["2026-10-21", 0, 12]]) {
		for (let h = from; h <= to; h++) {
			const night = h < 12 ? new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : date;
			const low = lows[night];
			// Coldest at 6 AM, a degree warmer each hour either side.
			const temp = low !== undefined && (h <= 9 || h >= 18) ? low + Math.min(Math.abs(h - 6), Math.abs(h - 30)) : 50;
			hours.push(hour(date, h, { temperatureF: temp }));
		}
	}
	return { place: "Troutman, NC", hours };
}

const RULE = { id: 4, uuid: "a-1", profile_id: 1, kind: "cold", threshold: 34, place_uuid: null, lead_hours: 24, note: "Cover the tomatoes.", enabled: 1 };

beforeEach(() => {
	jest.resetAllMocks();
	watch.listPlaces.mockResolvedValue([HOME]);
	push.deliverNudge.mockResolvedValue({ sent: 1 });
});

describe("occurrences", () => {
	test("one per night for cold, with the coldest hour of it", () => {
		const { hours } = forecast({ "2026-10-19": 31, "2026-10-20": 33 });
		const found = weatherAlerts.occurrences(RULE, hours, { now: Date.parse("2026-10-19T18:00:00-04:00") });
		expect(found.map((o) => [o.key, o.value, o.at])).toEqual([
			["2026-10-19", 31, "2026-10-20T06:00:00-04:00"],
			["2026-10-20", 33, "2026-10-21T06:00:00-04:00"],
		]);
	});

	test("nothing past the lead time, and nothing already over", () => {
		const { hours } = forecast({ "2026-10-19": 31, "2026-10-20": 33 });
		const now = Date.parse("2026-10-20T08:30:00-04:00");
		const found = weatherAlerts.occurrences(RULE, hours, { now, untilMs: now + 6 * 3_600_000 });
		// 8 AM Tuesday is still below 34 and inside the window; Tuesday night is beyond it.
		expect(found.map((o) => o.key)).toEqual(["2026-10-19"]);
	});

	test("wind reads the gust, rain ignores a wintry mix", () => {
		const hours = [hour("2026-10-20", 9, { windMph: 40, precipitationChance: 80, shortForecast: "Freezing Rain" })];
		expect(weatherAlerts.occurrences({ kind: "wind", threshold: 35 }, hours, { now: 0 })).toHaveLength(1);
		expect(weatherAlerts.occurrences({ kind: "rain", threshold: 60 }, hours, { now: 0 })).toHaveLength(0);
		expect(weatherAlerts.occurrences({ kind: "ice", threshold: null }, hours, { now: 0 })).toHaveLength(1);
	});
});

describe("wording", () => {
	test("says freeze at or below 32, frost above, with their own note", () => {
		const occ = { value: 31, at: "2026-10-20T06:00:00-04:00", hour: { temperatureF: 31, windMph: 2, shortForecast: "Clear" } };
		expect(weatherAlerts.wording(RULE, "Home", occ, "2026-10-19T18:00:00-04:00")).toBe("Freeze alert for Home: down to 31°F around 6 AM tomorrow. Cover the tomatoes.");
		const frost = { ...occ, value: 34, hour: { temperatureF: 34, windMph: 2, shortForecast: "Clear" } };
		expect(weatherAlerts.wording({ ...RULE, note: null }, "Home", frost, "2026-10-19T18:00:00-04:00")).toBe(
			"Frost alert for Home: down to 34°F around 6 AM tomorrow — clear and still enough for frost."
		);
	});
});

describe("normalize", () => {
	test("fills a sensible default and refuses nonsense", () => {
		expect(weatherAlerts.normalize({ kind: "cold" })).toMatchObject({ kind: "cold", threshold: 34, leadHours: 24 });
		expect(weatherAlerts.normalize({ kind: "snow", threshold: 99 }).threshold).toBeNull();
		expect(() => weatherAlerts.normalize({ kind: "tornado" })).toThrow(/Pick what to watch/);
		expect(() => weatherAlerts.normalize({ kind: "cold", threshold: 200 })).toThrow(/between/);
		expect(() => weatherAlerts.normalize({ kind: "cold", leadHours: 500 })).toThrow(/ahead/);
	});
});

describe("checkDue", () => {
	/** Routes the service's SQL to canned answers, recording the writes. */
	function database({ fired = [] } = {}) {
		const writes = [];
		db.query.mockImplementation(async (sql, params) => {
			if (/FROM athena_weather_alert\s+WHERE enabled/.test(sql)) return [[RULE]];
			if (/SELECT id FROM athena_weather_alert_fire/.test(sql)) return [[fired.includes(params[1]) ? { id: 1 } : undefined].filter(Boolean)];
			writes.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
			return [{ affectedRows: 1 }];
		});
		return writes;
	}

	test("tells about the cold night once, pushed, and records it", async () => {
		weather.hourlyRows.mockResolvedValue(forecast());
		const writes = database();
		const out = await weatherAlerts.checkDue({ now: new Date("2026-10-19T18:00:00-04:00") });
		expect(out).toMatchObject({ checked: 1, sent: 1, held: 0, failed: 0 });
		expect(out.messages[0].text).toMatch(/^Freeze alert for Home: down to 31°F around 6 AM tomorrow/);
		expect(writes.find((w) => /INSERT IGNORE INTO athena_weather_alert_fire/.test(w.sql)).params.slice(0, 3)).toEqual([4, "2026-10-19", 31]);
		expect(writes.find((w) => /INSERT IGNORE INTO athena_nudge/.test(w.sql)).params[2]).toBe("weather_alert");
		expect(push.deliverNudge).toHaveBeenCalledTimes(1);
	});

	test("a night already told is not told again", async () => {
		weather.hourlyRows.mockResolvedValue(forecast());
		database({ fired: ["2026-10-19"] });
		const out = await weatherAlerts.checkDue({ now: new Date("2026-10-19T18:00:00-04:00") });
		expect(out.sent).toBe(0);
		expect(push.deliverNudge).not.toHaveBeenCalled();
	});

	test("found in the middle of the night, it waits for morning and writes nothing", async () => {
		weather.hourlyRows.mockResolvedValue(forecast({ "2026-10-20": 31 }));
		database();
		// 1 AM Tuesday; the cold is Wednesday ~6 AM, far more than six hours off.
		const out = await weatherAlerts.checkDue({ now: new Date("2026-10-20T01:00:00-04:00"), limit: 1 });
		expect(out).toMatchObject({ sent: 0, held: 0 });
		// Outside the 24 h lead it isn't due at all; widen the lead and it is held.
		db.query.mockReset();
		const writes = database();
		db.query.mockImplementationOnce(async () => [[{ ...RULE, lead_hours: 48 }]]);
		const held = await weatherAlerts.checkDue({ now: new Date("2026-10-20T01:00:00-04:00") });
		expect(held).toMatchObject({ sent: 0, held: 1 });
		expect(push.deliverNudge).not.toHaveBeenCalled();
		expect(writes.some((w) => /athena_weather_alert_fire/.test(w.sql))).toBe(false);
	});

	test("the night hold gives way when the weather is close", async () => {
		weather.hourlyRows.mockResolvedValue(forecast());
		database();
		// 2 AM Tuesday, freeze at 6 AM: four hours away, so it goes now.
		const out = await weatherAlerts.checkDue({ now: new Date("2026-10-20T02:00:00-04:00") });
		expect(out).toMatchObject({ sent: 1, held: 0 });
	});

	test("no forecast is recorded as a failure to read, never as all clear", async () => {
		weather.hourlyRows.mockResolvedValue(null);
		const writes = database();
		const out = await weatherAlerts.checkDue({ now: new Date("2026-10-19T18:00:00-04:00") });
		expect(out).toMatchObject({ sent: 0, failed: 1 });
		expect(writes.find((w) => /last_error = \?/.test(w.sql)).params[1]).toMatch(/didn't answer/);
	});
});

describe("frost risk", () => {
	test("a still clear 35 is likely frost; a windy cloudy 35 only possible", () => {
		expect(weather.frostRisk(35, { windMph: 2, shortForecast: "Clear" })).toBe("likely");
		expect(weather.frostRisk(35, { windMph: 15, shortForecast: "Mostly Cloudy" })).toBe("possible");
		expect(weather.frostRisk(30, {})).toBe("freeze");
		expect(weather.frostRisk(26, {})).toBe("hard_freeze");
		expect(weather.frostRisk(45, { windMph: 0, shortForecast: "Clear" })).toBe("none");
	});

	test("local time comes from the forecast's own offset", () => {
		expect(weather.local("2026-10-20T05:00:00-04:00")).toMatchObject({ date: "2026-10-20", hour: 5, night: "2026-10-19" });
		expect(weather.windMph({ windSpeed: "10 to 20 mph", windGust: { value: 31 } })).toBe(31);
	});
});
