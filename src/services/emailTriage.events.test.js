/**
 * flagKnownEvents — the Mail page shouldn't offer to add an event that is
 * already over or already on a calendar. It only reads, and a calendar that
 * can't be read must leave everything offered.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./connectors/gmail", () => ({}));
jest.mock("./llm", () => ({ generateJson: jest.fn() }));
jest.mock("./deliveries", () => ({ looksLikeDelivery: jest.fn(() => false), fromEmail: jest.fn() }));
jest.mock("./connectors/googleCalendar", () => ({ listEvents: jest.fn() }));

const calendar = require("./connectors/googleCalendar");
const { flagKnownEvents } = require("./emailTriage");

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const item = (uuid, title, start) => ({ uuid, title, start });

beforeEach(() => {
	jest.clearAllMocks();
	jest.spyOn(console, "warn").mockImplementation(() => {});
});

test("marks past dates without touching the calendar when nothing else is left", async () => {
	const items = [item("a", "Early release day", day(-35))];
	await flagKnownEvents(7, items);
	expect(items[0].past).toBe(true);
	expect(calendar.listEvents).not.toHaveBeenCalled();
});

test("marks an upcoming event already on the calendar, matching a Google Calendar notification's title", async () => {
	calendar.listEvents.mockResolvedValue([{ title: "Early release day", start: day(5) }]);
	const items = [
		item("a", "Notification: Early release day @ Wed Nov 4", day(5)),
		item("b", "Early release day", day(6)),
		item("c", "Picture day", day(5)),
	];
	await flagKnownEvents(7, items);
	expect(items.map((i) => i.on_calendar)).toEqual([true, false, false]);
	expect(items.map((i) => i.past)).toEqual([false, false, false]);
});

test("a past event is not also called a duplicate", async () => {
	calendar.listEvents.mockResolvedValue([{ title: "Picture day", start: day(-3) }]);
	const items = [item("a", "Picture day", day(-3)), item("b", "Flight", day(4))];
	await flagKnownEvents(7, items);
	expect(items[0]).toMatchObject({ past: true, on_calendar: false });
	expect(items[1]).toMatchObject({ past: false, on_calendar: false });
});

test("leaves everything offered when the calendar can't be read", async () => {
	calendar.listEvents.mockRejectedValue(new Error("needs re-auth"));
	const items = [item("a", "Flight", day(4))];
	await flagKnownEvents(7, items);
	expect(items[0].on_calendar).toBeUndefined();
	expect(items[0].past).toBe(false);
});

test("ignores emails with no date", async () => {
	const items = [item("a", "Newsletter", null)];
	await flagKnownEvents(7, items);
	expect(calendar.listEvents).not.toHaveBeenCalled();
	expect(items[0].past).toBeUndefined();
});
