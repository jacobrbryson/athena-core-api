/**
 * Recurring health checks: what's upcoming, ticking off and skipping, and the
 * one push per unticked occurrence. The database is mocked.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./reminderWakeups", () => ({ wakeAt: jest.fn(async () => true) }));
jest.mock("./push", () => ({ deliverNudge: jest.fn(async () => ({ sent: 1 })) }));

const pool = require("../helpers/db");
const wakeups = require("./reminderWakeups");
const push = require("./push");
const checks = require("./familyHealthSchedules");

const HOUR = 3_600_000;
const NOW = new Date("2026-11-22T15:00:00Z");
const watch = (over = {}) => ({ id: 9, family_id: 7, status: "active", ends_on: null, time_zone: "America/New_York", ...over });
const schedule = (over = {}) => ({
	id: 3,
	uuid: "s1",
	status_id: 9,
	label: "Check temperature",
	kind: "check",
	every_hours: 6,
	next_due_at: new Date(NOW.getTime() + HOUR),
	ends_at: null,
	last_done_at: null,
	push_attempts: 0,
	...over,
});

beforeEach(() => {
	pool.query.mockReset();
	wakeups.wakeAt.mockClear();
	push.deliverNudge.mockReset().mockResolvedValue({ sent: 1 });
});

describe("upcoming", () => {
	it("projects each check every interval for two days, soonest first, only the first actionable", () => {
		const list = [
			checks.publicSchedule(schedule(), watch(), NOW.getTime()),
			checks.publicSchedule(schedule({ uuid: "s2", label: "Tylenol", kind: "medicine", every_hours: 12, next_due_at: new Date(NOW.getTime() - HOUR) }), watch(), NOW.getTime()),
		];
		const up = checks.upcoming(list, watch(), NOW.getTime());
		expect(up[0]).toMatchObject({ label: "Tylenol", overdue: true, actionable: true });
		expect(up[1]).toMatchObject({ label: "Check temperature", overdue: false, actionable: true });
		expect(up.filter((u) => u.label === "Check temperature" && u.actionable)).toHaveLength(1);
		expect(up.filter((u) => u.label === "Check temperature")).toHaveLength(8); // +1h, +7h … +43h: 8 at 6h steps within 48h
	});

	it("stops at the watch's planned end, in the watch's own zone", () => {
		// ends_on Nov 22 in New York: 11 pm ET (04:00Z the 23rd) is still the 22nd; 5 am ET is not.
		const w = watch({ ends_on: "2026-11-22" });
		const s = checks.publicSchedule(schedule({ next_due_at: new Date("2026-11-23T04:00:00Z") }), w, NOW.getTime());
		const up = checks.upcoming([s], w, NOW.getTime());
		expect(up.map((u) => u.dueAt)).toEqual(["2026-11-23T04:00:00.000Z"]);
	});

	it("has nothing once the watch has ended", () => {
		const w = watch({ status: "resolved" });
		const s = checks.publicSchedule(schedule(), w, NOW.getTime());
		expect(s.finished).toBe(true);
		expect(checks.upcoming([s], w, NOW.getTime())).toEqual([]);
	});
});

describe("create", () => {
	it.each([0, 169, 1.5, "often"])("refuses every %p hours", async (everyHours) => {
		await expect(checks.create(1, watch(), { label: "Temp", everyHours })).rejects.toMatchObject({ status: 400 });
		expect(pool.query).not.toHaveBeenCalled();
	});

	it("refuses on an ended watch", async () => {
		await expect(checks.create(1, watch({ status: "resolved" }), { label: "Temp", everyHours: 6 })).rejects.toMatchObject({ status: 409 });
	});

	it("starts one interval from now by default and books a wake-up for it", async () => {
		pool.query.mockResolvedValueOnce([[{ n: 0 }]]).mockResolvedValueOnce([{ insertId: 1 }]);
		await checks.create(1, watch(), { label: "Tylenol", kind: "medicine", everyHours: 12 }, { now: NOW });
		const insert = pool.query.mock.calls[1][1];
		expect(insert.slice(3, 7)).toEqual(["Tylenol", "medicine", 12, new Date(NOW.getTime() + 12 * HOUR)]);
		expect(wakeups.wakeAt).toHaveBeenCalledWith(new Date(NOW.getTime() + 12 * HOUR));
	});
});

describe("mark", () => {
	it("ticking off moves the next one to when it was done plus the interval, and logs it", async () => {
		const due = new Date(NOW.getTime() - 2 * HOUR); // done two hours late
		pool.query
			.mockResolvedValueOnce([[schedule({ next_due_at: due })]])
			.mockResolvedValueOnce([{ affectedRows: 1 }])
			.mockResolvedValueOnce([{ insertId: 5 }]);
		await checks.mark(1, watch(), "s1", { note: "101.2" }, { now: NOW });
		expect(pool.query.mock.calls[1][1][0]).toEqual(new Date(NOW.getTime() + 6 * HOUR));
		const entry = pool.query.mock.calls[2][1];
		expect(entry.slice(3, 7)).toEqual(["check", "101.2", 3, due]);
		expect(wakeups.wakeAt).toHaveBeenCalledWith(new Date(NOW.getTime() + 6 * HOUR));
	});

	it("skipping moves on from when it was due", async () => {
		const due = new Date(NOW.getTime() - 2 * HOUR);
		pool.query
			.mockResolvedValueOnce([[schedule({ next_due_at: due })]])
			.mockResolvedValueOnce([{ affectedRows: 1 }])
			.mockResolvedValueOnce([{ insertId: 5 }]);
		await checks.mark(1, watch(), "s1", { skip: true }, { now: NOW });
		expect(pool.query.mock.calls[1][1][0]).toEqual(new Date(due.getTime() + 6 * HOUR));
		expect(pool.query.mock.calls[2][1][3]).toBe("skip");
	});

	it("says so when someone else ticked it off first", async () => {
		pool.query.mockResolvedValueOnce([[schedule()]]).mockResolvedValueOnce([{ affectedRows: 0 }]);
		await expect(checks.mark(1, watch(), "s1", {}, { now: NOW })).rejects.toMatchObject({ status: 409 });
	});
});

describe("fireDue", () => {
	const due = (over = {}) =>
		schedule({
			next_due_at: new Date(NOW.getTime() - 60_000),
			created_by_profile_id: 42,
			person_name: "Thomas",
			status: "active",
			ends_on: null,
			time_zone: "America/New_York",
			watch_uuid: "w1",
			...over,
		});

	it("pushes each unticked occurrence once, to whoever set it, linking the watch's page", async () => {
		pool.query
			.mockResolvedValueOnce([{}]) // release stale claims
			.mockResolvedValueOnce([[due(), due({ id: 4, uuid: "s2", label: "Tylenol" })]])
			.mockResolvedValue([{ affectedRows: 1 }]);
		const out = await checks.fireDue({ now: NOW });
		expect(out).toEqual({ fired: 2, retried: 0 });
		expect(push.deliverNudge).toHaveBeenCalledTimes(2);
		const [profile, nudge] = push.deliverNudge.mock.calls[0];
		expect(profile).toBe(42);
		expect(nudge).toMatchObject({ trigger_id: "health_check_due", url: "/family/health/w1" });
		expect(nudge.text).toMatch(/Thomas: Check temperature is due/);
		// Two checks due together are two nudges, never folded into one.
		const keys = pool.query.mock.calls.filter(([sql]) => /INSERT IGNORE INTO athena_nudge/.test(sql)).map(([, p]) => p[3]);
		expect(new Set(keys).size).toBe(2);
	});

	it("skips one another run already claimed", async () => {
		pool.query
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([[due()]])
			.mockResolvedValueOnce([{ affectedRows: 0 }]);
		expect(await checks.fireDue({ now: NOW })).toEqual({ fired: 0, retried: 0 });
		expect(push.deliverNudge).not.toHaveBeenCalled();
	});

	it("retries a push that reached no device, with a wake-up booked for it", async () => {
		push.deliverNudge.mockResolvedValue({ sent: 0 });
		pool.query
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([[due()]])
			.mockResolvedValue([{ affectedRows: 1 }]);
		expect(await checks.fireDue({ now: NOW })).toEqual({ fired: 0, retried: 1 });
		expect(wakeups.wakeAt).toHaveBeenCalledWith(new Date(NOW.getTime() + 2 * 60_000));
	});

	it("doesn't push past the watch's planned end", async () => {
		pool.query
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([[due({ ends_on: "2026-11-21" })]]);
		expect(await checks.fireDue({ now: NOW })).toEqual({ fired: 0, retried: 0 });
		expect(push.deliverNudge).not.toHaveBeenCalled();
	});
});
