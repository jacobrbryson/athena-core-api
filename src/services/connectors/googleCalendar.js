const { providerGet, providerRequest, isNotConnected } = require("./http");

/**
 * Google Calendar reads.
 *
 * Read-only by design: Athena answers "am I free Thursday?" and "what's on
 * today?" but does not create or move anything yet. Writing to someone's
 * calendar is a different consent conversation, and the scopes requested in
 * registry.js are readonly to match.
 *
 * EVERY calendar the account can read is included, not just `primary`. Shared
 * household calendars are where most families actually keep their plans, and
 * reading only `primary` made a fully-connected account look empty.
 */

const PROVIDER = "google_calendar";
const MAX_EVENTS = 25;
// A guard against pathological accounts (dozens of subscribed calendars), not
// a product limit. freeBusy also caps out at 50 calendars per request.
const MAX_CALENDARS = 20;
// The calendar list changes rarely and is read twice per turn (events, then
// free/busy). Cached per process, briefly.
const CALENDAR_LIST_TTL_MS = 10 * 60 * 1000;
const CALENDAR_CACHE_MAX = 200;

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

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

/** profileId -> { at: epochMs, calendars: [...] } */
const calendarCache = new Map();

/** The single calendar we can always assume exists, when the list is unusable. */
const PRIMARY_ONLY = [
	{ id: "primary", name: "Calendar", primary: true, timeZone: null },
];

/**
 * Every calendar this account can read, primary first.
 *
 * `showHidden=false` respects what the user has hidden in Google's own UI, so
 * "all calendars" means all the ones they actually look at. minAccessRole
 * reader drops calendars shared with them at free/busy-only access, whose
 * events would come back titleless anyway.
 */
async function listCalendars(profileId) {
	const cached = calendarCache.get(profileId);
	if (cached && Date.now() - cached.at < CALENDAR_LIST_TTL_MS) return cached.calendars;

	const data = await providerGet(profileId, PROVIDER, "/users/me/calendarList", {
		query: { minAccessRole: "reader", showHidden: "false", maxResults: 250 },
	});

	const calendars = (data?.items || [])
		.filter((c) => c && c.id && !c.deleted)
		.map((c) => ({
			id: c.id,
			name: c.summaryOverride || c.summary || c.id,
			primary: !!c.primary,
			// The primary calendar's zone is the account's own calendar setting —
			// the one thing that makes "3pm" mean what the user means by it.
			timeZone: typeof c.timeZone === "string" ? c.timeZone : null,
		}))
		.sort((a, b) => Number(b.primary) - Number(a.primary))
		.slice(0, MAX_CALENDARS);

	const resolved = calendars.length ? calendars : PRIMARY_ONLY;
	// Bounded: an instance serving many profiles must not grow this without end.
	if (calendarCache.size >= CALENDAR_CACHE_MAX) {
		calendarCache.delete(calendarCache.keys().next().value);
	}
	calendarCache.set(profileId, { at: Date.now(), calendars: resolved });
	return resolved;
}

/**
 * The calendar list, or `primary` alone if listing failed for a reason other
 * than a dead link. Reading one calendar beats reading none; a broken link
 * still propagates so the caller can skip the provider instead of reporting
 * an empty schedule.
 */
async function calendarsOrPrimary(profileId) {
	try {
		return await listCalendars(profileId);
	} catch (err) {
		if (isNotConnected(err)) throw err;
		console.warn("[connectors] calendar list failed, using primary only:", err.message);
		return PRIMARY_ONLY;
	}
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Events the user has declined, or that were cancelled, are not "on". */
function isAttending(item) {
	if (item.status === "cancelled") return false;
	const self = Array.isArray(item.attendees)
		? item.attendees.find((a) => a && a.self)
		: null;
	return !self || self.responseStatus !== "declined";
}

const startMs = (event) => {
	const at = new Date(event.start).getTime();
	return Number.isNaN(at) ? Infinity : at;
};

/**
 * Upcoming events across every readable calendar.
 *
 * singleEvents=true expands recurring events into their individual
 * occurrences, which is what a person means by "what's on Thursday";
 * orderBy=startTime is only legal alongside it. Google orders within one
 * calendar, so the merged list is re-sorted here.
 *
 * One calendar failing is survivable — the others still answer. All of them
 * failing is not, and rethrows rather than passing an empty schedule off as
 * "nothing scheduled".
 */
async function collectEvents(profileId, { days = 7, maxResults = MAX_EVENTS } = {}) {
	const { timeMin, timeMax } = window(days);
	const calendars = await calendarsOrPrimary(profileId);
	const limit = Math.min(Number(maxResults) || MAX_EVENTS, MAX_EVENTS);

	const results = await Promise.all(
		calendars.map((calendar) =>
			providerGet(
				profileId,
				PROVIDER,
				`/calendars/${encodeURIComponent(calendar.id)}/events`,
				{
					query: {
						timeMin,
						timeMax,
						singleEvents: "true",
						orderBy: "startTime",
						maxResults: limit,
					},
				}
			)
				.then((data) => ({
					events: (data?.items || [])
						.filter(isAttending)
						.map((item) => normalizeEvent(item, calendar)),
				}))
				.catch((err) => {
					console.warn(
						`[connectors] calendar "${calendar.name}" failed:`, err.message
					);
					return { error: err };
				})
		)
	);

	const failure = results.find((r) => r.error);
	if (failure && results.every((r) => r.error)) throw failure.error;

	const events = results
		.flatMap((r) => r.events || [])
		.sort((a, b) => startMs(a) - startMs(b))
		.slice(0, limit);

	return { events, calendars };
}

/** Upcoming events across every readable calendar, oldest first. */
async function listEvents(profileId, options = {}) {
	const { events } = await collectEvents(profileId, options);
	return events;
}

/**
 * Busy intervals across every readable calendar — cheaper than listing events,
 * and the honest answer to "am I free" when a household shares a calendar.
 * Overlapping intervals from different calendars are merged into one.
 */
async function freeBusy(profileId, { days = 7 } = {}) {
	const { timeMin, timeMax } = window(days);
	const calendars = await calendarsOrPrimary(profileId);

	const data = await providerRequest(profileId, PROVIDER, "/freeBusy", {
		method: "POST",
		body: { timeMin, timeMax, items: calendars.map((c) => ({ id: c.id })) },
	});

	const intervals = Object.values(data?.calendars || {})
		.flatMap((c) => c?.busy || [])
		.map((b) => ({ start: b.start, end: b.end }))
		.filter((b) => b.start && b.end)
		.sort((a, b) => new Date(a.start) - new Date(b.start));

	return mergeIntervals(intervals);
}

/** Coalesce touching or overlapping busy blocks. Input must be start-sorted. */
function mergeIntervals(intervals) {
	const merged = [];
	for (const next of intervals) {
		const last = merged[merged.length - 1];
		if (last && new Date(next.start) <= new Date(last.end)) {
			if (new Date(next.end) > new Date(last.end)) last.end = next.end;
			continue;
		}
		merged.push({ ...next });
	}
	return merged;
}

function normalizeEvent(item, calendar = null) {
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
		calendar: calendar ? calendar.name : null,
		// Whose calendar it came from matters for a shared one ("that's on the
		// family calendar, not yours"), but saying it for the user's own is noise.
		shared: calendar ? !calendar.primary : false,
	};
}

/**
 * The zone to render times in: the account's own calendar setting, taken from
 * the primary calendar. Falls back to UTC only when the list was unreadable.
 */
function displayTimeZone(calendars) {
	const primary = calendars.find((c) => c.primary && c.timeZone);
	return primary?.timeZone || calendars.find((c) => c.timeZone)?.timeZone || "UTC";
}

/**
 * Render an instant in `timeZone` as "Mon 2026-09-14 09:00".
 *
 * A bad zone name makes Intl throw; the schedule is still worth showing, so
 * fall back to UTC rather than losing the block.
 */
function formatInZone(date, timeZone) {
	let parts;
	try {
		parts = new Intl.DateTimeFormat("en-GB", {
			timeZone,
			weekday: "short",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).formatToParts(date);
	} catch {
		return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`;
	}
	const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
	// hour12:false still renders midnight as "24" in some ICU versions.
	const hour = p.hour === "24" ? "00" : p.hour;
	return `${p.weekday} ${p.year}-${p.month}-${p.day} ${hour}:${p.minute}`;
}

/** Weekday for an all-day event, whose `start` is a bare YYYY-MM-DD. */
function formatAllDay(date) {
	const parsed = new Date(`${date}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime())) return date;
	const weekday = new Intl.DateTimeFormat("en-GB", {
		timeZone: "UTC",
		weekday: "short",
	}).format(parsed);
	return `${weekday} ${date}`;
}

function formatEvent(event, timeZone) {
	const where = event.location ? ` @ ${event.location}` : "";
	const whose = event.shared && event.calendar ? ` [${event.calendar}]` : "";
	if (event.allDay) {
		return `- ${formatAllDay(event.start)} (all day) — ${event.title}${where}${whose}`;
	}
	const when = formatInZone(new Date(event.start), timeZone);
	return `- ${when} — ${event.title}${where}${whose}`;
}

/** "your calendar and Family" — what was actually read, for the prompt header. */
function describeCalendars(calendars) {
	const shared = calendars.filter((c) => !c.primary).map((c) => c.name);
	if (!shared.length) return "your calendar";
	return `your calendar and ${shared.join(", ")}`;
}

/**
 * Plain-text grounding block for the system prompt, or null when there is
 * nothing useful to say. Never throws: a calendar failure must not sink a
 * conversation.
 */
async function buildContext(profileId, { days = 7 } = {}) {
	const { events, calendars } = await collectEvents(profileId, { days });
	const scope = describeCalendars(calendars);
	if (!events.length) {
		return `Google Calendar: nothing scheduled in the next ${days} days (checked ${scope}).`;
	}
	const timeZone = displayTimeZone(calendars);
	return [
		`Google Calendar — next ${days} days across ${scope} ` +
			`(local time, ${timeZone}):`,
		...events.map((event) => formatEvent(event, timeZone)),
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
			"or when something is. Covers every calendar on the account, including " +
			"calendars shared with a partner or family; each event names the calendar " +
			"it came from when that is not the user's own. Recurring events are " +
			"expanded into individual occurrences. Times are ISO 8601 carrying the " +
			"event's own UTC offset; `time_zone` is the user's calendar zone, and " +
			"times spoken back to the user must be converted into it.",
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
			"Get the user's BUSY time ranges without event details, across every " +
			'calendar on the account including shared ones. Use for "am I free", ' +
			'"when am I available", or finding a slot — it is cheaper and more ' +
			"private than listing events. Times are ISO 8601 (UTC); `time_zone` is " +
			"the user's calendar zone, and answers must be given in it.",
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
		const { events, calendars } = await collectEvents(profileId, {
			days: args.days,
		});
		return { events, time_zone: displayTimeZone(calendars) };
	}
	if (name === "get_calendar_free_busy") {
		const [busy, calendars] = await Promise.all([
			freeBusy(profileId, { days: args.days }),
			calendarsOrPrimary(profileId),
		]);
		return { busy, time_zone: displayTimeZone(calendars) };
	}
	throw new Error(`Unknown Google Calendar tool: ${name}`);
}

module.exports = {
	PROVIDER,
	matches,
	listCalendars,
	listEvents,
	freeBusy,
	buildContext,
	FUNCTION_DECLARATIONS,
	executeTool,
	// exported for tests
	normalizeEvent,
	mergeIntervals,
	displayTimeZone,
	formatEvent,
	window,
	clearCalendarCache: () => calendarCache.clear(),
};
