/**
 * Card order and the dashboard alert.
 *
 * The order is fixed — Health & Performance first — and no model answer may
 * move it (owner, 2026-09-26). The model is asked only whether anything
 * deserves the alert banner.
 */
jest.mock("./llm", () => ({ generateJson: jest.fn() }));
jest.mock('../helpers/db', () => ({ query: jest.fn(async () => [[]]) }));
jest.mock('../helpers/crypto', () => ({ encrypt: async value => value, decrypt: async value => value }));
jest.mock("./dashboard", () => ({ cachedDashboard: jest.fn(), getDashboard: jest.fn() }));
jest.mock("./actions", () => ({ listPending: jest.fn() }));

const llm = require("./llm");
const dashboard = require("./dashboard");
const actions = require("./actions");
const priority = require("./dashboardPriority");

const ALL = priority.CARDS.map((c) => c.id);
const source = (status, data = null) => ({ status, data, checkedAt: "now" });

/** A dashboard with enough in it to describe, and one pending approval. */
function ready() {
	dashboard.cachedDashboard.mockReturnValue({
		calendar: source("ready", { events: [{ title: "Design review", start: new Date(Date.now() + 1800_000).toISOString(), allDay: false }], timeZone: "UTC", days: 7 }),
		recovery: source("ready", [{ date: "2026-09-18", recovery_score: 34, state: "SCORED" }]),
		sleep: source("ready", [{ date: "2026-09-18", nap: false, hours_asleep: 5.4, sleep_performance_percent: 62 }]),
		strain: source("ready", [{ date: "2026-09-18", day_strain: 14.2 }]),
		activity: source("not_connected"),
		familyChores: source("ready", { name: "F", chores: [{ title: "Dishes", completed: false }] }),
		jira: source("ready", { issues: [{ key: "A-1", project: "Athena" }], partial: false }),
		slack: source("not_connected"),
		emailTriage: source("ready", { newCount: 3, receiptCount: 2, travelCount: 1, schoolCount: 0, otherCount: 0, preview: [] }),
	});
	actions.listPending.mockResolvedValue([{ uuid: "a1" }]);
}

/** Everything connected but empty, except a calendar with the day in it. */
function quietExceptCalendar() {
	dashboard.cachedDashboard.mockReturnValue({
		calendar: source("ready", { events: [{ title: "Design review", start: new Date(Date.now() + 1800_000).toISOString(), allDay: false }], timeZone: "UTC", days: 7 }),
		recovery: source("ready", []),
		sleep: source("ready", []),
		strain: source("ready", []),
		activity: source("ready", { days: 7, activities: [] }),
		familyChores: source("ready", { name: "F", chores: [] }),
		jira: source("ready", { issues: [], partial: false }),
		slack: source("ready", { workspace: "w", messages: [] }),
		emailTriage: source("ready", { newCount: 0, receiptCount: 0, travelCount: 0, schoolCount: 0, otherCount: 0, preview: [] }),
	});
	actions.listPending.mockResolvedValue([]); // nothing awaiting approval
}

let profile = 0;
beforeEach(() => {
	jest.clearAllMocks();
	profile += 1; // a fresh profile id, so the memo never leaks between tests
	ready();
});

describe("getPriority", () => {
	it("keeps the fixed order, health first, whatever the model says", async () => {
		llm.generateJson.mockResolvedValue({
			data: { order: [{ id: "notifications" }, { id: "calendar" }], alert: null },
			model: "test",
		});

		const result = await priority.getPriority(profile, {});

		expect(ALL[0]).toBe("health");
		expect(result.order.map((e) => e.id)).toEqual(ALL);
		expect(result.order.every((e) => e.why === null)).toBe(true);
	});

	it("does not ask the model to order anything", async () => {
		llm.generateJson.mockResolvedValue({ data: { alert: null }, model: "test" });
		await priority.getPriority(profile, {});
		const prompt = llm.generateJson.mock.calls[0][0].contents[0].parts[0].text;
		expect(prompt).not.toMatch(/order this person should look/i);
		expect(prompt).not.toContain('"order"');
	});

	it("passes the model's alert through", async () => {
		llm.generateJson.mockResolvedValue({
			data: { alert: { level: "watch", headline: "Low recovery, heavy day", body: "Take it easy." } },
			model: "test",
		});

		const result = await priority.getPriority(profile, {});

		expect(result.source).toBe("athena");
		expect(result.alert).toEqual(expect.objectContaining({ level: "watch", headline: "Low recovery, heavy day" }));
	});

	it("falls back to the fixed order, marked as such, when the model is down", async () => {
		llm.generateJson.mockRejectedValue(new Error("no endpoint available"));

		const result = await priority.getPriority(profile, {});

		expect(result.source).toBe("default");
		expect(result.order.map((e) => e.id)).toEqual(ALL);
		expect(result.alert).toBeNull();
	});

	it("does not memoise a fallback, so the next open can still be assessed", async () => {
		llm.generateJson.mockRejectedValueOnce(new Error("down"));
		expect((await priority.getPriority(profile, {})).source).toBe("default");

		llm.generateJson.mockResolvedValue({ data: { alert: null }, model: "test" });
		expect((await priority.getPriority(profile, {})).source).toBe("athena");
	});

	it("serves a judgement from memory instead of asking again", async () => {
		llm.generateJson.mockResolvedValue({ data: { alert: null }, model: "test" });

		await priority.getPriority(profile, {});
		await priority.getPriority(profile, {});

		expect(llm.generateJson).toHaveBeenCalledTimes(1);
	});

	it("re-assesses when the pending decisions change even within the TTL", async () => {
		llm.generateJson.mockResolvedValue({ data: { alert: null }, model: "test" });
		await priority.getPriority(profile, {});
		actions.listPending.mockResolvedValue([]);
		await priority.getPriority(profile, {});
		expect(llm.generateJson).toHaveBeenCalledTimes(2);
	});

	it("coalesces model generation for simultaneous identical signal sheets", async () => {
		llm.generateJson.mockResolvedValue({ data: { alert: null }, model: "test" });
		await Promise.all(Array.from({ length: 10 }, () => priority.getPriority(profile, {})));
		expect(llm.generateJson).toHaveBeenCalledTimes(1);
	});

	it("re-assesses after the data is declared stale", async () => {
		llm.generateJson.mockResolvedValue({ data: { alert: null }, model: "test" });

		await priority.getPriority(profile, {});
		priority.invalidate(profile);
		await priority.getPriority(profile, {});

		expect(llm.generateJson).toHaveBeenCalledTimes(2);
	});

	it("rejects a model answer without an alert field", async () => {
		llm.generateJson.mockResolvedValue({ data: { alert: null }, model: "test" });
		await priority.getPriority(profile, {});

		const { check } = llm.generateJson.mock.calls[0][0];
		expect(check({ alert: null })).toBe(true);
		expect(check({ order: [] })).toEqual(expect.any(String));
		expect(check(null)).toEqual(expect.any(String));
	});

	it("still answers when the dashboard itself cannot be read", async () => {
		dashboard.cachedDashboard.mockReturnValue(null);
		dashboard.getDashboard.mockRejectedValue(new Error("providers unavailable"));

		const result = await priority.getPriority(profile, {});

		expect(result.source).toBe("default");
		expect(result.order.map((e) => e.id)).toEqual(ALL);
		expect(llm.generateJson).not.toHaveBeenCalled();
	});

	it("does not call the model when every card is empty", async () => {
		quietExceptCalendar();
		dashboard.cachedDashboard.mockReturnValue({
			calendar: source("ready", { events: [], timeZone: "UTC", days: 7 }),
			recovery: source("not_connected"), sleep: source("not_connected"),
			strain: source("not_connected"), activity: source("not_connected"),
			familyChores: source("not_connected"), jira: source("not_connected"),
			slack: source("not_connected"), emailTriage: source("not_connected"),
		});

		const result = await priority.getPriority(profile, {});

		expect(llm.generateJson).not.toHaveBeenCalled();
		expect(result.source).toBe("default");
	});

	it("tells the model which cards are empty", async () => {
		quietExceptCalendar();
		llm.generateJson.mockResolvedValue({ data: { alert: null }, model: "test" });

		await priority.getPriority(profile, {});
		const prompt = llm.generateJson.mock.calls[0][0].contents[0].parts[0].text;

		expect(prompt).toContain('"empty": true');
		expect(prompt).toContain('"empty": false');
		// An empty bell must not describe a decision that is not waiting.
		expect(prompt).toContain("Nothing is waiting on a decision.");
	});

	it("sends counts and timings, never raw provider payloads", async () => {
		llm.generateJson.mockResolvedValue({ data: { alert: null }, model: "test" });

		await priority.getPriority(profile, {});
		const prompt = llm.generateJson.mock.calls[0][0].contents[0].parts[0].text;

		expect(prompt).toContain('"awaitingYourApproval": 1');
		expect(prompt).toContain('"assignedOpenIssues": 1');
		expect(prompt).toContain('"source":');
		expect(prompt).toContain('"slackMentions": null');
		expect(prompt).toContain('"nextEventTitle": "Design review"');
		expect(prompt).not.toContain("a@b.c");
	});
});
