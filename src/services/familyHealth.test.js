/**
 * Family health watch: check-in cadence, and the trigger that asks for an
 * update when one is due. The database is mocked; nothing here touches it.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./family", () => ({ getFamilyForProfile: jest.fn(async () => ({ id: 7 })) }));
jest.mock("uuid", () => ({ v4: () => "00000000-0000-0000-0000-000000000000" }));
jest.mock("./connectors/googleCalendar", () => ({}));
jest.mock("./connectors/whoop", () => ({}));
jest.mock("./dreams/questions", () => ({}));

const pool = require("../helpers/db");
const familyHealth = require("./familyHealth");
const triggers = require("./initiative/triggers");

const HOUR = 3_600_000;
const row = (over = {}) => ({
	uuid: "h1",
	person_name: "Thomas",
	symptom: "a fever",
	severity: "moderate",
	status: "active",
	started_at: new Date().toISOString().slice(0, 10),
	resolved_at: null,
	notes: null,
	check_in_hours: null,
	last_update_at: new Date(Date.now() - 30 * 60_000),
	updated_at: new Date(Date.now() - 30 * 60_000),
	...over,
});

beforeEach(() => pool.query.mockReset());

describe("activeFor", () => {
	it("has no check-in when none was asked for", async () => {
		pool.query.mockResolvedValueOnce([[row()]]);
		const [w] = await familyHealth.activeFor(1);
		expect(w.checkInHours).toBeNull();
		expect(w.nextUpdateAt).toBeNull();
		expect(w.updateDue).toBe(false);
	});

	it("is due once the cadence has passed since the last update", async () => {
		pool.query.mockResolvedValueOnce([
			[
				row({ uuid: "a", check_in_hours: 1, last_update_at: new Date(Date.now() - 2 * HOUR) }),
				row({ uuid: "b", check_in_hours: 8, last_update_at: new Date(Date.now() - 2 * HOUR) }),
			],
		]);
		const [a, b] = await familyHealth.activeFor(1);
		expect(a.updateDue).toBe(true);
		expect(b.updateDue).toBe(false);
		expect(Date.parse(b.nextUpdateAt) - Date.parse(b.lastUpdateAt)).toBe(8 * HOUR);
	});
});

describe("report", () => {
	it.each([0, 169, 2.5, "often"])("refuses a check-in of %p hours", async (checkInHours) => {
		await expect(familyHealth.report(1, { personName: "Thomas", symptom: "fever", checkInHours })).rejects.toMatchObject({ status: 400 });
		expect(pool.query).not.toHaveBeenCalled();
	});

	it("stores the cadence on a new watch", async () => {
		pool.query
			.mockResolvedValueOnce([[]]) // no active row
			.mockResolvedValueOnce([{ insertId: 5 }])
			.mockResolvedValueOnce([[row({ check_in_hours: 4 })]]);
		const w = await familyHealth.report(1, { personName: "Thomas", symptom: "a fever", checkInHours: 4 });
		expect(pool.query.mock.calls[1][1]).toContain(4);
		expect(w.checkInHours).toBe(4);
	});

	it("keeps an existing cadence when an update leaves it out", async () => {
		pool.query
			.mockResolvedValueOnce([[{ id: 5 }]])
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([[row({ check_in_hours: 6 })]]);
		await familyHealth.report(1, { personName: "Thomas", symptom: "a fever" });
		const [sql, params] = pool.query.mock.calls[1];
		expect(sql).toMatch(/check_in_hours = IF\(\?, check_in_hours, \?\)/);
		expect(params.slice(1, 6)).toEqual(["mild", true, null, true, null]);
	});

	it("turns check-ins off with an explicit null", async () => {
		pool.query
			.mockResolvedValueOnce([[{ id: 5 }]])
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([[row()]]);
		await familyHealth.report(1, { personName: "Thomas", symptom: "a fever", checkInHours: null });
		expect(pool.query.mock.calls[1][1].slice(4, 6)).toEqual([false, null]);
	});
});

describe("family_health_check_in trigger", () => {
	const trigger = triggers.get("family_health_check_in");

	it("says nothing when no update is due", async () => {
		pool.query.mockResolvedValueOnce([[row({ check_in_hours: 4 }), row({ uuid: "x" })]]);
		expect(await trigger.evaluate(1)).toBeNull();
	});

	it("names every due case in one nudge, keyed to the updates it follows", async () => {
		const stale = new Date(Date.now() - 3 * HOUR);
		pool.query.mockResolvedValueOnce([
			[
				row({ uuid: "a", person_name: "Thomas", check_in_hours: 1, last_update_at: stale }),
				row({ uuid: "b", person_name: "Maya", symptom: "pain", check_in_hours: 2, last_update_at: stale }),
			],
		]);
		const hit = await trigger.evaluate(1);
		expect(hit.facts.people.map((p) => p.personName).sort()).toEqual(["Maya", "Thomas"]);
		expect(hit.ttlMs).toBe(HOUR);
		expect(trigger.brief(hit.facts)).toMatch(/Thomas.*Maya|Maya.*Thomas/);

		// Logging an update moves the key on, so the next check-in is a new nudge.
		pool.query.mockResolvedValueOnce([
			[
				row({ uuid: "a", person_name: "Thomas", check_in_hours: 1, last_update_at: new Date(Date.now() - 2 * HOUR) }),
				row({ uuid: "b", person_name: "Maya", symptom: "pain", check_in_hours: 2, last_update_at: stale }),
			],
		]);
		const next = await trigger.evaluate(1);
		expect(next.dedupeKey).not.toBe(hit.dedupeKey);
		expect(next.dedupeKey.length).toBeLessThanOrEqual(190);
	});
});

describe("promptBlock", () => {
	it("tells Athena an update is due and that she can't log it herself", async () => {
		pool.query.mockResolvedValueOnce([[row({ check_in_hours: 1, last_update_at: new Date(Date.now() - 2 * HOUR) })]]);
		const block = await familyHealth.promptBlock(1);
		expect(block).toMatch(/updates wanted every 1h, last 2h ago \(update due\)/);
		expect(block).toMatch(/An update is due on Thomas/);
	});
});

describe("log_health_update action (from chat)", () => {
	const registry = require("./actions/registry");
	const action = registry.get("log_health_update");
	const ctx = { profileId: 1 };
	const active = (over = {}) => [[row({ uuid: "w1", person_name: "Thomas Bryson", check_in_hours: 1, notes: "100.4 at noon", ...over })]];

	it("logs an update on an active watch, matched by first name, keeping what wasn't said", async () => {
		pool.query.mockResolvedValueOnce(active());
		const p = await action.normalize({ health_person: "thomas", health_reading: "101.2 at 3pm, gave Tylenol" }, ctx);
		expect(p).toEqual({ person_name: "Thomas Bryson", symptom: "a fever", severity: "moderate", watch_uuid: "w1", reading: "101.2 at 3pm, gave Tylenol" });
		expect(action.summarize(p)).toBe('Log an update on Thomas Bryson (a fever, moderate): "101.2 at 3pm, gave Tylenol".');

		pool.query.mockResolvedValueOnce([[{ id: 5 }]]).mockResolvedValueOnce([{}]).mockResolvedValueOnce(active());
		await action.execute(1, p);
		const [, params] = pool.query.mock.calls.at(-2);
		// notes written, cadence kept
		expect(params.slice(1, 6)).toEqual(["moderate", false, "101.2 at 3pm, gave Tylenol", true, null]);
	});

	it("starts a watch with a cadence when there is none", async () => {
		pool.query.mockResolvedValueOnce([[]]);
		const p = await action.normalize({ health_person: "Maya", health_symptom: "an earache", check_in_hours: 8 }, ctx);
		expect(p).toEqual({ person_name: "Maya", symptom: "an earache", severity: "mild", check_in_hours: 8 });
		expect(action.summarize(p)).toBe("Start a health watch on Maya: an earache, mild. Ask for an update every 8 hours.");
	});

	it("refuses what it can't vouch for", async () => {
		pool.query.mockResolvedValue([[]]);
		await expect(action.normalize({ health_person: "Maya" }, ctx)).rejects.toThrow(/what's wrong/);
		await expect(action.normalize({ health_person: "Maya", feeling_better: true }, ctx)).rejects.toThrow(/no active health watch/);
		await expect(action.normalize({ health_person: "Maya", health_symptom: "x", health_severity: "dying" }, ctx)).rejects.toThrow(/Severity/);
		await expect(action.normalize({ health_person: "Maya", health_symptom: "x", check_in_hours: 2.5 }, ctx)).rejects.toThrow(/check_in_hours/);
		await expect(action.normalize({ health_symptom: "x" }, ctx)).rejects.toThrow(/who/);
	});

	it("ends a watch when they're feeling better", async () => {
		pool.query.mockResolvedValueOnce(active());
		const p = await action.normalize({ health_person: "Thomas Bryson", feeling_better: true }, ctx);
		expect(p).toEqual({ watch_uuid: "w1", person_name: "Thomas Bryson", feeling_better: true });
		pool.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([[row({ uuid: "w1", status: "resolved" })]]);
		await expect(action.execute(1, p)).resolves.toEqual({ ref: "w1", detail: null });
	});

	it("never treats a second reading as a repeat", () => {
		expect(action.sameAs({ reading: "101" }, { reading: "101" })).toBe(false);
	});
});
