/**
 * add_email_events — the Mail card's events bundle. Every item must pass the
 * single-email action's own rules, and one bad event must not sink the rest.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("../consent", () => ({ hasConsentForProfile: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn() }));
jest.mock("../family", () => ({ getFamilyForProfile: jest.fn() }));
jest.mock("../connectors/googleCalendar", () => ({ createEvent: jest.fn(), deleteEvent: jest.fn() }));
jest.mock("../lookRequests", () => ({ create: jest.fn() }));
jest.mock("../memory", () => ({ CATEGORIES: new Set(["other"]), upsertMemoryForProfile: jest.fn() }));
jest.mock("../emailTriage", () => ({ getRowsByUuids: jest.fn(), markStatus: jest.fn() }));
jest.mock("../connectors/gmail", () => ({ fileMessage: jest.fn() }));

const emailTriage = require("../emailTriage");
const gmail = require("../connectors/gmail");
const googleCalendar = require("../connectors/googleCalendar");
const registry = require("./registry");

const events = registry.get("add_email_events");
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const item = (n, extra = {}) => ({ email_triage_uuid: uuid(n), label: "Travel", title: `Trip ${n}`, start: day(n + 3), all_day: true, ...extra });

beforeEach(() => jest.clearAllMocks());

test("needs its own approval every time and writes to the calendar", () => {
	expect(events).toMatchObject({ provider: "google_calendar", consentType: "action_authority", reversible: true, standing: false });
});

test("every item passes the single-email rules; one bad item refuses the whole proposal", () => {
	const ok = events.normalize({ items: [item(1), item(2), item(1)] });
	expect(ok.items.map((i) => i.email_triage_uuid)).toEqual([uuid(1), uuid(2)]);
	expect(ok.items[0].event).toMatchObject({ title: "Trip 1", all_day: true });
	expect(() => events.normalize({ items: [item(1), item(2, { start: "next tuesday" })] })).toThrow(/YYYY-MM-DD/);
	expect(() => events.normalize({ items: [item(1, { title: "" })] })).toThrow(/title/);
	expect(() => events.normalize({ items: Array.from({ length: 11 }, (_, i) => item(i)) })).toThrow(/Too many/);
	expect(() => events.normalize({})).toThrow(/at least one/);
});

test("the summary names the events, not just a count", () => {
	const p = events.normalize({ items: [item(1), item(2)] });
	expect(events.summarize(p)).toMatch(/Add 2 events to your calendar — "Trip 1" \(all day .*\), "Trip 2"/);
});

test("adds what it can, skips mail dealt with since, and reports a failed event without undoing the rest", async () => {
	emailTriage.getRowsByUuids.mockResolvedValue([
		{ uuid: uuid(1), gmail_message_id: "g1", status: "new" },
		{ uuid: uuid(2), gmail_message_id: "g2", status: "new" },
		{ uuid: uuid(3), gmail_message_id: "g3", status: "archived" },
	]);
	googleCalendar.createEvent.mockImplementation(async (_p, e) => {
		if (e.title === "Trip 2") throw new Error("calendar refused");
		return { ref: `evt-${e.title}` };
	});
	gmail.fileMessage.mockRejectedValueOnce(new Error("needs reauth"));
	const p = events.normalize({ items: [item(1), item(2), item(3)] });
	const r = await events.execute(42, p);
	expect(googleCalendar.createEvent).toHaveBeenCalledTimes(2);
	expect(r.detail).toEqual({ added: 1, filed: 0, failed: 1 });
	expect(emailTriage.markStatus).toHaveBeenCalledWith(42, [uuid(1)], "actioned");
});

test("fails honestly when nothing could be added", async () => {
	emailTriage.getRowsByUuids.mockResolvedValue([{ uuid: uuid(1), gmail_message_id: "g1", status: "new" }]);
	googleCalendar.createEvent.mockRejectedValue(new Error("down"));
	await expect(events.execute(42, events.normalize({ items: [item(1)] }))).rejects.toThrow(/could be added/);
	expect(emailTriage.markStatus).not.toHaveBeenCalled();
});
