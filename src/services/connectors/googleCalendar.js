const { providerGet, providerRequest, isNotConnected } = require("./http");

/**
 * Google Calendar reads, and the two writes the action layer can propose.
 *
 * Reads are unconditional; writes are not. `createEvent` and `deleteEvent`
 * are never called from a context builder or a tool loop — only from
 * services/actions, after a person approved the specific proposal. That is
 * why they take an already-validated params object and do no interpretation
 * of their own: all the judgement happened upstream, under human eyes.
 *
 * Writing needs the `calendar.events` scope, which an account linked before
 * the action layer shipped does not have. Google answers those with 403
 * insufficientPermissions, which http.js reads as a dead grant — so both
 * writers translate it into a typed `needs_reauth` error instead, and the
 * person is asked to re-link rather than told their calendar broke.
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

const KEYWORDS =
	/\b(calendar|schedule|scheduled|appointment|appointments|meeting|meetings|event|events|busy|free|availability|available|agenda|booked|what('?s| is) on)\b/i;

/** Cheap gate: is this message plausibly about the user's calendar? */
function matches(message) {
	return typeof message === "string" && KEYWORDS.test(message);
}

const { startOfDayIn, addDaysIn } = require("../clock");

const iso = (date) => new Date(date).toISOString();

/**
 * Start of today through `days` later, as RFC3339 — the window Athena reads.
 *
 * "Today" means the calendar's own timezone, not the server's. The server runs
 * UTC in production, so without `timeZone` a 9pm-Eastern "what's on today?"
 * asked for a window starting the next UTC day: this morning's events vanished
 * and tomorrow's appeared. Omitting the zone keeps the old server-local
 * behaviour for callers that have no zone to offer.
 */
function window(days = 7, from = new Date(), timeZone = null) {
	const span = Math.max(1, Math.min(Number(days) || 7, 60));
	const start = startOfDayIn(new Date(from), timeZone);
	return { timeMin: iso(start), timeMax: iso(addDaysIn(start, span, timeZone)) };
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

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
	// The shared HTTP read cache resolves the live credential on every call,
	// including after reconnecting a different account.
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

	return calendars.length ? calendars : PRIMARY_ONLY;
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
	const calendars = await calendarsOrPrimary(profileId);
	const { timeMin, timeMax } = window(days, new Date(), displayTimeZone(calendars));
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
					// One calendar out of twenty answering 403 says something about
					// that calendar, not about the account's grant — and this call
					// fans out far enough to trip a per-user rate limit on its own.
					// Link health is judged by the account-level calendarList
					// read, which a real revocation fails first.
					invalidateOnAuthFailure: false,
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

/** Historical interval evidence for attention. Pagination and failures are
 * explicit; a partial calendar is never presented as an empty schedule. */
async function eventsInInterval(profileId, { start, end }) {
	const from = new Date(start), to = new Date(end);
	if (!Number.isFinite(+from) || !Number.isFinite(+to) || to <= from || to - from > 14 * 86400000) {
		throw new Error('Invalid calendar evidence interval');
	}
	const calendars = [];
	let pageToken;
	for (let page = 0; page < 10; page++) {
		const data = await providerGet(profileId, PROVIDER, '/users/me/calendarList', {
			query: { minAccessRole: 'reader', showHidden: 'false', maxResults: 250, pageToken },
		});
		if (!data || typeof data !== 'object' || (data.items !== undefined && !Array.isArray(data.items))) throw new Error('Invalid calendar list');
		calendars.push(...(data.items || []).filter(c => c.id && !c.deleted).map(c => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary, timeZone: c.timeZone || null })));
		pageToken = data.nextPageToken;
		if (!pageToken) break;
	}
	if (pageToken || calendars.length > 50) throw new Error('Calendar evidence exceeds this reader; nothing inferred');
	const events = [];
	for (const calendar of calendars) {
		pageToken = undefined;
		for (let page = 0; page < 10; page++) {
			const data = await providerGet(profileId, PROVIDER, `/calendars/${encodeURIComponent(calendar.id)}/events`, {
				query: { timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: 250, pageToken },
				invalidateOnAuthFailure: false,
			});
			if (!data || typeof data !== 'object' || (data.items !== undefined && !Array.isArray(data.items))) throw new Error('Invalid calendar evidence');
			events.push(...(data.items || []).filter(isAttending).map(item => ({ ...normalizeEvent(item, calendar), calendar_id: calendar.id, updated_at: item.updated || null, description: String(item.description || '').slice(0, 2000) })));
			pageToken = data.nextPageToken;
			if (!pageToken) break;
		}
		if (pageToken || events.length > 500) throw new Error('Calendar evidence exceeds this reader; nothing inferred');
	}
	return { events, calendars, complete: true };
}

/**
 * Busy intervals across every readable calendar — cheaper than listing events,
 * and the honest answer to "am I free" when a household shares a calendar.
 * Overlapping intervals from different calendars are merged into one.
 */
async function freeBusy(profileId, { days = 7 } = {}) {
	const calendars = await calendarsOrPrimary(profileId);
	const { timeMin, timeMax } = window(days, new Date(), displayTimeZone(calendars));

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
		// The provider's own event id. Carried so a caller can point at one
		// specific occurrence later: the initiative triggers dedupe on it, and
		// without it "your 2pm is soon" would be re-announced on every run.
		id: item.id || null,
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
		const zone = displayTimeZone(calendars);
		return (
			`Google Calendar: nothing scheduled in the next ${days} days ` +
			`(checked ${scope}, from ${formatInZone(new Date(), zone)} local time).`
		);
	}
	const timeZone = displayTimeZone(calendars);
	return [
		`Google Calendar — next ${days} days across ${scope} ` +
			`(local time, ${timeZone}). Right now it is ` +
			`${formatInZone(new Date(), timeZone)}, so the first entry below is the ` +
			`next one still to come:`,
		...events.map((event) => formatEvent(event, timeZone)),
	].join("\n");
}

// ---------------------------------------------------------------------------
// Writes (action layer only)
// ---------------------------------------------------------------------------

/**
 * A 403 that means "this grant predates the write scope", told apart from a
 * 403 that means the grant is gone.
 *
 * Google reports a missing scope as insufficientPermissions / ACCESS_TOKEN_SCOPE_
 * INSUFFICIENT. http.js has already decided an unexplained 403 is revocation
 * and invalidated the link by the time we see it; re-typing it here is what
 * turns "reconnect, your calendar is broken" into the true "re-link to let me
 * add events", which is a different sentence and a different consent.
 */
function asWriteAuthError(err) {
	const text = `${err && err.message ? err.message : ""}`.toLowerCase();
	if (
		err &&
		(err.status === 403 || err.code === "not_connected") &&
		/insufficient|scope|permission/.test(text)
	) {
		return Object.assign(
			new Error(
				"Athena can read this calendar but not write to it yet — re-link Google Calendar to allow adding events"
			),
			{ status: 409, code: "needs_reauth", provider: PROVIDER }
		);
	}
	return err;
}

/**
 * Create one event on the calendar the person nominated (default: primary).
 *
 * `sendUpdates: "none"` is deliberate and load-bearing. An event with
 * attendees mails every one of them the moment it is inserted, which would
 * make one approved proposal into outbound messages to other people that
 * nobody approved. The action registry refuses attendees for the same reason;
 * this is the second lock on the same door.
 */
async function createEvent(profileId, params = {}) {
	const body = {
		summary: params.title,
		...(params.description ? { description: params.description } : {}),
		...(params.location ? { location: params.location } : {}),
		...(params.all_day
			? {
					start: { date: params.start },
					end: { date: params.end || params.start },
				}
			: {
					start: { dateTime: params.start, ...(params.time_zone ? { timeZone: params.time_zone } : {}) },
					end: { dateTime: params.end, ...(params.time_zone ? { timeZone: params.time_zone } : {}) },
				}),
	};
	let created;
	try {
		created = await providerRequest(
			profileId,
			PROVIDER,
			`/calendars/${encodeURIComponent(params.calendar_id || "primary")}/events`,
			{ method: "POST", body, query: { sendUpdates: "none" } }
		);
	} catch (err) {
		throw asWriteAuthError(err);
	}
	return {
		ref: created?.id || null,
		event: created ? normalizeEvent(created) : null,
		html_link: created?.htmlLink || null,
	};
}

/**
 * Delete an event Athena created. Scoped by the caller's own profile id, so a
 * params-supplied event id can only ever address that person's calendars.
 */
async function deleteEvent(profileId, params = {}) {
	try {
		await providerRequest(
			profileId,
			PROVIDER,
			`/calendars/${encodeURIComponent(params.calendar_id || "primary")}/events/${encodeURIComponent(params.event_id)}`,
			{ method: "DELETE", query: { sendUpdates: "none" } }
		);
	} catch (err) {
		throw asWriteAuthError(err);
	}
	return { ref: params.event_id };
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
		const zone = displayTimeZone(calendars);
		// `now` so the model can tell "still to come" from "already happened"
		// without guessing today's date.
		return { events, time_zone: zone, now: formatInZone(new Date(), zone) };
	}
	if (name === "get_calendar_free_busy") {
		const [busy, calendars] = await Promise.all([
			freeBusy(profileId, { days: args.days }),
			calendarsOrPrimary(profileId),
		]);
		const zone = displayTimeZone(calendars);
		return { busy, time_zone: zone, now: formatInZone(new Date(), zone) };
	}
	throw new Error(`Unknown Google Calendar tool: ${name}`);
}

module.exports = {
	eventsInInterval,
	PROVIDER,
	matches,
	listCalendars,
	listEvents,
	freeBusy,
	buildContext,
	createEvent,
	deleteEvent,
	// Events plus the calendar list they came from, in one call. Exported for
	// the initiative triggers, which need the account's own timezone to say
	// "2pm" and would otherwise re-fetch the calendar list to get it.
	collectEvents,
	FUNCTION_DECLARATIONS,
	executeTool,
	// exported for tests
	normalizeEvent,
	mergeIntervals,
	displayTimeZone,
	formatEvent,
	window,
};
