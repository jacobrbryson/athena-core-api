/**
 * Live heart rate: a dumb, opt-in, adults-only store of one-minute summaries.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./credentials", () => ({ list: jest.fn() }));
jest.mock("./connectors/whoop", () => ({ listRecovery: jest.fn() }));

const pool = require("../helpers/db");
const credentials = require("./credentials");
const whoop = require("./connectors/whoop");
const heartRate = require("./heartRate");

const minute = (over = {}) => ({
	minute_at: new Date(Date.now() - 2 * 60_000).toISOString(),
	bpm_min: 70,
	bpm_avg: 75,
	bpm_max: 82,
	readings: 60,
	source: "whoop_ble",
	...over,
});

beforeEach(() => {
	pool.query.mockReset();
	credentials.list.mockReset().mockResolvedValue([]);
	whoop.listRecovery.mockReset();
});

describe("pref", () => {
	test("no row means off, with 30-day retention", async () => {
		pool.query.mockResolvedValueOnce([[]]);
		expect(await heartRate.getPref(1)).toEqual({ enabled: false, retention_days: 30 });
	});

	test("turning it off deletes every stored minute", async () => {
		pool.query
			.mockResolvedValueOnce([[{ enabled: 1, retention_days: 30 }]])
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([{}]);
		await heartRate.setPref(1, { enabled: false });
		expect(pool.query.mock.calls[2][0]).toMatch(/DELETE FROM athena_heart_minute WHERE profile_id = \?$/);
	});

	test("retention is clamped to 7–30 days", async () => {
		pool.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([{}]);
		const next = await heartRate.setPref(1, { enabled: true, retention_days: 365 });
		expect(next).toEqual({ enabled: true, retention_days: 30 });
	});
});

describe("recordMinutes", () => {
	test("refused while switched off", async () => {
		pool.query.mockResolvedValueOnce([[]]);
		await expect(heartRate.recordMinutes({ profileId: 1, deviceId: 2, body: { minutes: [minute()] } }))
			.rejects.toMatchObject({ status: 403, code: "heart_rate_not_enabled" });
		expect(pool.query).toHaveBeenCalledTimes(1);
	});

	test("stores valid minutes, drops implausible ones, and purges past retention", async () => {
		pool.query
			.mockResolvedValueOnce([[{ enabled: 1, retention_days: 30 }]])
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([{}]);
		const result = await heartRate.recordMinutes({
			profileId: 1,
			deviceId: 2,
			body: {
				minutes: [
					minute({ session_sport: "ride", limit_crossed: "above" }),
					minute({ bpm_avg: 90 }), // avg above max
					minute({ minute_at: new Date(Date.now() - 3 * 86400_000).toISOString() }), // too old
					minute({ source: "Bad Source!" }),
				],
			},
		});
		expect(result).toEqual({ accepted: 1, rejected: 3 });
		const [sql, [rows]] = pool.query.mock.calls[1];
		expect(sql).toMatch(/INSERT IGNORE INTO athena_heart_minute/);
		expect(rows).toHaveLength(1);
		expect(rows[0].slice(0, 2)).toEqual([1, 2]);
		expect(rows[0].slice(-2)).toEqual(["ride", "above"]);
		expect(pool.query.mock.calls[2][0]).toMatch(/DELETE FROM athena_heart_minute WHERE profile_id = \? AND minute_at < \?/);
	});

	test("an empty or oversized batch is a 400", async () => {
		pool.query.mockResolvedValue([[{ enabled: 1, retention_days: 30 }]]);
		await expect(heartRate.recordMinutes({ profileId: 1, deviceId: 2, body: { minutes: [] } })).rejects.toMatchObject({ status: 400 });
		await expect(
			heartRate.recordMinutes({ profileId: 1, deviceId: 2, body: { minutes: Array(1441).fill(minute()) } })
		).rejects.toMatchObject({ status: 400 });
	});

	test("minutes are floored and unknown sports/crossings become null", () => {
		const m = heartRate.normalizeMinute(minute({ minute_at: "2026-09-29T12:34:56.789Z", session_sport: "swim", limit_crossed: "sideways" }),
			Date.parse("2026-09-29T12:40:00Z"));
		expect(m.minute_at.toISOString()).toBe("2026-09-29T12:34:00.000Z");
		expect(m.session_sport).toBeNull();
		expect(m.limit_crossed).toBeNull();
	});
});

describe("buildContext", () => {
	test("never for a child, never when off, never for an unrelated message", async () => {
		expect(await heartRate.buildContext(1, { message: "what's my heart rate", audience: "child" })).toBeNull();
		expect(await heartRate.buildContext(1, { message: "what's for dinner", audience: "adult" })).toBeNull();
		pool.query.mockResolvedValueOnce([[]]);
		expect(await heartRate.buildContext(1, { message: "what's my heart rate", audience: "adult" })).toBeNull();
		expect(pool.query).toHaveBeenCalledTimes(1);
	});

	test("reports recent numbers, crossings, typical average and WHOOP resting HR", async () => {
		const now = Date.now();
		pool.query
			.mockResolvedValueOnce([[{ enabled: 1, retention_days: 30 }]])
			.mockResolvedValueOnce([[
				{ minute_at: new Date(now - 60_000), bpm_min: 150, bpm_avg: 160, bpm_max: 168, session_sport: "ride", limit_crossed: "above" },
				{ minute_at: new Date(now - 120_000), bpm_min: 140, bpm_avg: 150, bpm_max: 158, session_sport: "ride", limit_crossed: null },
			]])
			.mockResolvedValueOnce([[{ typical: 68, minutes: 5000 }]]);
		credentials.list.mockResolvedValue([{ provider: "whoop", status: "active" }]);
		whoop.listRecovery.mockResolvedValue([{ resting_heart_rate: 52 }]);
		const text = await heartRate.buildContext(1, { message: "how's my heart rate on this ride?", audience: "adult" });
		expect(text).toContain("avg 160 bpm");
		expect(text).toContain("Exercise sessions with limits in the last 24h: ride");
		expect(text).toContain("above at");
		expect(text).toContain("68 bpm");
		expect(text).toContain("resting heart rate (latest recovery): 52 bpm");
		expect(text).toMatch(/do not diagnose/);
	});

	test("an unreachable WHOOP never sinks the block", async () => {
		pool.query
			.mockResolvedValueOnce([[{ enabled: 1, retention_days: 30 }]])
			.mockResolvedValueOnce([[]])
			.mockResolvedValueOnce([[{ typical: null, minutes: 0 }]]);
		credentials.list.mockRejectedValue(new Error("down"));
		const text = await heartRate.buildContext(1, { message: "my pulse", audience: "adult" });
		expect(text).toContain("Nothing recorded in the last 24 hours");
		expect(text).not.toContain("WHOOP");
	});
});
