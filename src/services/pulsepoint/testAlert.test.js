/**
 * "Test PulsePoint alert" / "Test weather alert" (watch.testAlert): the made-up
 * call goes through the real parse -> geocode -> ring steps, is pushed, and
 * never becomes a nudge or a situation.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../push", () => ({ sendToProfile: jest.fn() }));
jest.mock("./geocode", () => ({ lookup: jest.fn() }));

const pool = require("../../helpers/db");
const push = require("../push");
const geocode = require("./geocode");
const watch = require("./watch");
const phoneAlerts = require("./phoneAlerts");

const HOME = {
	uuid: "p-1",
	name: "Home",
	latitude: 35.7,
	longitude: -80.9,
	radius_miles: "3.00",
	enabled: 1,
	address: "148 Rushing Water Lane, Troutman, NC 28166",
};

function db({ places = [HOME] } = {}) {
	pool.query.mockImplementation(async (sql) => {
		if (/FROM athena_watch_place/.test(sql)) return [places];
		if (/athena_location_sample/.test(sql)) return [[]];
		throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
	});
}

beforeEach(() => {
	jest.clearAllMocks();
	phoneAlerts._resetCache();
	push.sendToProfile.mockResolvedValue({ sent: 1, failed: 0, devices: 1, results: [] });
	geocode.lookup.mockResolvedValue([{ latitude: 35.701, longitude: -80.9 }]);
});

test("PulsePoint test is parsed, placed, ringed and pushed — and writes nothing", async () => {
	db();
	const result = await watch.testAlert(1, { kind: "pulsepoint" });
	expect(result.ok).toBe(true);
	expect(result.steps.map((s) => [s.step, s.ok])).toEqual([
		["places", true],
		["parsed", true],
		["placed", true],
		["near", true],
		["push", true],
	]);
	expect(geocode.lookup).toHaveBeenCalledWith(expect.stringMatching(/^148 Rushing Water Lane/));
	const [, message] = push.sendToProfile.mock.calls[0];
	expect(message.body).toMatch(/^Test — Structure Fire/);
	expect(message.collapseKey).toBe("athena-test-pulsepoint");
	// Only reads: no nudge, no situation.
	for (const [sql] of pool.query.mock.calls) expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
});

test("says where it broke when the address cannot be placed", async () => {
	db();
	geocode.lookup.mockResolvedValue([]);
	const result = await watch.testAlert(1, { kind: "pulsepoint" });
	expect(result.ok).toBe(false);
	expect(result.steps.at(-1)).toMatchObject({ step: "placed", ok: false });
	expect(push.sendToProfile).not.toHaveBeenCalled();
});

test("reports a push that reached nobody", async () => {
	db();
	push.sendToProfile.mockResolvedValue({ sent: 0, failed: 0, devices: 0, skipped: "no registered device" });
	const result = await watch.testAlert(1, { kind: "weather" });
	expect(result.ok).toBe(false);
	expect(result.steps.at(-1)).toEqual({ step: "push", ok: false, detail: "no registered device" });
});

test("weather test names the place and is marked as a test", async () => {
	db();
	const result = await watch.testAlert(1, { kind: "weather" });
	expect(result.ok).toBe(true);
	expect(push.sendToProfile.mock.calls[0][1].body).toMatch(/^Test — Tornado Warning for home/);
});

test("no watched places stops before anything is sent", async () => {
	db({ places: [] });
	const result = await watch.testAlert(1, { kind: "pulsepoint" });
	expect(result).toMatchObject({ ok: false, steps: [{ step: "places", ok: false }] });
	expect(push.sendToProfile).not.toHaveBeenCalled();
});
