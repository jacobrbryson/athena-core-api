/**
 * update_calendar_event — filling in an event already on the person's own
 * calendar (owner, 2026-11-10). Narrower than create: primary calendar only,
 * location / description / times only, never standing.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("../consent", () => ({ hasConsentForProfile: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn() }));
jest.mock("../family", () => ({ getFamilyForProfile: jest.fn() }));
jest.mock("../connectors/googleCalendar", () => ({ createEvent: jest.fn(), deleteEvent: jest.fn(), getEvent: jest.fn(), updateEvent: jest.fn() }));
jest.mock("../lookRequests", () => ({ create: jest.fn() }));
jest.mock("../memory", () => ({ CATEGORIES: new Set(["other"]), upsertMemoryForProfile: jest.fn() }));

const calendar = require("../connectors/googleCalendar");
const registry = require("./registry");

const action = registry.get("update_calendar_event");
const ctx = { profileId: 7 };
const soon = (h) => new Date(Date.now() + h * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const dentist = () => ({ id: "ev1", title: "Dentist", start: soon(48), end: soon(49), allDay: false, location: null, description: "" });

beforeEach(() => {
	jest.clearAllMocks();
	calendar.getEvent.mockResolvedValue(dentist());
	calendar.updateEvent.mockResolvedValue({ ref: "ev1", html_link: "https://cal/ev1" });
});

test("asks every time and writes the calendar", () => {
	expect(action).toMatchObject({ provider: "google_calendar", consentType: "action_authority", standing: false });
	expect(action.direct).toBeFalsy();
});

test("adds a missing address", async () => {
	const p = await action.normalize({ event_id: "ev1", location: "12 Main St" }, ctx);
	expect(calendar.getEvent).toHaveBeenCalledWith(7, "ev1");
	expect(p).toEqual({ event_id: "ev1", title: "Dentist", location: "12 Main St" });
	expect(action.summarize(p)).toBe('Update "Dentist" on your calendar: add the address 12 Main St');
});

test("appends to an existing description rather than replacing it", async () => {
	calendar.getEvent.mockResolvedValue({ ...dentist(), description: "Dr. Lee" });
	const p = await action.normalize({ event_id: "ev1", description: "Bring the insurance card" }, ctx);
	expect(p.description).toBe("Dr. Lee\n\nBring the insurance card");
	expect(p.added_description).toBe("Bring the insurance card");
});

test("moving it keeps the event's length", async () => {
	const ev = dentist();
	const start = new Date(Date.parse(ev.start) + 2 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
	const p = await action.normalize({ event_id: "ev1", start }, ctx);
	expect(Date.parse(p.end) - Date.parse(p.start)).toBe(3600_000);
	expect(p.was_start).toBe(ev.start);
});

test("refuses guests, other calendars, renames, unknown events and no-ops", async () => {
	await expect(action.normalize({ event_id: "ev1", location: "x", attendees: ["a@b.c"] }, ctx)).rejects.toThrow(/invite/);
	await expect(action.normalize({ event_id: "ev1", location: "x", calendar_id: "family" }, ctx)).rejects.toThrow(/primary/);
	await expect(action.normalize({ event_id: "ev1", title: "Other" }, ctx)).rejects.toThrow(/rename/);
	await expect(action.normalize({ location: "x" }, ctx)).rejects.toThrow(/event_id/);
	calendar.getEvent.mockResolvedValueOnce(null);
	await expect(action.normalize({ event_id: "nope", location: "x" }, ctx)).rejects.toThrow(/own calendar/);
	calendar.getEvent.mockResolvedValueOnce({ ...dentist(), location: "12 Main St" });
	await expect(action.normalize({ event_id: "ev1", location: "12 Main St" }, ctx)).rejects.toThrow(/already has/);
});

test("will not move an event into the past or change an all-day one's time", async () => {
	await expect(action.normalize({ event_id: "ev1", start: soon(-72) }, ctx)).rejects.toThrow(/past/);
	calendar.getEvent.mockResolvedValueOnce({ ...dentist(), allDay: true, start: "2030-01-01", end: "2030-01-02" });
	await expect(action.normalize({ event_id: "ev1", start: soon(10) }, ctx)).rejects.toThrow(/all-day/);
});

test("executes as a PATCH of only what changed", async () => {
	const p = await action.normalize({ event_id: "ev1", location: "12 Main St" }, ctx);
	await expect(action.execute(7, p)).resolves.toEqual({ ref: "ev1", detail: { html_link: "https://cal/ev1" } });
	expect(calendar.updateEvent).toHaveBeenCalledWith(7, { event_id: "ev1", location: "12 Main St" });
});
