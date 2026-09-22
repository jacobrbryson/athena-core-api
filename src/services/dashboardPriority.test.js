/**
 * Card ordering.
 *
 * The thing worth testing here is not whether the model ranks well — it is
 * whether a bad answer can damage the dashboard. An ordering is a rendering
 * hint over a fixed set of cards, so every path has to end with all of them,
 * once each, whatever came back. A dropped card is a section of
 * someone's day that silently stops existing.
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
	it("uses the model's order when it answers with every card", async () => {
		const model = ["notifications", "calendar", "health", "work", "family", "mail", "projects", "news"];
		llm.generateJson.mockResolvedValue({ data: { order: model.map((id) => ({ id, why: `${id} reason` })) }, model: "test" });

		const result = await priority.getPriority(profile, {});

		expect(result.source).toBe("athena");
		expect(result.order.map((e) => e.id)).toEqual(model);
		expect(result.order[0].why).toBe("notifications reason");
	});

	it("appends anything the model left out rather than dropping the card", async () => {
		llm.generateJson.mockResolvedValue({ data: { order: [{ id: "work", why: "three issues" }] }, model: "test" });

		const { order } = await priority.getPriority(profile, {});

		expect(order[0]).toEqual({ id: "work", why: "three issues" });
		expect(order.map((e) => e.id).sort()).toEqual([...ALL].sort());
	});

	it("discards ids it does not know and repeats of ones it does", async () => {
		llm.generateJson.mockResolvedValue({
			data: { order: [{ id: "news" }, { id: "news" }, { id: "inbox" }, { id: "calendar" }] },
			model: "test",
		});

		const { order } = await priority.getPriority(profile, {});

		expect(order.slice(0, 2).map((e) => e.id)).toEqual(["news", "calendar"]);
		expect(order).toHaveLength(ALL.length);
		expect(order.map((e) => e.id)).not.toContain("inbox");
	});

	it("falls back to the declared order, marked as such, when the model is down", async () => {
		llm.generateJson.mockRejectedValue(new Error("no endpoint available"));

		const result = await priority.getPriority(profile, {});

		expect(result.source).toBe("default");
		expect(result.order.map((e) => e.id)).toEqual(ALL);
		expect(result.order.every((e) => e.why === null)).toBe(true);
	});

	it("does not memoise a fallback, so the next open can still be ranked", async () => {
		llm.generateJson.mockRejectedValueOnce(new Error("down"));
		expect((await priority.getPriority(profile, {})).source).toBe("default");

		llm.generateJson.mockResolvedValue({ data: { order: ALL.map((id) => ({ id })) }, model: "test" });
		expect((await priority.getPriority(profile, {})).source).toBe("athena");
	});

	it("serves a ranked order from memory instead of asking again", async () => {
		llm.generateJson.mockResolvedValue({ data: { order: ALL.map((id) => ({ id })) }, model: "test" });

		await priority.getPriority(profile, {});
		await priority.getPriority(profile, {});

		expect(llm.generateJson).toHaveBeenCalledTimes(1);
	});

	it("reranks when the pending decisions change even within the TTL", async () => {
		llm.generateJson.mockResolvedValue({ data: { order: ALL }, model: 'test' });
		await priority.getPriority(profile, {});
		actions.listPending.mockResolvedValue([]);
		await priority.getPriority(profile, {});
		expect(llm.generateJson).toHaveBeenCalledTimes(2);
	});

	it("coalesces model generation for simultaneous identical signal sheets", async () => {
		llm.generateJson.mockResolvedValue({ data: { order: ALL }, model: 'test' });
		await Promise.all(Array.from({ length: 10 }, () => priority.getPriority(profile, {})));
		expect(llm.generateJson).toHaveBeenCalledTimes(1);
	});

	it("re-ranks after the data is declared stale", async () => {
		llm.generateJson.mockResolvedValue({ data: { order: ALL.map((id) => ({ id })) }, model: "test" });

		await priority.getPriority(profile, {});
		priority.invalidate(profile);
		await priority.getPriority(profile, {});

		expect(llm.generateJson).toHaveBeenCalledTimes(2);
	});

	it("rejects a model answer that does not cover every card", async () => {
		llm.generateJson.mockResolvedValue({ data: { order: ALL.map((id) => ({ id })) }, model: "test" });
		await priority.getPriority(profile, {});

		const { check } = llm.generateJson.mock.calls[0][0];
		expect(check({ order: ALL.map((id) => ({ id })) })).toBe(true);
		expect(check({ order: [{ id: "news" }] })).toEqual(expect.any(String));
		expect(check({ order: "not a list" })).toEqual(expect.any(String));
	});

	it("still answers when the dashboard itself cannot be read", async () => {
		dashboard.cachedDashboard.mockReturnValue(null);
		dashboard.getDashboard.mockRejectedValue(new Error("providers unavailable"));

		const result = await priority.getPriority(profile, {});

		expect(result.source).toBe("default");
		expect(result.order.map((e) => e.id)).toEqual(ALL);
		expect(llm.generateJson).not.toHaveBeenCalled();
	});

	describe("an empty card cannot outrank a full one", () => {
		it("sinks the notifications card when nothing is awaiting approval", async () => {
			// The reported bug: an empty bell ranked above a calendar holding
			// the day's meetings, on the strength of its name alone.
			quietExceptCalendar();
			llm.generateJson.mockResolvedValue({
				data: { order: ["notifications", "calendar", "health", "family", "work", "projects", "news"].map((id) => ({ id, why: `${id} reason` })) },
				model: "test",
			});

			const { order } = await priority.getPriority(profile, {});

			expect(order[0].id).toBe("calendar");
			expect(order.map((e) => e.id).indexOf("notifications")).toBeGreaterThan(
				order.map((e) => e.id).indexOf("calendar")
			);
			expect(order).toHaveLength(ALL.length);
		});

		it("drops the reason from a card it demoted, so no line claims content that is not there", async () => {
			quietExceptCalendar();
			llm.generateJson.mockResolvedValue({
				data: { order: ["notifications", "calendar", "health", "family", "work", "projects", "news"].map((id) => ({ id, why: `${id} reason` })) },
				model: "test",
			});

			const { order } = await priority.getPriority(profile, {});

			expect(order.find((e) => e.id === "notifications").why).toBeNull();
			// A card that kept its place keeps its reason.
			expect(order.find((e) => e.id === "calendar").why).toBe("calendar reason");
		});

		it("leaves a full card where the model put it, bell included", async () => {
			// The default fixture HAS a pending approval, so notifications is
			// not empty and the floor must not touch it.
			llm.generateJson.mockResolvedValue({
				data: { order: ["notifications", "calendar", "health", "work", "family", "projects", "news"].map((id) => ({ id, why: `${id} reason` })) },
				model: "test",
			});

			const { order } = await priority.getPriority(profile, {});

			expect(order[0]).toEqual({ id: "notifications", why: "notifications reason" });
		});

		it("never sinks News, whose feeds this sheet cannot see", async () => {
			quietExceptCalendar();
			llm.generateJson.mockResolvedValue({
				data: { order: ["news", "calendar", "health", "family", "work", "projects", "notifications"].map((id) => ({ id })) },
				model: "test",
			});

			const { order } = await priority.getPriority(profile, {});

			expect(order.slice(0, 2).map((e) => e.id)).toEqual(["news", "calendar"]);
		});

		it("does not rank at all when every card is empty", async () => {
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
			expect(result.order.map((e) => e.id)).toEqual(ALL);
		});

		it("tells the model which cards are empty", async () => {
			quietExceptCalendar();
			llm.generateJson.mockResolvedValue({ data: { order: ALL.map((id) => ({ id })) }, model: "test" });

			await priority.getPriority(profile, {});
			const [sheet] = llm.generateJson.mock.calls[0][0].contents[0].parts[0].text.split("Put them in the order");

			expect(sheet).toContain('"empty": true');
			expect(sheet).toContain('"empty": false');
			// An empty bell must not describe a decision that is not waiting.
			expect(sheet).toContain("Nothing is waiting on a decision.");
		});
	});

	it("sends counts and timings, never raw provider payloads", async () => {
		llm.generateJson.mockResolvedValue({ data: { order: ALL.map((id) => ({ id })) }, model: "test" });

		await priority.getPriority(profile, {});
		const prompt = llm.generateJson.mock.calls[0][0].contents[0].parts[0].text;

		expect(prompt).toContain('"awaitingYourApproval": 1');
		expect(prompt).toContain('"assignedOpenIssues": 1');
		// A card whose own source is missing says so, so it can sink.
		expect(prompt).toContain('"source":');
		// A disconnected sub-source reads as null, never as a zero: "no Slack
		// mentions" and "no Slack" should not rank the same.
		expect(prompt).toContain('"slackMentions": null');
		// The sheet carries the next event's title, not the attendees, links or
		// descriptions that came with it — and no account addresses.
		expect(prompt).toContain('"nextEventTitle": "Design review"');
		expect(prompt).not.toContain("a@b.c");
	});
});
