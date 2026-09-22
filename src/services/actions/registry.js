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
const gmail = require("../connectors/gmail");
const emailTriage = require("../emailTriage");
const memory = require("../memory");
const lookRequests = require("../lookRequests");

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
		id: "look_through_camera",
		label: "Take a look through your camera",
		// Internal: the "provider" is a browser on the person's desk, which the
		// server cannot reach. Executing writes an athena_look_request and a
		// client fulfils it (services/lookRequests.js).
		provider: null,
		// Opening a camera is squarely "Athena does something you did not ask
		// for in this moment", which is what this consent covers.
		consentType: "action_authority",
		// A look cannot be taken back, and a notable one becomes a memory. The
		// card says so rather than implying it can be undone.
		reversible: false,
		// The point of the whole action. Granted once, she may look when it
		// helps instead of asking every time; revoking it stops her dead.
		standing: true,
		describe:
			"Take a look through the camera on the person's device when seeing would " +
			"genuinely answer what is being discussed — they are showing you something, " +
			"asking what you think of something in front of them, or asking what you can " +
			"see. Always say why. Do NOT propose this to check on someone, to see what " +
			"they are doing, out of curiosity, or when they have not brought anything " +
			"visual into the conversation. If you can already see something current, use " +
			"that instead of asking for another look.",
		params: {
			reason: "Why looking would help, in one short sentence, addressed to them. Required.",
			prefer: "Optional. \"front\" to look at what they are pointing at, \"room\" to look at where they are.",
		},

		normalize(raw = {}) {
			// A camera that opens without a stated reason is not something to
			// ship, so the reason is the one required parameter.
			const reason = str(raw.reason, 300);
			if (!reason) throw invalid("A look needs a reason the person can read");
			const prefer = str(raw.prefer, 20)?.toLowerCase() ?? null;
			if (prefer && prefer !== "front" && prefer !== "room") {
				throw invalid('Prefer must be "front" or "room"');
			}
			return prefer ? { reason, prefer } : { reason };
		},

		summarize(p) {
			return `Take a look through your camera: ${p.reason}`;
		},

		async execute(profileId, params, ctx = {}) {
			const request = await lookRequests.create(profileId, {
				reason: params.reason,
				prefer: params.prefer || null,
				actionUuid: ctx.actionUuid || null,
			});
			// Null means she already has looks outstanding that nobody answered.
			// Failing is right: several cameras opening at once the moment a
			// device appears is exactly what the cap exists to prevent.
			if (!request) {
				throw invalid("She already has a look waiting to be answered");
			}
			return {
				ref: request.uuid,
				detail: "Asked your device to take a look",
			};
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

	// -------------------------------------------------------------------
	// Email triage (services/emailTriage.js). Proposed either from the
	// email-triage panel directly (routes/email.js calling actions.propose
	// with sessionId null) or, in principle, from chat — normalize() does
	// not care which. Never called from a scan: scanNext() only reads and
	// classifies, these are the only things that touch Gmail or write to
	// email_receipt.
	// -------------------------------------------------------------------

	{
		id: "file_receipt_email",
		label: "File a receipt",
		provider: "gmail",
		consentType: "action_authority",
		// The person can remove the label / move it back to the inbox from
		// Gmail itself; the email_receipt row stays as a record either way,
		// same "undoable in the underlying app, not through Athena" sense
		// create_calendar_event uses above.
		reversible: true,
		standing: false,
		describe:
			"File one or more triaged receipt emails into a Gmail label (default " +
			'"Receipts") and log them to the spending ledger. Only for emails the ' +
			"email-triage feature has already classified as receipt.",
		params: {
			items:
				"Array of { email_triage_uuid, label, merchant, category, amount, " +
				"currency, purchased_at }. One entry per email — several when the " +
				"person is filing a group of similar receipts at once. Required, " +
				"1-25 entries.",
		},

		normalize(raw = {}) {
			const items = Array.isArray(raw.items) ? raw.items : [];
			if (!items.length) throw invalid("Needs at least one receipt email");
			if (items.length > 25) throw invalid("Too many receipts in one proposal");
			return {
				items: items.map((item) => {
					const email_triage_uuid = str(item.email_triage_uuid, 36);
					if (!email_triage_uuid) throw invalid("Each receipt needs its email_triage_uuid");
					const amount =
						typeof item.amount === "number" && Number.isFinite(item.amount)
							? Math.round(item.amount * 100) / 100
							: null;
					const purchasedAtRaw = str(item.purchased_at, 10);
					return {
						email_triage_uuid,
						label: str(item.label, 100) || "Receipts",
						merchant: str(item.merchant, 200),
						category: str(item.category, 60),
						amount,
						currency: str(item.currency, 8)?.toUpperCase() || "USD",
						purchased_at: purchasedAtRaw && DATE_ONLY.test(purchasedAtRaw) ? purchasedAtRaw : null,
					};
				}),
			};
		},

		summarize(p) {
			const [first] = p.items;
			if (p.items.length === 1) {
				const amount = first.amount != null ? ` (${first.currency} ${first.amount.toFixed(2)})` : "";
				return `File this receipt${first.merchant ? ` from ${first.merchant}` : ""}${amount} into "${first.label}" and log it to your spending`;
			}
			return `File ${p.items.length} receipts into "${first.label}" and log them to your spending`;
		},

		async execute(profileId, params) {
			const rows = await emailTriage.getRowsByUuids(
				profileId,
				params.items.map((i) => i.email_triage_uuid)
			);
			const byUuid = new Map(rows.map((r) => [r.uuid, r]));
			const filed = [];
			for (const item of params.items) {
				const row = byUuid.get(item.email_triage_uuid);
				// Not this person's email (or it's gone since the proposal was
				// made) — skip it rather than failing the whole batch.
				if (!row) continue;
				await gmail.fileMessage(profileId, row.gmail_message_id, item.label);
				await emailTriage.insertReceipt(profileId, row.id, item);
				filed.push(item.email_triage_uuid);
			}
			if (!filed.length) throw new Error("None of these emails could be found");
			await emailTriage.markStatus(profileId, filed, "actioned");
			return { ref: filed.join(","), detail: { filed: filed.length } };
		},
	},

	{
		id: "file_travel_or_school_email",
		label: "Add to calendar and file the email",
		// Needs gmail linked too, but the registry only gates one provider per
		// action and a triage row only ever exists when gmail was already
		// linked (that's how it was found). Filing failure degrades to
		// `detail.filed: false` in execute() below rather than blocking the
		// calendar event, which is the part the person actually asked for.
		provider: "google_calendar",
		consentType: "action_authority",
		reversible: true,
		standing: false,
		describe:
			"For a triaged travel or school-announcement email with a real date " +
			"on it (a flight, a deadline, an event), propose adding it to the " +
			"calendar AND filing the email out of the inbox into a matching " +
			"label, as one confirmation. Only for a triaged email whose category " +
			"is travel or school.",
		params: {
			email_triage_uuid: "The triaged email's uuid. Required.",
			label: 'Destination Gmail label, e.g. "Travel" or "School". Required.',
			title: "Event title. Required.",
			start:
				"When it starts: ISO 8601 with a UTC offset, or YYYY-MM-DD if all_day. Required.",
			end: "When it ends, same format. Required unless all_day.",
			all_day: "true for a whole-day event.",
			time_zone: "IANA zone (America/New_York) for start/end that carry no offset.",
			location: "Where it is. Optional.",
		},

		normalize(raw = {}) {
			const email_triage_uuid = str(raw.email_triage_uuid, 36);
			if (!email_triage_uuid) throw invalid("Needs the triaged email's uuid");
			const label = str(raw.label, 100);
			if (!label) throw invalid("Needs a destination label");
			const title = str(raw.title, 200);
			if (!title) throw invalid("An event needs a title");

			const allDay = raw.all_day === true;
			let event;
			if (allDay) {
				const start = str(raw.start, 10);
				const end = str(raw.end, 10) || start;
				if (!DATE_ONLY.test(start || "") || !DATE_ONLY.test(end)) {
					throw invalid("An all-day event needs YYYY-MM-DD dates");
				}
				if (end < start) throw invalid("An event cannot end before it starts");
				event = {
					title,
					all_day: true,
					start,
					end: new Date(new Date(`${end}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10),
				};
			} else {
				const timeZone = zone(raw.time_zone);
				const start = instant(raw.start, { timeZone });
				const end = instant(raw.end, { timeZone });
				if (!start) throw invalid("An event needs a start time with a UTC offset, or a time_zone");
				if (!end) throw invalid("An event needs an end time");
				const startMs = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(start) ? start : `${start}Z`);
				const endMs = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(end) ? end : `${end}Z`);
				if (endMs <= startMs) throw invalid("An event cannot end before it starts");
				event = { title, start, end, ...(timeZone ? { time_zone: timeZone } : {}) };
			}
			if (str(raw.location, 200)) event.location = str(raw.location, 200);

			return { email_triage_uuid, label, event };
		},

		summarize(p) {
			const when = p.event.all_day
				? `all day on ${p.event.start}`
				: humanTime(p.event.start, p.event.time_zone);
			return `Add "${p.event.title}" to your calendar (${when}) and file this email into "${p.label}"`;
		},

		async execute(profileId, params) {
			const rows = await emailTriage.getRowsByUuids(profileId, [params.email_triage_uuid]);
			const row = rows[0];
			if (!row) throw new Error("That email could not be found");
			const { ref, html_link } = await googleCalendar.createEvent(profileId, params.event);
			let filed = false;
			try {
				await gmail.fileMessage(profileId, row.gmail_message_id, params.label);
				filed = true;
			} catch (err) {
				// The event is what the person actually asked for; a filing
				// failure (e.g. gmail needs re-auth) shouldn't undo it or fail
				// the whole action — it just leaves the email where it was.
				console.warn(
					"[actions] file_travel_or_school_email: event created but filing failed:",
					err.message
				);
			}
			await emailTriage.markStatus(profileId, [row.uuid], "actioned");
			return { ref, detail: { html_link, filed } };
		},
	},

	{
		id: "dismiss_email",
		label: "Dismiss from the mail list",
		// Internal: nothing to link. Dismissing never touches Gmail — it only
		// hides the row from the "new" list — but it still goes through the
		// same propose/confirm/audit path as everything else in this feature
		// for one consistent trail of what Athena did with the inbox.
		provider: null,
		consentType: "action_authority",
		reversible: false,
		standing: false,
		describe:
			"Hide a triaged email from the mail list without touching it in " +
			"Gmail at all — for something with no real action to take, or the " +
			"person doesn't want Athena to do anything with it.",
		params: { email_triage_uuid: "The triaged email's uuid. Required." },

		normalize(raw = {}) {
			const email_triage_uuid = str(raw.email_triage_uuid, 36);
			if (!email_triage_uuid) throw invalid("Needs the triaged email's uuid");
			return { email_triage_uuid };
		},

		summarize() {
			return "Dismiss this email from your mail list (nothing changes in Gmail)";
		},

		async execute(profileId, params) {
			const changed = await emailTriage.markStatus(profileId, [params.email_triage_uuid], "dismissed");
			if (!changed) throw new Error("That email could not be found");
			return { ref: params.email_triage_uuid, detail: null };
		},
	},
];

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

/** The descriptor, or null. Callers must treat null as "refuse", not "allow". */
function get(id) {
	return (typeof id === "string" && BY_ID.get(id)) || null;
}

module.exports = { ACTIONS, get, invalid };
