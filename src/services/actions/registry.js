/**
 * Action registry — everything action-specific about something Athena can DO.
 *
 * `index.js` is deliberately generic: it proposes, gates, executes and audits
 * without knowing what any action means. Every action-specific fact lives
 * here, so adding an action is a descriptor and a test, not a new code path.
 * Same discipline as `connectors/registry.js`, for the same reason.
 *
 * The descriptor is also the security boundary. Athena's reply is model output
 * and therefore untrusted: `normalize()` is the only thing standing between a
 * hallucinated parameter and a real provider call. It must reject rather than
 * repair anything it cannot vouch for, and it must never widen what the
 * person can be asked to approve. A field absent from `normalize()`'s output
 * cannot reach `execute()`, whatever the model put in the proposal.
 *
 * Descriptor fields:
 *   id            stable identifier; stored in athena_action.action_id
 *   label         short human name, for cards and the standing-approval list
 *   provider       connector PROVIDER this needs linked, or null if internal
 *   consentType    family consent required before proposing, or null
 *   reversible     can the person undo it themselves afterwards?
 *   standing       may a standing approval ever skip the per-action prompt?
 *   describe       one line the model reads, saying when to propose this
 *   params         model-facing parameter doc (name -> description)
 *   normalize(raw, ctx) -> clean params | throws
 *   summarize(params) -> the plain-language sentence the person approves
 *   execute(profileId, params, ctx) -> { ref, detail }
 */

const googleCalendar = require("../connectors/googleCalendar");
const memory = require("../memory");

/** A rejection that is the model's fault, not the person's or the server's. */
function invalid(message) {
	return Object.assign(new Error(message), { status: 400, code: "invalid_action_params" });
}

/** Trimmed string within a length cap, or null. Never throws on a non-string. */
function str(value, max) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.slice(0, max);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An instant Athena proposed, as an ISO string we are willing to send on.
 *
 * Deliberately strict about the offset. A bare "2026-09-18T14:00:00" is the
 * single most likely thing a model emits and the single most dangerous: it
 * means 2pm in whatever zone the reader assumes, and the reader here is
 * Google. Rather than guess a zone and book the wrong hour, an offsetless
 * datetime is refused unless the caller supplies the calendar's own zone
 * alongside it, which is what `time_zone` is for.
 */
function instant(value, { timeZone }) {
	const raw = str(value, 40);
	if (!raw) return null;
	const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
	if (!hasOffset && !timeZone) return null;
	const parsed = new Date(hasOffset ? raw : `${raw}Z`);
	if (Number.isNaN(parsed.getTime())) return null;
	// Kept as authored when it carries its own offset; Google resolves a
	// zone-qualified local time correctly and that is more faithful to what
	// the person approved than our own conversion would be.
	return raw;
}

/** IANA-shaped zone name. Not a whitelist — a shape check against injection. */
function zone(value) {
	const raw = str(value, 64);
	if (!raw) return null;
	return /^[A-Za-z][A-Za-z0-9+_-]*(?:\/[A-Za-z0-9+_.-]+){0,2}$/.test(raw) ? raw : null;
}

/** "Thu 18 Sep, 2:00 pm" — for the approval card, in the event's own zone. */
function humanTime(iso, timeZone) {
	try {
		return new Intl.DateTimeFormat("en-GB", {
			weekday: "short",
			day: "numeric",
			month: "short",
			hour: "numeric",
			minute: "2-digit",
			hour12: true,
			...(timeZone ? { timeZone } : {}),
		}).format(new Date(iso));
	} catch {
		return iso;
	}
}

const MAX_EVENT_DAYS = 365;
const MAX_EVENT_HOURS = 24 * 14;

const ACTIONS = [
	{
		id: "create_calendar_event",
		label: "Add a calendar event",
		provider: "google_calendar",
		consentType: "action_authority",
		// Google keeps a deleted event recoverable from Trash, and the person
		// can edit or remove it in their own calendar without Athena.
		reversible: true,
		standing: true,
		describe:
			"Add a single event to the person's own Google Calendar. Propose this " +
			"when they ask you to put something on the calendar, book, schedule or " +
			"block out time. Do not propose it to answer a question about what is " +
			"already scheduled — reading needs no approval.",
		params: {
			title: "What the event is called. Required.",
			start:
				"When it starts: ISO 8601. Include the UTC offset (2026-09-18T14:00:00-04:00) " +
				"or else give time_zone. Required.",
			end: "When it ends, same format. Required unless all_day.",
			all_day: "true for a whole-day event; then start/end are plain YYYY-MM-DD dates.",
			time_zone: "IANA zone (America/New_York) for start/end that carry no offset.",
			location: "Where it is. Optional.",
			description: "Any detail worth keeping on the event. Optional.",
		},

		normalize(raw = {}) {
			const title = str(raw.title, 200);
			if (!title) throw invalid("An event needs a title");

			// Attendees are refused, not dropped quietly: inviting other people
			// mails them, which turns one approved proposal into messages to
			// third parties who approved nothing. The person can add guests
			// themselves once the event exists.
			if (raw.attendees || raw.guests) {
				throw invalid("Athena cannot invite other people to an event");
			}
			// The calendar is always the person's primary one. Accepting a
			// model-chosen calendar id would let a hallucination write into a
			// shared household calendar that other people read.
			if (raw.calendar_id) throw invalid("Athena can only add to the primary calendar");

			const allDay = raw.all_day === true;
			if (allDay) {
				const start = str(raw.start, 10);
				const end = str(raw.end, 10) || start;
				if (!DATE_ONLY.test(start || "") || !DATE_ONLY.test(end)) {
					throw invalid("An all-day event needs YYYY-MM-DD dates");
				}
				if (end < start) throw invalid("An event cannot end before it starts");
				return {
					title,
					all_day: true,
					start,
					// Google treats an all-day `end` as exclusive, so a one-day
					// event ends the following date. Computed here rather than in
					// the writer so what the executor sends is exactly what this
					// function vouched for.
					end: new Date(new Date(`${end}T00:00:00Z`).getTime() + 86400000)
						.toISOString()
						.slice(0, 10),
					...(str(raw.location, 200) ? { location: str(raw.location, 200) } : {}),
					...(str(raw.description, 1000)
						? { description: str(raw.description, 1000) }
						: {}),
				};
			}

			const timeZone = zone(raw.time_zone);
			const start = instant(raw.start, { timeZone });
			const end = instant(raw.end, { timeZone });
			if (!start) {
				throw invalid(
					"An event needs a start time with a UTC offset, or a time_zone to read it in"
				);
			}
			if (!end) throw invalid("An event needs an end time");

			const startMs = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(start) ? start : `${start}Z`);
			const endMs = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(end) ? end : `${end}Z`);
			if (endMs <= startMs) throw invalid("An event cannot end before it starts");
			if ((endMs - startMs) / 3600000 > MAX_EVENT_HOURS) {
				throw invalid("That event is longer than Athena will schedule unattended");
			}
			// A date the model got wrong by a year is the classic structured-output
			// failure, and a silent 2027 booking is worse than a refusal.
			const daysOut = (startMs - Date.now()) / 86400000;
			if (daysOut > MAX_EVENT_DAYS) throw invalid("That start date is too far in the future");
			if (daysOut < -1) throw invalid("Athena will not add an event in the past");

			return {
				title,
				start,
				end,
				...(timeZone ? { time_zone: timeZone } : {}),
				...(str(raw.location, 200) ? { location: str(raw.location, 200) } : {}),
				...(str(raw.description, 1000) ? { description: str(raw.description, 1000) } : {}),
			};
		},

		summarize(p) {
			const when = p.all_day
				? `all day on ${p.start}`
				: `${humanTime(p.start, p.time_zone)} – ${humanTime(p.end, p.time_zone)}`;
			const where = p.location ? ` at ${p.location}` : "";
			return `Add "${p.title}" to your calendar: ${when}${where}`;
		},

		async execute(profileId, params) {
			const { ref, html_link } = await googleCalendar.createEvent(profileId, params);
			return { ref, detail: { html_link } };
		},
	},

	{
		id: "remember_fact",
		label: "Save something to memory",
		// Internal: nothing to link, nothing to leave the building. Present
		// mainly to keep the registry honest — an action layer with one
		// OAuth action in it quietly becomes a calendar feature.
		provider: null,
		consentType: null,
		reversible: true,
		standing: true,
		describe:
			"Save one durable fact about the person to your long-term memory. Propose " +
			"this only when they ask you to remember something specific. Ordinary " +
			"things you notice in conversation are already remembered without asking.",
		params: {
			category: `One of: ${[...memory.CATEGORIES].join(", ")}. Required.`,
			key: "Short label for the fact, e.g. \"coffee order\". Required.",
			value: "The fact itself, in one sentence. Required.",
		},

		normalize(raw = {}) {
			const category = str(raw.category, 32)?.toLowerCase();
			if (!category || !memory.CATEGORIES.has(category)) {
				throw invalid(`Category must be one of: ${[...memory.CATEGORIES].join(", ")}`);
			}
			const key = str(raw.key, 120);
			const value = str(raw.value, 2000);
			if (!key) throw invalid("A memory needs a key");
			if (!value) throw invalid("A memory needs a value");
			return { category, key, value };
		},

		summarize(p) {
			return `Remember that ${p.key}: ${p.value}`;
		},

		async execute(profileId, params, ctx = {}) {
			const saved = await memory.upsertMemoryForProfile(profileId, ctx.familyId || null, {
				category: params.category,
				key: params.key,
				value: params.value,
				// "ai" because Athena authored the wording, even though a human
				// approved it. memory.js silently coerces an unknown source to
				// "user", which would credit the person with typing a sentence
				// they only nodded at — so this must stay one of the three
				// values in SOURCES.
				source: "ai",
				visibility: "private",
			});
			return { ref: saved?.uuid || null, detail: null };
		},
	},
];

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

/** The descriptor, or null. Callers must treat null as "refuse", not "allow". */
function get(id) {
	return (typeof id === "string" && BY_ID.get(id)) || null;
}

module.exports = { ACTIONS, get, invalid };
