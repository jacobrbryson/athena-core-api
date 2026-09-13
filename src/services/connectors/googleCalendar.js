const { providerGet, providerRequest } = require("./http");

/**
 * Google Calendar reads.
 *
 * Read-only by design: Athena answers "am I free Thursday?" and "what's on
 * today?" but does not create or move anything yet. Writing to someone's
 * calendar is a different consent conversation, and the scopes requested in
 * registry.js are readonly to match.
 */

const PROVIDER = "google_calendar";
const MAX_EVENTS = 25;

const KEYWORDS =
	/\b(calendar|schedule|scheduled|appointment|appointments|meeting|meetings|event|events|busy|free|availability|available|agenda|booked|what('?s| is) on)\b/i;

/** Cheap gate: is this message plausibly about the user's calendar? */
function matches(message) {
	return typeof message === "string" && KEYWORDS.test(message);
}

const iso = (date) => new Date(date).toISOString();

/** Start of today through `days` later, as RFC3339 — the window Athena reads. */
function window(days = 7, from = new Date()) {
	const start = new Date(from);
	start.setHours(0, 0, 0, 0);
	const end = new Date(start);
	end.setDate(end.getDate() + Math.max(1, Math.min(Number(days) || 7, 60)));
	return { timeMin: iso(start), timeMax: iso(end) };
}

/**
 * Upcoming events on the primary calendar.
 *
 * singleEvents=true expands recurring events into their individual
 * occurrences, which is what a person means by "what's on Thursday";
 * orderBy=startTime is only legal alongside it.
 */
async function listEvents(profileId, { days = 7, maxResults = MAX_EVENTS } = {}) {
	const { timeMin, timeMax } = window(days);
	const data = await providerGet(profileId, PROVIDER, "/calendars/primary/events", {
		query: {
			timeMin,
			timeMax,
			singleEvents: "true",
			orderBy: "startTime",
			maxResults: Math.min(Number(maxResults) || MAX_EVENTS, MAX_EVENTS),
		},
	});
	return (data?.items || []).map(normalizeEvent);
}

/** Busy intervals on the primary calendar — cheaper than listing events. */
async function freeBusy(profileId, { days = 7 } = {}) {
	const { timeMin, timeMax } = window(days);
	const data = await providerRequest(profileId, PROVIDER, "/freeBusy", {
		method: "POST",
		body: { timeMin, timeMax, items: [{ id: "primary" }] },
	});
	const busy = data?.calendars?.primary?.busy || [];
	return busy.map((b) => ({ start: b.start, end: b.end }));
}

function normalizeEvent(item) {
	// All-day events carry `date`; timed ones carry `dateTime`.
	const start = item.start?.dateTime || item.start?.date || null;
	const end = item.end?.dateTime || item.end?.date || null;
	return {
		title: item.summary || "(no title)",
		start,
		end,
		allDay: !item.start?.dateTime,
		location: item.location || null,
		status: item.status || null,
		attendees: Array.isArray(item.attendees) ? item.attendees.length : 0,
	};
}

function formatEvent(event) {
	if (event.allDay) return `- ${event.start} (all day) — ${event.title}`;
	const when = new Date(event.start);
	const day = when.toISOString().slice(0, 10);
	const time = when.toISOString().slice(11, 16);
	const where = event.location ? ` @ ${event.location}` : "";
	return `- ${day} ${time}Z — ${event.title}${where}`;
}

/**
 * Plain-text grounding block for the system prompt, or null when there is
 * nothing useful to say. Never throws: a calendar failure must not sink a
 * conversation.
 */
async function buildContext(profileId, { days = 7 } = {}) {
	const events = await listEvents(profileId, { days });
	if (!events.length) {
		return `Google Calendar: nothing scheduled in the next ${days} days.`;
	}
	const lines = events.map(formatEvent);
	return [
		`Google Calendar — next ${days} days (times are UTC):`,
		...lines,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Gemini tools
// ---------------------------------------------------------------------------

const FUNCTION_DECLARATIONS = [
	{
		name: "get_calendar_events",
		description:
			"List the user's upcoming Google Calendar events. Use for any question " +
			"about what is scheduled, what is coming up, what is on a particular day, " +
			"or when something is. Recurring events are expanded into individual " +
			"occurrences. Times are returned in UTC (ISO 8601).",
		parameters: {
			type: "OBJECT",
			properties: {
				days: {
					type: "NUMBER",
					description:
						"How many days ahead to look, starting from the beginning of " +
						"today. Use 1 for today, 2 for today and tomorrow, 7 for the " +
						"week. Maximum 60.",
				},
			},
		},
	},
	{
		name: "get_calendar_free_busy",
		description:
			"Get the user's BUSY time ranges without event details. Use for " +
			'"am I free", "when am I available", or finding a slot — it is cheaper ' +
			"and more private than listing events. Times are UTC (ISO 8601).",
		parameters: {
			type: "OBJECT",
			properties: {
				days: {
					type: "NUMBER",
					description: "How many days ahead to check, from the start of today. Max 60.",
				},
			},
		},
	},
];

async function executeTool(name, args = {}, { profileId }) {
	if (name === "get_calendar_events") {
		return { events: await listEvents(profileId, { days: args.days }) };
	}
	if (name === "get_calendar_free_busy") {
		return { busy: await freeBusy(profileId, { days: args.days }) };
	}
	throw new Error(`Unknown Google Calendar tool: ${name}`);
}

module.exports = {
	PROVIDER,
	matches,
	listEvents,
	freeBusy,
	buildContext,
	FUNCTION_DECLARATIONS,
	executeTool,
	// exported for tests
	normalizeEvent,
	window,
};
