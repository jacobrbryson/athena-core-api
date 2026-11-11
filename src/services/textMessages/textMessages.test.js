/**
 * Reading incoming texts (owner, 2026-11-10). What matters most:
 *   - nothing is read by a model unless initiative is on;
 *   - the text itself is never stored, only a hash and an outcome;
 *   - nothing is proposed or written until the person taps, and then only
 *     through the action layer (attempt + confirm);
 *   - quiet hours hold the push rather than drop it.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../llm", () => ({ generateJson: jest.fn() }));
jest.mock("../actions/registry", () => ({
	get: (id) => ({
		normalize: async (p) => p,
		summarize: (p) => (id === "update_calendar_event" ? `Update "${p.event_id}" on your calendar: add the address ${p.location}` : `Add "${p.title}" to your calendar: ${p.start}`),
	}),
}));

const pool = require("../../helpers/db");
const llm = require("../llm");
const texts = require("./index");

const TZ = "America/New_York";
const NOW = new Date("2026-11-10T15:00:00Z");

function fakeDb() {
	const state = { messages: [], suggestions: [], nudges: [], updates: [] };
	pool.query.mockImplementation(async (sql, args = []) => {
		if (/^DELETE/.test(sql)) return [{ affectedRows: 0 }];
		if (/INSERT IGNORE INTO athena_text_message/.test(sql)) {
			if (state.messages.some((m) => m.key === args[1])) return [{ affectedRows: 0 }];
			state.messages.push({ id: state.messages.length + 1, key: args[1], length: args[2], args });
			return [{ affectedRows: 1, insertId: state.messages.length }];
		}
		if (/INSERT INTO athena_text_suggestion/.test(sql)) {
			state.suggestions.push({ uuid: args[0], kind: args[3], action_id: args[6], params: args[7], summary: args[8], reply_text: args[9], nudge_uuid: args[10], status: "open" });
			return [{ affectedRows: 1 }];
		}
		if (/INSERT IGNORE INTO athena_nudge/.test(sql)) {
			state.nudges.push({ uuid: args[0], trigger: args[2], text: args[4] });
			return [{ affectedRows: 1 }];
		}
		state.updates.push({ sql, args });
		if (/SELECT \* FROM athena_text_suggestion/.test(sql)) {
			const s = state.suggestions.find((x) => x.uuid === args[0]);
			return [s ? [{ id: 1, ...s, expires_at: new Date(Date.now() + 3600_000), sender_label: "Mom" }] : []];
		}
		if (/UPDATE athena_text_suggestion SET status = \?, decided_at/.test(sql)) return [{ affectedRows: 1 }];
		return [{ affectedRows: 1 }];
	});
	return state;
}

function deps({ enabled = true, quiet = false, available = true, events = [] } = {}) {
	return {
		now: () => NOW,
		initiative: {
			getPref: jest.fn().mockResolvedValue({ enabled, timezone: TZ }),
			listMutes: jest.fn().mockResolvedValue([]),
			inQuietHours: jest.fn().mockReturnValue(quiet),
		},
		actions: { availableFor: jest.fn().mockResolvedValue(available ? [{ id: "create_calendar_event" }] : []) },
		calendar: { eventsInInterval: jest.fn().mockResolvedValue({ events }) },
		push: { deliverNudge: jest.fn().mockResolvedValue({ sent: 1 }) },
	};
}

const text = (t, extra = {}) => ({ package: texts.GOOGLE_MESSAGES, thread: "abc", sender: "Mom", text: t, postedAt: NOW.toISOString(), ...extra });

beforeEach(() => jest.clearAllMocks());

test("with initiative off, no model ever sees the text", async () => {
	fakeDb();
	const d = deps({ enabled: false });
	await expect(texts.ingest(1, text("Dentist Thursday at 3"), d)).resolves.toMatchObject({ outcome: "ignored" });
	expect(llm.generateJson).not.toHaveBeenCalled();
	expect(pool.query).not.toHaveBeenCalled();
});

test("other apps and day-old texts are ignored", async () => {
	fakeDb();
	await expect(texts.ingest(1, text("hi", { package: "com.whatsapp" }), deps())).resolves.toMatchObject({ outcome: "ignored" });
	await expect(texts.ingest(1, text("hi", { postedAt: "2026-11-08T00:00:00Z" }), deps())).resolves.toMatchObject({ outcome: "ignored" });
	expect(llm.generateJson).not.toHaveBeenCalled();
});

test("an event not on the calendar becomes an Add suggestion, pushed, with no action proposed yet", async () => {
	const db = fakeDb();
	llm.generateJson.mockResolvedValue({ data: { event: { title: "Dentist", start: "2026-11-13T15:00:00", end: null, all_day: false, location: "12 Main St", description: null }, summary: null, reply: null } });
	const d = deps();
	const out = await texts.ingest(1, text("Reminder: dentist Thursday 3pm at 12 Main St"), d);
	expect(out.outcome).toBe("suggested");
	expect(db.suggestions).toHaveLength(1);
	const params = JSON.parse(db.suggestions[0].params);
	expect(db.suggestions[0].action_id).toBe("create_calendar_event");
	expect(params).toMatchObject({ title: "Dentist", start: "2026-11-13T15:00:00", end: "2026-11-13T16:00:00", time_zone: TZ, location: "12 Main St" });
	expect(db.nudges[0].trigger).toBe("text_calendar");
	expect(d.push.deliverNudge).toHaveBeenCalledTimes(1);
	// The text itself is in no row we wrote.
	const written = JSON.stringify(pool.query.mock.calls.map((c) => c[1]));
	expect(written).not.toMatch(/Reminder: dentist/);
});

test("an event already there but missing its address becomes an Update", async () => {
	const db = fakeDb();
	llm.generateJson.mockResolvedValue({ data: { event: { title: "Dentist appointment", start: "2026-11-13T15:00:00", location: "12 Main St" }, summary: null, reply: null } });
	const events = [{ id: "ev1", title: "Dentist", start: "2026-11-13T20:00:00Z", allDay: false, location: null, description: "", shared: false }];
	await texts.ingest(1, text("Dentist Thursday 3pm, 12 Main St"), deps({ events }));
	expect(db.suggestions[0].action_id).toBe("update_calendar_event");
	expect(JSON.parse(db.suggestions[0].params)).toEqual({ event_id: "ev1", location: "12 Main St" });
});

test("an event already complete on the calendar says nothing", async () => {
	const db = fakeDb();
	llm.generateJson.mockResolvedValue({ data: { event: { title: "Dentist", start: "2026-11-13T15:00:00", location: "12 Main St" }, summary: null, reply: null } });
	const events = [{ id: "ev1", title: "Dentist", start: "2026-11-13T20:00:00Z", allDay: false, location: "12 Main St", description: "", shared: false }];
	await expect(texts.ingest(1, text("Dentist Thursday 3pm"), deps({ events }))).resolves.toMatchObject({ outcome: "nothing" });
	expect(db.suggestions).toHaveLength(0);
});

test("a long text gets a summary and a suggested reply; quiet hours hold the push", async () => {
	const db = fakeDb();
	llm.generateJson.mockResolvedValue({ data: { event: null, summary: "She's asking whether you can host Sunday.", reply: "Yes, Sunday works!" } });
	const d = deps({ quiet: true });
	const out = await texts.ingest(1, text("x".repeat(texts.LONG_TEXT_CHARS)), d);
	expect(out.suggestions[0]).toMatchObject({ kind: "reply", pushed: false, held: true });
	expect(db.suggestions[0]).toMatchObject({ kind: "reply", reply_text: "Yes, Sunday works!" });
	expect(db.nudges[0].trigger).toBe("text_reply");
	expect(d.push.deliverNudge).not.toHaveBeenCalled();
	// A short text is never asked for a summary.
	expect(llm.generateJson.mock.calls[0][0].contents[0].parts[0].text).toMatch(/summary: two or three sentences/);
});

test("the same text twice is read once", async () => {
	fakeDb();
	llm.generateJson.mockResolvedValue({ data: { event: null, summary: null, reply: null } });
	await texts.ingest(1, text("ok see you then"), deps());
	await expect(texts.ingest(1, text("ok see you then"), deps())).resolves.toEqual({ outcome: "duplicate" });
	expect(llm.generateJson).toHaveBeenCalledTimes(1);
});

test("a model outage is recorded as a failure, not as nothing", async () => {
	fakeDb();
	llm.generateJson.mockRejectedValue(new Error("down"));
	await expect(texts.ingest(1, text("Dinner Friday?"), deps())).rejects.toMatchObject({ status: 503 });
	expect(pool.query.mock.calls.some(([sql, args]) => /SET outcome/.test(sql) && args[0] === "failed")).toBe(true);
});

test("approving goes through the action layer: attempt, then confirm with the tap", async () => {
	const db = fakeDb();
	db.suggestions.push({ uuid: "s1", kind: "calendar", action_id: "create_calendar_event", params: JSON.stringify({ title: "Dentist" }), summary: "Add?", status: "open", nudge_uuid: "n1" });
	const actions = {
		attempt: jest.fn().mockResolvedValue({ proposal: { uuid: "a1", status: "pending" }, rejected: null }),
		confirm: jest.fn().mockResolvedValue({ uuid: "a1", status: "done", summary: 'Add "Dentist" to your calendar: Thu' }),
	};
	const out = await texts.decide(1, "s1", "approve", { actions });
	expect(actions.attempt).toHaveBeenCalledWith(1, null, expect.objectContaining({ id: "create_calendar_event", params: { title: "Dentist" } }), expect.anything());
	expect(actions.confirm).toHaveBeenCalledWith(1, "a1");
	expect(out).toMatchObject({ status: "approved", done: 'Added "Dentist" to your calendar: Thu' });
});

test("declining writes nothing to the calendar", async () => {
	const db = fakeDb();
	db.suggestions.push({ uuid: "s2", kind: "calendar", action_id: "create_calendar_event", params: "{}", summary: "Add?", status: "open" });
	const actions = { attempt: jest.fn(), confirm: jest.fn() };
	await expect(texts.decide(1, "s2", "decline", { actions })).resolves.toMatchObject({ status: "declined" });
	expect(actions.attempt).not.toHaveBeenCalled();
});

test("a rejected change at tap time fails honestly", async () => {
	const db = fakeDb();
	db.suggestions.push({ uuid: "s3", kind: "calendar", action_id: "create_calendar_event", params: "{}", summary: "Add?", status: "open" });
	const actions = { attempt: jest.fn().mockResolvedValue({ proposal: null, rejected: { reason: "Athena will not add an event in the past" } }), confirm: jest.fn() };
	await expect(texts.decide(1, "s3", "approve", { actions })).rejects.toThrow(/past/);
	expect(actions.confirm).not.toHaveBeenCalled();
});

test("matching: same words within a day, or the same start time", () => {
	const events = [
		{ id: "a", title: "Soccer practice", start: "2026-11-15T14:00:00Z", allDay: false },
		{ id: "b", title: "Work call", start: "2026-11-15T19:00:00Z", allDay: false },
	];
	expect(texts.findMatch({ title: "Mia soccer", start: "2026-11-15T09:30:00" }, events, TZ)?.id).toBe("a");
	expect(texts.findMatch({ title: "Something", start: "2026-11-15T14:00:00" }, events, TZ)?.id).toBe("b");
	expect(texts.findMatch({ title: "Dentist", start: "2026-11-15T10:00:00" }, events, TZ)).toBeNull();
});

test("local times convert across the zone's own offset", () => {
	expect(texts.localInstant("2026-11-13T15:00:00", TZ).toISOString()).toBe("2026-11-13T20:00:00.000Z");
	expect(texts.localInstant("2026-07-13T15:00:00", TZ).toISOString()).toBe("2026-07-13T19:00:00.000Z");
});
