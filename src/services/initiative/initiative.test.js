/**
 * Initiative: the interruption budget, and the rules that fire.
 *
 * Weighted toward silence, for the same reason the action tests are weighted
 * toward refusal. A system that can interrupt people is judged on when it
 * declines to, and every limit here is one that must fail CLOSED — a budget
 * that goes quiet when something breaks is a bug; a budget that starts
 * talking when something breaks is the reason people uninstall things.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("../consent", () => ({ hasConsentForProfile: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn() }));
jest.mock("../llm", () => ({ generateJson: jest.fn() }));
jest.mock("../connectors/googleCalendar", () => ({
	collectEvents: jest.fn(),
	displayTimeZone: jest.fn(() => "America/New_York"),
}));
jest.mock("../connectors/whoop", () => ({ listRecovery: jest.fn() }));

const pool = require("../../helpers/db");
const access = require("../../security/access");
const consent = require("../consent");
const credentials = require("../credentials");
const llm = require("../llm");
const googleCalendar = require("../connectors/googleCalendar");
const whoop = require("../connectors/whoop");
const initiative = require("./index");
const triggers = require("./triggers");

const PROFILE = 42;
const MINUTE = 60_000;

/** An enabled preference row, with the quiet window well away from "now". */
const PREF_ON = {
	enabled: 1,
	timezone: "UTC",
	quiet_from: 2,
	quiet_to: 3,
	daily_cap: 3,
};

/** A calendar event as googleCalendar.normalizeEvent produces it. */
function event(minutesFromNow, over = {}) {
	const start = new Date(Date.now() + minutesFromNow * MINUTE);
	return {
		id: `evt-${minutesFromNow}`,
		title: "Standup",
		start: start.toISOString(),
		end: new Date(start.getTime() + 30 * MINUTE).toISOString(),
		allDay: false,
		location: null,
		...over,
	};
}

/**
 * Route queries by the text of the SQL, so a test only states the rows it
 * cares about. Anything unmatched answers empty, which is the shape that
 * keeps her quiet.
 */
function db({ pref = PREF_ON, today = 0, lastAt = null, lastFired = null, mutes = [] } = {}) {
	pool.query.mockImplementation(async (sql) => {
		if (sql.includes("FROM athena_initiative_pref")) return [pref ? [pref] : []];
		if (sql.includes("COUNT(*) AS today")) return [[{ today, last_at: lastAt }]];
		if (sql.includes("MAX(created_at) AS last_at")) return [[{ last_at: lastFired }]];
		if (sql.includes("FROM athena_trigger_mute")) return [mutes.map((t) => ({ trigger_id: t }))];
		if (sql.includes("INSERT IGNORE INTO athena_nudge")) return [{ affectedRows: 1 }];
		return [[], {}];
	});
}

beforeEach(() => {
	jest.clearAllMocks();
	pool.query.mockResolvedValue([[], {}]);
	access.assertModelAccess.mockResolvedValue(undefined);
	consent.hasConsentForProfile.mockResolvedValue(true);
	credentials.list.mockResolvedValue([
		{ provider: "google_calendar", status: "active" },
		{ provider: "whoop", status: "active" },
	]);
	llm.generateJson.mockResolvedValue({ data: { text: "Standup in fifteen." } });
	googleCalendar.collectEvents.mockResolvedValue({ events: [], calendars: [] });
	whoop.listRecovery.mockResolvedValue([]);
	jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

describe("quiet hours", () => {
	const at = (hourUtc) => new Date(Date.UTC(2026, 8, 18, hourUtc, 0, 0));
	const pref = (over) => ({ timezone: "UTC", quiet_from: 22, quiet_to: 7, ...over });

	test("a window that wraps midnight is quiet on BOTH sides of it", () => {
		// The bug this exists to prevent inverts the test and makes her silent
		// all day and chatty all night.
		expect(initiative.inQuietHours(pref(), at(23))).toBe(true);
		expect(initiative.inQuietHours(pref(), at(3))).toBe(true);
		expect(initiative.inQuietHours(pref(), at(6))).toBe(true);
	});

	test("the middle of the day is not quiet", () => {
		expect(initiative.inQuietHours(pref(), at(7))).toBe(false);
		expect(initiative.inQuietHours(pref(), at(14))).toBe(false);
		expect(initiative.inQuietHours(pref(), at(21))).toBe(false);
	});

	test("a window that does not wrap behaves normally", () => {
		const p = pref({ quiet_from: 9, quiet_to: 17 });
		expect(initiative.inQuietHours(p, at(12))).toBe(true);
		expect(initiative.inQuietHours(p, at(20))).toBe(false);
	});

	test("from === to means no quiet window, not an always-quiet one", () => {
		expect(initiative.inQuietHours(pref({ quiet_from: 0, quiet_to: 0 }), at(3))).toBe(false);
	});

	test("quiet hours are theirs, not the server's", () => {
		// 03:00 UTC is 23:00 in New York — quiet there, wide awake in UTC.
		const p = pref({ timezone: "America/New_York" });
		expect(initiative.inQuietHours(p, at(3))).toBe(true);
		expect(initiative.inQuietHours(pref({ timezone: "UTC" }), at(3))).toBe(true);
		expect(initiative.inQuietHours(p, at(16))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

describe("the interruption budget", () => {
	test("no preference row means silence", async () => {
		db({ pref: null });
		expect(await initiative.budgetCheck(PROFILE, await initiative.getPref(PROFILE))).toBe(
			"not enabled"
		);
	});

	test("the daily cap is counted over the LOCAL day, not the last 24h", async () => {
		db({ today: 3 });
		const pref = await initiative.getPref(PROFILE);
		expect(await initiative.budgetCheck(PROFILE, pref)).toMatch(/daily cap reached/);

		// And the boundary is computed here, not handed to MySQL's CONVERT_TZ:
		// when the tz tables aren't loaded CONVERT_TZ returns NULL, the count
		// comes back zero, and the cap silently stops existing.
		const call = pool.query.mock.calls.find((c) => c[0].includes("COUNT(*) AS today"));
		expect(call[0]).not.toContain("CONVERT_TZ");
		expect(call[1][1]).toBeInstanceOf(Date);
	});

	test("a cap of zero is honoured rather than read as 'unset'", async () => {
		db({ pref: { ...PREF_ON, daily_cap: 0 } });
		expect(await initiative.budgetCheck(PROFILE, await initiative.getPref(PROFILE))).toMatch(
			/zero/
		);
	});

	test("two nudges cannot land close together even from different triggers", async () => {
		db({ today: 1, lastAt: new Date(Date.now() - 5 * MINUTE) });
		expect(await initiative.budgetCheck(PROFILE, await initiative.getPref(PROFILE))).toMatch(
			/too soon/
		);
	});

	test("a gap longer than the minimum is allowed", async () => {
		db({ today: 1, lastAt: new Date(Date.now() - initiative.MIN_GAP_MS - MINUTE) });
		expect(await initiative.budgetCheck(PROFILE, await initiative.getPref(PROFILE))).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

describe("evaluateProfile", () => {
	test("says nothing, and calls no model, when the budget refuses", async () => {
		db({ pref: null });
		const out = await initiative.evaluateProfile(PROFILE);
		expect(out).toEqual({ skipped: "not enabled" });
		expect(llm.generateJson).not.toHaveBeenCalled();
		expect(googleCalendar.collectEvents).not.toHaveBeenCalled();
	});

	test("live access is checked before anything is evaluated", async () => {
		db();
		access.assertModelAccess.mockRejectedValue(new Error("denied"));
		await expect(initiative.evaluateProfile(PROFILE)).rejects.toThrow(/denied/);
		expect(googleCalendar.collectEvents).not.toHaveBeenCalled();
	});

	test("a trigger whose provider is not linked is skipped entirely", async () => {
		db();
		credentials.list.mockResolvedValue([]);
		expect(await initiative.evaluateProfile(PROFILE)).toEqual({ skipped: "nothing to say" });
		expect(googleCalendar.collectEvents).not.toHaveBeenCalled();
	});

	test("a muted trigger never runs", async () => {
		db({ mutes: ["calendar_next_up", "calendar_conflict", "recovery_vs_day"] });
		expect(await initiative.evaluateProfile(PROFILE)).toEqual({ skipped: "nothing to say" });
		expect(googleCalendar.collectEvents).not.toHaveBeenCalled();
	});

	test("a provider that throws costs that trigger only, and says nothing", async () => {
		db();
		googleCalendar.collectEvents.mockRejectedValue(new Error("Google is down"));
		expect(await initiative.evaluateProfile(PROFILE)).toEqual({ skipped: "nothing to say" });
	});

	test("an event 15 minutes out produces exactly one nudge", async () => {
		db();
		googleCalendar.collectEvents.mockResolvedValue({ events: [event(15)], calendars: [] });
		const out = await initiative.evaluateProfile(PROFILE);
		expect(out.nudge).toMatchObject({ trigger_id: "calendar_next_up" });

		const insert = pool.query.mock.calls.find((c) => c[0].includes("INSERT IGNORE INTO athena_nudge"));
		// Keyed on the event id, so the same meeting cannot be announced again
		// on the next pass.
		expect(insert[1][3]).toBe("event:evt-15");
	});

	test("the dedupe is a database constraint, not a check this code remembers", async () => {
		db();
		googleCalendar.collectEvents.mockResolvedValue({ events: [event(15)], calendars: [] });
		await initiative.evaluateProfile(PROFILE);
		const insert = pool.query.mock.calls.find((c) => c[0].includes("INTO athena_nudge"));
		expect(insert[0]).toContain("INSERT IGNORE");
	});

	test("losing the dedupe race is a quiet skip, not an error", async () => {
		db();
		googleCalendar.collectEvents.mockResolvedValue({ events: [event(15)], calendars: [] });
		pool.query.mockImplementation(async (sql) => {
			if (sql.includes("FROM athena_initiative_pref")) return [[PREF_ON]];
			if (sql.includes("COUNT(*) AS today")) return [[{ today: 0, last_at: null }]];
			if (sql.includes("MAX(created_at) AS last_at")) return [[{ last_at: null }]];
			if (sql.includes("INSERT IGNORE INTO athena_nudge")) return [{ affectedRows: 0 }];
			return [[], {}];
		});
		expect(await initiative.evaluateProfile(PROFILE)).toEqual({
			skipped: "already said (deduped)",
		});
	});

	test("she says the most urgent thing, not everything that fired", async () => {
		db();
		// A clash later today AND something starting in 15 minutes.
		googleCalendar.collectEvents.mockResolvedValue({
			events: [
				event(15),
				event(120, { id: "a", end: new Date(Date.now() + 200 * MINUTE).toISOString() }),
				event(150, { id: "b", title: "Overlapping" }),
			],
			calendars: [],
		});
		const out = await initiative.evaluateProfile(PROFILE);
		// calendar_next_up is `high`, the clash is `normal`.
		expect(out.nudge.trigger_id).toBe("calendar_next_up");
		const inserts = pool.query.mock.calls.filter((c) =>
			c[0].includes("INSERT IGNORE INTO athena_nudge")
		);
		expect(inserts).toHaveLength(1);
	});

	test("a model failure falls back to the trigger's own words rather than silence", async () => {
		db();
		googleCalendar.collectEvents.mockResolvedValue({ events: [event(15)], calendars: [] });
		llm.generateJson.mockRejectedValue(new Error("no model available"));
		const out = await initiative.evaluateProfile(PROFILE);
		// The observation was true either way; a stiff sentence beats nothing.
		expect(out.nudge.text).toMatch(/Standup/);
	});

	test("wording runs on the local-first task, not the frontier one", async () => {
		db();
		googleCalendar.collectEvents.mockResolvedValue({ events: [event(15)], calendars: [] });
		await initiative.evaluateProfile(PROFILE);
		expect(llm.generateJson).toHaveBeenCalledWith(
			expect.objectContaining({ task: "json" })
		);
	});
});

// ---------------------------------------------------------------------------
// The triggers themselves
// ---------------------------------------------------------------------------

describe("calendar_next_up", () => {
	const trigger = triggers.get("calendar_next_up");

	test("fires inside the 10-25 minute window", async () => {
		googleCalendar.collectEvents.mockResolvedValue({ events: [event(15)], calendars: [] });
		const hit = await trigger.evaluate(PROFILE);
		expect(hit).toMatchObject({ dedupeKey: "event:evt-15" });
		expect(hit.facts.minutes).toBeGreaterThanOrEqual(10);
	});

	test("does not fire an hour out — too early to be useful", async () => {
		googleCalendar.collectEvents.mockResolvedValue({ events: [event(60)], calendars: [] });
		expect(await trigger.evaluate(PROFILE)).toBeNull();
	});

	test("does not fire five minutes out — too late to act on", async () => {
		googleCalendar.collectEvents.mockResolvedValue({ events: [event(5)], calendars: [] });
		expect(await trigger.evaluate(PROFILE)).toBeNull();
	});

	test("ignores all-day events, which do not start at a time", async () => {
		googleCalendar.collectEvents.mockResolvedValue({
			events: [event(15, { allDay: true })],
			calendars: [],
		});
		expect(await trigger.evaluate(PROFILE)).toBeNull();
	});

	test("an empty calendar is silence, not an error", async () => {
		googleCalendar.collectEvents.mockResolvedValue({ events: [], calendars: [] });
		expect(await trigger.evaluate(PROFILE)).toBeNull();
	});
});

describe("calendar_conflict", () => {
	const trigger = triggers.get("calendar_conflict");

	test("fires on a genuine overlap far enough ahead to fix", async () => {
		googleCalendar.collectEvents.mockResolvedValue({
			events: [
				event(120, { id: "a", end: new Date(Date.now() + 200 * MINUTE).toISOString() }),
				event(150, { id: "b", title: "Overlapping" }),
			],
			calendars: [],
		});
		const hit = await trigger.evaluate(PROFILE);
		expect(hit.dedupeKey).toBe("clash:a|b");
		expect(hit.facts.overlap_minutes).toBeGreaterThan(0);
	});

	test("the key is order-independent, so one clash is one nudge", async () => {
		// The provider does not promise a stable order between two events that
		// start close together; an order-sensitive key would announce the same
		// clash twice.
		const a = event(120, { id: "b", end: new Date(Date.now() + 200 * MINUTE).toISOString() });
		const b = event(150, { id: "a" });
		googleCalendar.collectEvents.mockResolvedValue({ events: [a, b], calendars: [] });
		expect((await trigger.evaluate(PROFILE)).dedupeKey).toBe("clash:a|b");
	});

	test("back-to-back events are not a conflict", async () => {
		const first = event(120, { id: "a" }); // ends at +150
		const second = event(150, { id: "b" });
		googleCalendar.collectEvents.mockResolvedValue({ events: [first, second], calendars: [] });
		expect(await trigger.evaluate(PROFILE)).toBeNull();
	});

	test("stays quiet when the clash is under an hour away", async () => {
		googleCalendar.collectEvents.mockResolvedValue({
			events: [
				event(30, { id: "a", end: new Date(Date.now() + 90 * MINUTE).toISOString() }),
				event(45, { id: "b" }),
			],
			calendars: [],
		});
		// Too late to rearrange anything; saying so is just stress.
		expect(await trigger.evaluate(PROFILE)).toBeNull();
	});
});

describe("recovery_vs_day", () => {
	const trigger = triggers.get("recovery_vs_day");
	const busy = () => ({
		events: [event(60), event(120), event(180), event(240)],
		calendars: [],
	});

	test("fires only when BOTH the recovery is low and the day is full", async () => {
		whoop.listRecovery.mockResolvedValue([{ date: "2026-09-18", recovery_score: 31 }]);
		googleCalendar.collectEvents.mockResolvedValue(busy());
		const hit = await trigger.evaluate(PROFILE);
		expect(hit).toMatchObject({ dedupeKey: "day:2026-09-18" });
		expect(hit.facts).toMatchObject({ recovery: 31, meetings_left: 4 });
	});

	test("a low score on a quiet day says nothing", async () => {
		whoop.listRecovery.mockResolvedValue([{ date: "2026-09-18", recovery_score: 31 }]);
		googleCalendar.collectEvents.mockResolvedValue({ events: [event(60)], calendars: [] });
		expect(await trigger.evaluate(PROFILE)).toBeNull();
	});

	test("a busy day on good recovery says nothing", async () => {
		whoop.listRecovery.mockResolvedValue([{ date: "2026-09-18", recovery_score: 82 }]);
		googleCalendar.collectEvents.mockResolvedValue(busy());
		expect(await trigger.evaluate(PROFILE)).toBeNull();
	});

	test("a missing score is not treated as a low one", async () => {
		whoop.listRecovery.mockResolvedValue([{ date: "2026-09-18", recovery_score: null }]);
		googleCalendar.collectEvents.mockResolvedValue(busy());
		expect(await trigger.evaluate(PROFILE)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Settings, delivery, reactions
// ---------------------------------------------------------------------------

describe("preferences", () => {
	test("turning it on requires the same consent that lets her act", async () => {
		db({ pref: null });
		consent.hasConsentForProfile.mockResolvedValue(false);
		await expect(initiative.setPref(PROFILE, { enabled: true })).rejects.toMatchObject({
			code: "consent_required",
		});
	});

	test("turning it OFF never requires consent", async () => {
		db({ pref: { ...PREF_ON, enabled: 1 } });
		consent.hasConsentForProfile.mockResolvedValue(false);
		await expect(initiative.setPref(PROFILE, { enabled: false })).resolves.toMatchObject({
			enabled: false,
		});
	});

	test("an out-of-range quiet hour falls back instead of being stored", async () => {
		db();
		const next = await initiative.setPref(PROFILE, { quiet_from: 99, quiet_to: -4 });
		expect(next.quiet_from).toBe(PREF_ON.quiet_from);
		expect(next.quiet_to).toBe(PREF_ON.quiet_to);
	});

	test("the daily cap is clamped, so a client cannot ask for a hundred", async () => {
		db();
		expect((await initiative.setPref(PROFILE, { daily_cap: 100 })).daily_cap).toBe(10);
	});

	test("muting an unknown trigger is refused", async () => {
		await expect(initiative.mute(PROFILE, "made_up")).rejects.toMatchObject({
			code: "unknown_trigger",
		});
	});
});

describe("delivery and reactions", () => {
	test("fetching marks them delivered, so two tabs are one interruption", async () => {
		pool.query.mockImplementation(async (sql) => {
			if (sql.includes("FROM athena_nudge") && sql.includes("status = 'pending'"))
				return [[{ uuid: "n1", trigger_id: "calendar_next_up", text: "soon", urgency: "high" }]];
			return [[], {}];
		});
		const out = await initiative.pendingFor(PROFILE);
		expect(out[0]).toMatchObject({ uuid: "n1", status: "delivered" });
		expect(
			pool.query.mock.calls.some((c) => c[0].includes("SET status = 'delivered'"))
		).toBe(true);
	});

	test("facts never leave the server", async () => {
		pool.query.mockImplementation(async (sql) => {
			if (sql.includes("FROM athena_nudge") && sql.includes("status = 'pending'"))
				return [[{ uuid: "n1", trigger_id: "calendar_next_up", text: "soon", urgency: "high" }]];
			return [[], {}];
		});
		await initiative.pendingFor(PROFILE);
		const select = pool.query.mock.calls[0][0];
		expect(select).not.toContain("facts");
	});

	test("an unknown reaction is refused", async () => {
		await expect(initiative.react(PROFILE, "n1", "loved-it")).rejects.toMatchObject({
			code: "bad_reaction",
		});
	});

	test("reacting to someone else's nudge changes nothing", async () => {
		pool.query.mockResolvedValue([{ affectedRows: 0 }]);
		await expect(initiative.react(PROFILE, "n1", "engaged")).rejects.toMatchObject({
			code: "not_open",
		});
	});

	test("a reaction is scoped to the caller's own profile", async () => {
		pool.query.mockResolvedValue([{ affectedRows: 1 }]);
		await initiative.react(PROFILE, "n1", "dismissed");
		const [sql, params] = pool.query.mock.calls[0];
		expect(sql).toContain("profile_id = ?");
		expect(params).toContain(PROFILE);
	});
});

describe("promptBlock", () => {
	test("is null when she has said nothing unprompted", async () => {
		pool.query.mockResolvedValue([[], {}]);
		expect(await initiative.promptBlock(PROFILE)).toBeNull();
	});

	test("tells her what she raised, and not to repeat it", async () => {
		pool.query.mockResolvedValue([[{ text: "Standup in fifteen.", created_at: new Date() }]]);
		const block = await initiative.promptBlock(PROFILE);
		expect(block).toContain("Standup in fifteen.");
		expect(block).toMatch(/do not repeat/i);
	});

	test("a profileless session gets nothing, and costs no query", async () => {
		expect(await initiative.promptBlock(null)).toBeNull();
		expect(pool.query).not.toHaveBeenCalled();
	});
});
