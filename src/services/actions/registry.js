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
const unsubscribe = require("../unsubscribe");
const emailDraft = require("../emailDraft");
const placeReminders = require("../placeReminders");

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

	// Place reminders (services/placeReminders.js), added on the owner's
	// instruction 2026-10-04: "next time I'm at Missy's, remind me to ...".
	// The card is the address check — it names the exact point that will be
	// watched, resolved here rather than taken from the model.
	{
		id: "remind_at_place",
		label: "Set a reminder for a place",
		provider: null,
		consentType: "action_authority",
		// Removable from the Community page at any time, and it only ever
		// sends the person a notification.
		reversible: true,
		standing: true,
		describe:
			"Set a reminder that fires when the person next arrives at a place — " +
			'"next time I\'m at Missy\'s, remind me to ...", "whenever I\'m at church, ' +
			'remind me ...". Before proposing, say back which place you mean and its ' +
			"address from their points of interest, so they can correct you. Not for " +
			"time-based reminders.",
		params: {
			place: "The point of interest's name exactly as listed in their community, e.g. \"Missy's\". Required unless address is given.",
			address: "A US street address with town, only when the place is not one of their points of interest.",
			place_name: "What to call an address-only place, e.g. \"Missy's\". Optional.",
			reminder: "What to remind them, in a short sentence addressed to them, e.g. \"Bring back her casserole dish\". Required.",
			repeats: '"next_visit" (default, fires once) or "every_visit" when they said whenever/every time.',
		},

		async normalize(raw = {}, ctx = {}) {
			if (!ctx.profileId) throw invalid("A place reminder needs a person");
			const reminder = str(raw.reminder, 300);
			if (!reminder) throw invalid("A place reminder needs something to remind them");
			const repeats = raw.repeats === undefined || raw.repeats === null || raw.repeats === "" ? "next_visit" : raw.repeats;
			if (repeats !== "next_visit" && repeats !== "every_visit") {
				throw invalid('Repeats must be "next_visit" or "every_visit"');
			}
			const place = await placeReminders.resolvePlace(ctx.profileId, raw);
			return { ...place, reminder, repeats };
		},

		summarize(p) {
			const when = p.repeats === "every_visit" ? "Every time" : "Next time";
			const where = p.address ? `${p.place_name} (${p.address})` : p.place_name;
			return `${when} you get to ${where}, remind you: "${p.reminder}"`.slice(0, 500);
		},

		async execute(profileId, params, ctx = {}) {
			const { uuid, locationSharing } = await placeReminders.create(profileId, params, {
				actionUuid: ctx.actionUuid || null,
			});
			return {
				ref: uuid,
				detail: locationSharing ? null : "Set, but location sharing is off, so it can't fire yet",
			};
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

	{
		id: "delete_email",
		label: "Move to Trash",
		provider: "gmail",
		consentType: "action_authority",
		// Gmail keeps a trashed message recoverable there for about 30 days
		// before purging it — reversible in the same sense create_calendar_event
		// is above. This is deliberately NOT users.messages.delete: a true
		// permanent, unrecoverable delete is never wired up.
		reversible: true,
		standing: false,
		describe:
			"Move one or more triaged emails to Gmail's Trash — for junk, " +
			"duplicates, or anything not worth keeping. Recoverable from Trash " +
			"for about 30 days. Always confirm first, whatever the category.",
		params: {
			email_triage_uuids: "Array of 1-25 email_triage uuids to trash. Required.",
		},

		normalize(raw = {}) {
			const uuids = Array.isArray(raw.email_triage_uuids) ? raw.email_triage_uuids : [];
			if (!uuids.length) throw invalid("Needs at least one email");
			if (uuids.length > 25) throw invalid("Too many emails in one proposal");
			const clean = uuids.map((u) => {
				const email_triage_uuid = str(u, 36);
				if (!email_triage_uuid) throw invalid("Each entry needs an email_triage_uuid");
				return email_triage_uuid;
			});
			return { email_triage_uuids: clean };
		},

		summarize(p) {
			return p.email_triage_uuids.length === 1
				? "Move this email to Trash (recoverable there for 30 days)"
				: `Move ${p.email_triage_uuids.length} emails to Trash (recoverable there for 30 days)`;
		},

		async execute(profileId, params) {
			const rows = await emailTriage.getRowsByUuids(profileId, params.email_triage_uuids);
			const trashed = [];
			for (const row of rows) {
				await gmail.trashMessage(profileId, row.gmail_message_id);
				trashed.push(row.uuid);
			}
			if (!trashed.length) throw new Error("None of these emails could be found");
			await emailTriage.markStatus(profileId, trashed, "trashed");
			return { ref: trashed.join(","), detail: { trashed: trashed.length } };
		},
	},

	// Mail card phase 5, added on the owner's instruction 2026-09-30. Saves a
	// reply to Gmail's Drafts — never sends; the person sends it from Gmail.
	{
		id: "draft_reply",
		label: "Save a reply draft",
		provider: "gmail",
		consentType: "action_authority",
		// A draft can be edited or deleted in Gmail and nothing has left yet.
		reversible: true,
		standing: false,
		describe:
			"Save a reply to a triaged email as a Gmail draft in the same thread, " +
			"for the person to review and send themselves. Never sends.",
		params: {
			email_triage_uuid: "The email being answered. Required.",
			body: `The reply text, up to ${emailDraft.MAX_BODY} characters. Required.`,
			to_name: "Who it goes to, for display. Optional.",
		},

		normalize(raw = {}) {
			const email_triage_uuid = str(raw.email_triage_uuid, 36);
			if (!email_triage_uuid) throw invalid("Needs the email being answered");
			const body = str(raw.body, emailDraft.MAX_BODY);
			if (!body) throw invalid("A draft needs some text");
			return { email_triage_uuid, body, to_name: str(raw.to_name, 100) };
		},

		summarize(p) {
			const preview = p.body.length > 220 ? `${p.body.slice(0, 220)}…` : p.body;
			return `Save a draft reply${p.to_name ? ` to ${p.to_name}` : ""} in Gmail — not sent: "${preview}"`.slice(0, 500);
		},

		async execute(profileId, params) {
			const [row] = await emailTriage.getRowsByUuids(profileId, [params.email_triage_uuid]);
			if (!row) throw new Error("That email could not be found");
			const original = await gmail.getMessage(profileId, row.gmail_message_id, { format: "metadata" });
			const header = (name) => gmail.headerValue(original, name);
			const raw = emailDraft.replyMime({
				to: header("reply-to") || header("from"),
				subject: header("subject") || row.subject || "",
				messageId: header("message-id"),
				references: header("references"),
				body: params.body,
			});
			const draft = await gmail.createDraft(profileId, { raw, threadId: original.threadId || row.thread_id });
			// Drafted means it has left the "needs you" list; the reply itself
			// is the person's to send.
			await emailTriage.markStatus(profileId, [row.uuid], "actioned");
			return { ref: draft?.id || null, detail: { drafted: true } };
		},
	},

	// Mail card phase 4, added on the owner's instruction 2026-09-30. The one
	// action here that cannot be undone, so it never gets a standing approval.
	// Params name stored triage rows only: the link that gets called is read
	// from Athena's own copy of the email at execute time (services/unsubscribe.js
	// says why that, and only that, makes calling it acceptable).
	{
		id: "unsubscribe_senders",
		label: "Unsubscribe from senders",
		provider: "gmail",
		consentType: "action_authority",
		reversible: false,
		standing: false,
		describe:
			"Unsubscribe from mailing lists using the sender's own one-click " +
			"unsubscribe link, then archive what they already sent. Only senders " +
			"whose emails offer one-click unsubscribe; cannot be undone from here.",
		params: {
			items: "Array of 1-10 { email_triage_uuid, sender } — one recent email per sender; `sender` is display text. Required.",
		},

		normalize(raw = {}) {
			const items = Array.isArray(raw.items) ? raw.items : [];
			if (!items.length) throw invalid("Needs at least one sender");
			if (items.length > 10) throw invalid("Too many senders in one proposal");
			const seen = new Set();
			return {
				items: items.map((item) => {
					const email_triage_uuid = str(item?.email_triage_uuid, 36);
					if (!email_triage_uuid) throw invalid("Each sender needs an email_triage_uuid");
					return { email_triage_uuid, sender: str(item.sender, 100) || "this sender" };
				}).filter((i) => !seen.has(i.email_triage_uuid) && seen.add(i.email_triage_uuid)),
			};
		},

		summarize(p) {
			const names = p.items.map((i) => i.sender);
			const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? ` and ${names.length - 5} more` : "");
			return `Unsubscribe from ${shown} and archive what they already sent — unsubscribing can't be undone from here`.slice(0, 500);
		},

		async execute(profileId, params) {
			const rows = await emailTriage.getRowsByUuids(profileId, params.items.map((i) => i.email_triage_uuid));
			const done = [];
			const failed = [];
			let archived = 0;
			for (const row of rows) {
				const link = emailTriage.safeJson(row.extracted || "null")?.unsub;
				if (!link) { failed.push(row.uuid); continue; }
				let result;
				try { result = await unsubscribe.send(link); }
				catch (err) { result = { ok: false, error: err.message }; }
				if (!result.ok) {
					console.warn("[actions] unsubscribe_senders: not accepted:", row.group_key, result.status ?? result.error);
					failed.push(row.uuid);
					continue;
				}
				done.push(row.uuid);
				const open = await emailTriage.openFromSender(profileId, row.group_key);
				if (open.length) {
					try {
						await gmail.archiveMessages(profileId, open.map((r) => r.gmail_message_id));
						await emailTriage.markStatus(profileId, open.map((r) => r.uuid), "archived");
						archived += open.length;
					} catch (err) {
						// Unsubscribed is the part that matters; the archive can be redone.
						console.warn("[actions] unsubscribe_senders: unsubscribed but archive failed:", err.message);
					}
				}
			}
			if (!done.length) throw new Error("None of those senders accepted the unsubscribe");
			return { ref: done.join(","), detail: { unsubscribed: done.length, failed: failed.length, archived } };
		},
	},

	// Mail card phase 3, added on the owner's instruction 2026-09-30: the
	// bundle form of file_travel_or_school_email. Every item goes through that
	// action's own normalize(), so a bundle can never accept an event the
	// single-email action would refuse. Capped at 10 because a wrong date is
	// worse than a missed promo: the card lists every event it will add.
	{
		id: "add_email_events",
		label: "Add events from emails",
		provider: "google_calendar",
		consentType: "action_authority",
		reversible: true,
		standing: false,
		describe:
			"Add the calendar events from several triaged travel or school emails " +
			"at once, filing each email into its label — the bundle form of " +
			"file_travel_or_school_email, with the same rules for every item.",
		params: {
			items: "Array of 1-10 file_travel_or_school_email params objects. Required.",
		},

		normalize(raw = {}) {
			const items = Array.isArray(raw.items) ? raw.items : [];
			if (!items.length) throw invalid("Needs at least one email");
			if (items.length > 10) throw invalid("Too many events in one proposal");
			const single = get("file_travel_or_school_email");
			const seen = new Set();
			const clean = items.map((item) => single.normalize(item)).filter((item) => {
				if (seen.has(item.email_triage_uuid)) return false;
				seen.add(item.email_triage_uuid);
				return true;
			});
			return { items: clean };
		},

		summarize(p) {
			const list = p.items.map((i) => {
				const when = i.event.all_day ? `all day ${i.event.start}` : humanTime(i.event.start, i.event.time_zone);
				return `"${i.event.title}" (${when})`;
			});
			const shown = list.slice(0, 4).join(", ") + (list.length > 4 ? ` and ${list.length - 4} more` : "");
			return `Add ${p.items.length === 1 ? "this event" : `${p.items.length} events`} to your calendar — ${shown} — and file the emails`.slice(0, 500);
		},

		async execute(profileId, params) {
			const rows = await emailTriage.getRowsByUuids(profileId, params.items.map((i) => i.email_triage_uuid));
			const byUuid = new Map(rows.filter((r) => r.status === "new").map((r) => [r.uuid, r]));
			const created = [];
			const failed = [];
			let filed = 0;
			for (const item of params.items) {
				const row = byUuid.get(item.email_triage_uuid);
				if (!row) continue; // dealt with since the proposal — skip, don't fail the rest
				try {
					const { ref } = await googleCalendar.createEvent(profileId, item.event);
					created.push({ uuid: row.uuid, ref });
				} catch (err) {
					failed.push(row.uuid);
					console.warn("[actions] add_email_events: event failed:", err.message);
					continue;
				}
				try {
					await gmail.fileMessage(profileId, row.gmail_message_id, item.label);
					filed++;
				} catch (err) {
					console.warn("[actions] add_email_events: event created but filing failed:", err.message);
				}
			}
			if (!created.length) throw new Error(failed.length ? "None of those events could be added" : "None of these emails are still open");
			await emailTriage.markStatus(profileId, created.map((c) => c.uuid), "actioned");
			return { ref: created.map((c) => c.ref).join(","), detail: { added: created.length, filed, failed: failed.length } };
		},
	},

	// Mail card phase 2 (docs/architecture/mail-card.md), added on the
	// owner's instruction 2026-09-30. Archive, not Trash, was the owner's call
	// for promos: nothing is deleted and everything stays searchable.
	{
		id: "archive_emails",
		label: "Archive emails",
		provider: "gmail",
		consentType: "action_authority",
		// Archive only removes the INBOX label. Every message stays in All Mail
		// and in search, and "Move to Inbox" in Gmail puts it back.
		reversible: true,
		// Not yet. A standing approval for archive bundles is the owner's
		// decision to make later, never one this code grants itself.
		standing: false,
		describe:
			"Archive triaged emails out of the inbox in one go — for promotions, " +
			"newsletters and automated notifications the person doesn't need to " +
			"see. Nothing is deleted: they stay in All Mail and Gmail search.",
		params: {
			email_triage_uuids: "Array of 1-100 email_triage uuids to archive. Required.",
		},

		normalize(raw = {}) {
			const uuids = Array.isArray(raw.email_triage_uuids) ? raw.email_triage_uuids : [];
			if (!uuids.length) throw invalid("Needs at least one email");
			if (uuids.length > 100) throw invalid("Too many emails in one proposal");
			const clean = [...new Set(uuids.map((u) => {
				const email_triage_uuid = str(u, 36);
				if (!email_triage_uuid) throw invalid("Each entry needs an email_triage_uuid");
				return email_triage_uuid;
			}))];
			return { email_triage_uuids: clean };
		},

		summarize(p) {
			const n = p.email_triage_uuids.length;
			return `Archive ${n === 1 ? "this email" : `${n} emails`} out of your inbox (still in All Mail and search)`;
		},

		async execute(profileId, params) {
			const rows = await emailTriage.getRowsByUuids(profileId, params.email_triage_uuids);
			// Only what is still open here: mail already archived, filed or
			// trashed (in Gmail or through Athena) since the proposal is skipped.
			const open = rows.filter((r) => r.status === "new");
			if (!open.length) throw new Error("None of these emails are still in the inbox");
			await gmail.archiveMessages(profileId, open.map((r) => r.gmail_message_id));
			await emailTriage.markStatus(profileId, open.map((r) => r.uuid), "archived");
			return { ref: open.map((r) => r.uuid).join(","), detail: { archived: open.length } };
		},
	},
];

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

/**
 * The JSON schema for `proposed_action.params` in the reply schema: every
 * param name any action declares, all optional. Owner-approved 2026-10-04.
 *
 * Gemini's structured output fills an object with NO declared properties as
 * `{}` — always. Until 2026-10-04 the reply schema said only
 * `params: { type: "object" }`, so every proposal from chat arrived empty and
 * normalize() rejected it on its first required field ("An event needs a
 * title", "A place reminder needs something to remind them").
 *
 * Listing names here only lets the model WRITE them; normalize() still decides
 * what each action accepts, so this widens nothing a person can be asked to
 * approve. Types follow what normalize() reads.
 */
const PARAM_TYPES = {
	all_day: { type: "boolean" },
	email_triage_uuids: { type: "array", items: { type: "string" } },
	items: {
		type: "array",
		items: {
			type: "object",
			properties: {
				email_triage_uuid: { type: "string" },
				label: { type: "string" },
				merchant: { type: "string" },
				category: { type: "string" },
				amount: { type: "number" },
				currency: { type: "string" },
				purchased_at: { type: "string" },
				sender: { type: "string" },
				title: { type: "string" },
				start: { type: "string" },
				end: { type: "string" },
				all_day: { type: "boolean" },
				time_zone: { type: "string" },
				location: { type: "string" },
			},
		},
	},
};
function paramsSchema() {
	const properties = {};
	for (const action of ACTIONS) {
		for (const name of Object.keys(action.params || {})) {
			properties[name] = PARAM_TYPES[name] || { type: "string" };
		}
	}
	return { type: "object", properties };
}

/** The descriptor, or null. Callers must treat null as "refuse", not "allow". */
function get(id) {
	return (typeof id === "string" && BY_ID.get(id)) || null;
}

module.exports = { ACTIONS, get, invalid, paramsSchema };
