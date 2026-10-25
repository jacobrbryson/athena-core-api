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
 *   alternatives   optional; what to offer instead when this one doesn't fit.
 *                  A hint the model reads, nothing more — whatever it proposes
 *                  instead goes through that action's own normalize().
 *   normalize(raw, ctx) -> clean params | throws
 *   summarize(params) -> the plain-language sentence the person approves
 *   execute(profileId, params, ctx) -> { ref, detail }
 *   availableTo(profileId) -> boolean   optional; narrows who is offered it
 *   sameAs(earlier, params) -> boolean  optional; is this a repeat of an
 *                  earlier proposal's params (index.js earlierCopy)? Defaults
 *                  to identical params; false opts out of the repeat check.
 *                  It can only stop a second write, never allow anything.
 */

const googleCalendar = require("../connectors/googleCalendar");
const gmail = require("../connectors/gmail");
const emailTriage = require("../emailTriage");
const memory = require("../memory");
const lookRequests = require("../lookRequests");
const unsubscribe = require("../unsubscribe");
const emailDraft = require("../emailDraft");
const placeReminders = require("../placeReminders");
const timeReminders = require("../timeReminders");
const codeAgents = require("../codeAgents");
const familyHealth = require("../familyHealth");
const projectStore = require("../projects");
const projectShape = require("../projects/shape");
const projectEntries = require("../projects/entries");
const familyChores = require("../familyChores");
const googleKeep = require("../connectors/googleKeep");

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

const FILLER = new Set(
	"the and for with again that this its are was were from into when what still not but you your has have been just also".split(" ")
);

/** Lowercase words that carry meaning, punctuation dropped ("Taylor's" -> "taylors"). */
function words(text) {
	return new Set(
		String(text || "")
			.toLowerCase()
			.replace(/['’]/g, "")
			.split(/[^a-z0-9]+/)
			.filter((w) => w.length >= 3 && !FILLER.has(w))
	);
}

/**
 * Two model-written phrasings of the same request: one's words all inside the
 * other's ("Taylor's house" / "Going to Taylor's house"), or mostly shared.
 * Used only to recognise a repeat, so a miss costs a duplicate and a false
 * match costs a second "it's already done" — never a write.
 */
function sameText(a, b) {
	const x = words(a);
	const y = words(b);
	if (!x.size || !y.size) return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
	let shared = 0;
	for (const w of x) if (y.has(w)) shared += 1;
	return shared === Math.min(x.size, y.size) || shared / (x.size + y.size - shared) >= 0.6;
}

/** The same moment, whether written with an offset or as local time in a zone. */
function sameInstant(a, aZone, b, bZone) {
	if (!a || !b) return a === b;
	const ms = (raw, tz) => (tz || /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? whenOf(raw, tz) : new Date(`${raw}Z`)).getTime();
	return ms(a, aZone) === ms(b, bZone);
}

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

/**
 * An instant() string as a Date. An offsetless one is read in `timeZone`
 * (instant() only lets it through when a zone was given).
 */
function whenOf(raw, timeZone) {
	if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) return new Date(raw);
	const asUtc = new Date(`${raw}Z`);
	// The zone's offset at that moment, from how Intl writes it there.
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(asUtc);
	const get = (t) => Number(parts.find((x) => x.type === t)?.value);
	const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
	return new Date(asUtc.getTime() - (shown - asUtc.getTime()));
}

/** Longest a reminder's condition may take before she asks about it instead. */
const MAX_WITHIN_HOURS = 48;
const DEFAULT_WITHIN_HOURS = 12;

/**
 * The "after" half of a conditional place reminder, or null when there is
 * none. A place is resolved like the reminder's own (a point of interest or
 * a geocoded address — never a guessed point); a time must be a real instant
 * no more than a week out. Untrusted input, so only these fields survive.
 */
async function afterCondition(raw, ctx) {
	const hasPlace = !!(str(raw.after_place, 80) || str(raw.after_address, 200));
	const hasTime = !!str(raw.after_time, 40);
	if (!hasPlace && !hasTime) return null;
	if (hasPlace && hasTime) throw invalid("Give the condition as a place or a time, not both");
	const hoursRaw =
		raw.within_hours === undefined || raw.within_hours === null || raw.within_hours === ""
			? DEFAULT_WITHIN_HOURS
			: Number(raw.within_hours);
	if (!Number.isFinite(hoursRaw) || hoursRaw <= 0) throw invalid("within_hours must be a positive number of hours");
	const hours = Math.min(hoursRaw, MAX_WITHIN_HOURS);
	const now = Date.now();
	if (hasPlace) {
		const first = await placeReminders.resolvePlace(ctx.profileId, {
			place: raw.after_place,
			address: raw.after_address,
			place_name: raw.after_label,
		});
		return {
			kind: "place",
			label: (str(raw.after_label, 120) || first.place_name).slice(0, 120),
			latitude: first.latitude,
			longitude: first.longitude,
			expires_at: new Date(now + hours * 3600_000).toISOString(),
		};
	}
	const timeZone = zone(raw.time_zone);
	const at = instant(raw.after_time, { timeZone });
	if (!at) throw invalid("after_time needs a UTC offset or a time_zone");
	const when = whenOf(at, timeZone);
	if (when.getTime() > now + 7 * 86400_000) throw invalid("after_time can be at most a week out");
	return {
		kind: "time",
		label: (str(raw.after_label, 120) || "that time").slice(0, 120),
		at: when.toISOString(),
		expires_at: new Date(Math.max(when.getTime(), now) + hours * 3600_000).toISOString(),
		...(timeZone ? { time_zone: timeZone } : {}),
	};
}

/**
 * Thermostat bounds, in °C (Nest's own unit). Heat 50–80 °F: below 50 risks
 * frozen pipes, above 80 is never what anyone meant. Cool 62–88 °F: below 62
 * strains the system for nothing, above 88 is "off" said badly. Heat-cool
 * keeps 3 °F between its ends; Nest refuses narrower ranges anyway.
 */
const THERMOSTAT_MODES = new Set(["HEAT", "COOL", "HEATCOOL", "OFF"]);
const THERMOSTAT_BOUNDS = { heat: [10, 26.67], cool: [16.67, 31.11] };
const THERMOSTAT_GAP_C = 1.66;

const MAX_EVENT_DAYS = 365;
const MAX_EVENT_HOURS = 24 * 14;

const ACTIONS = [
	{
		id: "update_grocery_list",
		label: "Update the grocery list",
		provider: "google_keep",
		consentType: "action_authority",
		reversible: true,
		// A shared household list changes for everyone. Ask the person each time.
		standing: false,
		describe: "Add up to ten items to the family's shared Google Keep grocery list in one proposal, or mark one open item bought. Include every item the person asked to add in grocery_items. Propose only when the person asks to change the list; never claim the change happened before approval.",
		params: {
			operation: '"add" to put an item on the list (or untick a regular), or "bought" to tick off an open item.',
			item: "The exact single grocery item for a one-item request or marking it bought. No comma-separated bundle.",
			grocery_items: "For adding several items, an array of 1-10 exact item names, such as [\"apples\", \"bananas\", \"blueberries\"]. Use instead of item.",
			list_title: "Exact Keep list title, required only when more than one grocery list is shared.",
		},
		async normalize(raw = {}, ctx = {}) {
			const operation = raw.operation;
			if (operation !== "add" && operation !== "bought") throw invalid('Choose "add" or "bought" for the grocery item');
			const batch = Array.isArray(raw.grocery_items) && raw.grocery_items.length > 0;
			if (raw.grocery_items != null && !Array.isArray(raw.grocery_items)) throw invalid("Add 1-10 grocery items in one request");
			if (batch && (operation !== "add" || raw.grocery_items.length > 10)) {
				throw invalid("Add 1-10 grocery items in one request");
			}
			const items = (batch ? raw.grocery_items : [raw.item]).map((value) => typeof value === "string" ? value.trim() : "");
			if (items.some((item) => !item || item.length > 120 || /[,\r\n\x00-\x1f]/.test(item))) throw invalid("Name each grocery item (120 characters at most)");
			if (new Set(items.map(googleKeep.itemKey)).size !== items.length) throw invalid("Name each grocery item only once");
			const list = await googleKeep.groceryTarget(ctx.profileId, raw.list_title);
			if (batch) {
				const pending = [];
				const already_on_list = [];
				for (const item of items) {
					const matches = list.items.filter((i) => googleKeep.itemKey(i.text) === googleKeep.itemKey(item));
					(matches.some((i) => !i.checked) ? already_on_list : pending).push(matches[0]?.text || item);
				}
				if (!pending.length) throw invalid("Those items are already on the grocery list");
				const params = { list_id: list.id, list_title: list.title, grocery_items: pending, already_on_list, operation };
				if (this.summarize(params).length >= 500) throw invalid("Too many long item names for one approval; please split the request");
				return params;
			}
			const item = items[0];
			const matches = list.items.filter((i) => googleKeep.itemKey(i.text) === googleKeep.itemKey(item));
			const open = matches.filter((i) => !i.checked);
			if (operation === "add" && open.length) throw invalid("That item is already on the grocery list");
			if (operation === "bought" && !open.length) throw invalid("That item is not waiting to be bought");
			if (operation === "bought" && open.length > 1) throw invalid("Keep has more than one open matching item; please edit it there");
			// Keep can hold several checked copies of a regular. One approval
			// reopens one copy; it never creates an eleventh or changes them all.
			return { list_id: list.id, list_title: list.title, item: (operation === "bought" ? open[0] : matches[0])?.text || item, operation };
		},
		summarize(p) {
			if (p.grocery_items) {
				const added = p.grocery_items.map((item) => `"${item}"`).join(", ");
				const present = p.already_on_list?.length ? `; already on list: ${p.already_on_list.map((item) => `"${item}"`).join(", ")}` : "";
				return `Add ${added} to "${p.list_title}" in Google Keep${present}`;
			}
			return (p.operation === "add" ? `Add "${p.item}" to "${p.list_title}" in Google Keep` : `Mark "${p.item}" bought on "${p.list_title}" in Google Keep`).slice(0, 500);
		},
		async execute(profileId, params) {
			if (params.grocery_items) return googleKeep.updateGroceryItems(profileId, params);
			return googleKeep.updateGroceryItem(profileId, params);
		},
	},
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
		alternatives:
			'It is also how to remind them of something at a time ("remind me at 7 to…"): a short ' +
			"event at that time, titled with the reminder, gets their calendar's own alert.",
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

		// Same times and a matching title. Location and description are left
		// out on purpose: the 2026-10-11 duplicate differed only by a location.
		sameAs(a, b) {
			if (!!a.all_day !== !!b.all_day || !sameText(a.title, b.title)) return false;
			if (a.all_day) return a.start === b.start && a.end === b.end;
			return sameInstant(a.start, a.time_zone, b.start, b.time_zone) && sameInstant(a.end, a.time_zone, b.end, b.time_zone);
		},

		async execute(profileId, params) {
			const { ref, html_link } = await googleCalendar.createEvent(profileId, params);
			return { ref, detail: { html_link } };
		},
	},

	{
		id: "set_thermostat",
		label: "Change a thermostat",
		// Added on the owner's instruction (2026-10-16): mode, temperature and
		// eco on their own Google Nest thermostats, every change on a card they
		// confirm. Never standing: a thermostat is shared by the whole house.
		provider: "nest",
		consentType: "action_authority",
		// They can change it straight back, here or on the thermostat.
		reversible: true,
		standing: false,
		describe:
			"Change one of the person's own Google Nest thermostats: its mode (heat, cool, " +
			"heat-cool, off), the temperature it heats or cools to, or eco on/off. Propose this " +
			"when they ask to turn the heat or AC up, down, on or off, or set a temperature. " +
			"One thermostat per proposal. Do not propose it to answer what a thermostat is set " +
			"to (reading needs no approval), and not for one that is offline or not reporting.",
		alternatives:
			"If the thermostat is offline or not reporting, say so instead: Google cannot reach " +
			"it, so a change would not arrive.",
		params: {
			thermostat: 'Which thermostat, by its room or name as you see it ("Den", "Upstairs"). Required.',
			mode: "HEAT, COOL, HEATCOOL or OFF. Only when they ask to change the mode.",
			heat_to: "Temperature to heat to, in unit. With mode HEAT or HEATCOOL.",
			cool_to: "Temperature to cool to, in unit. With mode COOL or HEATCOOL.",
			unit: "F or C: the unit heat_to/cool_to are in. Required with a temperature.",
			eco: "on or off. Eco on cannot be combined with a mode or temperature.",
		},

		async normalize(raw = {}, ctx = {}) {
			const nest = require("../connectors/nest");
			const wanted = str(raw.thermostat, 120);
			if (!wanted) throw invalid("Say which thermostat");
			// Only the person's own stored thermostats: a model-written device
			// name could otherwise point at anything in the Device Access project.
			const devices = await nest.storedDevices(ctx.profileId);
			const key = (s) => String(s || "").toLowerCase().replace(/\bthermostat\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
			const want = key(wanted);
			const matches = devices.filter((d) => [d.displayName, d.room, nest.deviceTitle(d)].some((n) => n && key(n) === want));
			if (!matches.length) throw invalid(`There is no thermostat called "${wanted}" shared with Athena`);
			if (matches.length > 1) throw invalid(`More than one thermostat matches "${wanted}"; name it more exactly`);
			const t = matches[0];
			if (t.connectivity !== "ONLINE") {
				throw invalid(`The ${nest.deviceTitle(t)} is ${t.notReporting ? "not reporting" : "offline"}, so a change would not reach it`);
			}

			const r = t.readings || {};
			const given = (v) => v !== undefined && v !== null && v !== "";
			const mode = given(raw.mode) ? String(raw.mode).toUpperCase() : null;
			if (mode && !THERMOSTAT_MODES.has(mode)) throw invalid("Mode must be HEAT, COOL, HEATCOOL or OFF");
			const eco = given(raw.eco) ? String(raw.eco).toLowerCase() : null;
			if (eco && eco !== "on" && eco !== "off") throw invalid('Eco must be "on" or "off"');
			const hasHeat = given(raw.heat_to);
			const hasCool = given(raw.cool_to);
			if (!mode && !eco && !hasHeat && !hasCool) throw invalid("Nothing to change");
			if (eco === "on" && (mode || hasHeat || hasCool)) throw invalid("Eco on cannot be combined with a mode or temperature");

			// A temperature always carries its unit. Guessing F vs C turns 22 into
			// 22 °F (off, near enough) or 22 °C (warm) — refused, never guessed.
			const unit = hasHeat || hasCool ? String(raw.unit || "").toUpperCase() : null;
			if (unit !== null && unit !== "F" && unit !== "C") throw invalid("Give the unit for the temperature: F or C");
			const toC = (v, which) => {
				const n = Number(v);
				if (!Number.isFinite(n)) throw invalid(`The ${which} temperature must be a number`);
				return unit === "F" ? ((n - 32) * 5) / 9 : n;
			};
			const ecoOn = !!r.eco && r.eco !== "OFF";
			if ((hasHeat || hasCool || mode) && ecoOn && eco !== "off") {
				throw invalid("Eco is on; include eco off to change the mode or temperature");
			}
			const target = mode || r.mode || null;
			if ((hasHeat || hasCool) && (!target || target === "OFF")) throw invalid("A temperature needs the thermostat in heat, cool or heat-cool");
			if (hasHeat && target === "COOL") throw invalid("heat_to does not apply in COOL mode");
			if (hasCool && target === "HEAT") throw invalid("cool_to does not apply in HEAT mode");

			let heatC = hasHeat ? toC(raw.heat_to, "heat") : null;
			let coolC = hasCool ? toC(raw.cool_to, "cool") : null;
			// Heat-cool sets both ends at once; a missing end keeps what it is now.
			if (target === "HEATCOOL" && (hasHeat || hasCool)) {
				if (heatC === null) heatC = Number.isFinite(r.heatC) ? r.heatC : null;
				if (coolC === null) coolC = Number.isFinite(r.coolC) ? r.coolC : null;
				if (heatC === null || coolC === null) throw invalid("Heat-cool needs both a heat and a cool temperature");
				if (coolC - heatC < THERMOSTAT_GAP_C) throw invalid("Keep at least 3 °F (1.7 °C) between heat and cool");
			}
			const within = (c, [lo, hi]) => c >= lo - 0.01 && c <= hi + 0.01;
			if (heatC !== null && !within(heatC, THERMOSTAT_BOUNDS.heat)) throw invalid("Heat must be between 50 °F and 80 °F (10–26.5 °C)");
			if (coolC !== null && !within(coolC, THERMOSTAT_BOUNDS.cool)) throw invalid("Cool must be between 62 °F and 88 °F (16.5–31 °C)");

			const round = (c) => Math.round(c * 10) / 10;
			const p = {
				device_name: t.name,
				thermostat: nest.deviceTitle(t),
				...(eco === "on" || (eco === "off" && ecoOn) ? { eco } : {}),
				...(mode && mode !== r.mode ? { mode } : {}),
				...(heatC !== null ? { heat_c: round(heatC) } : {}),
				...(coolC !== null ? { cool_c: round(coolC) } : {}),
				// How the card shows temperatures: as asked, else as the thermostat does.
				unit: unit || (r.scale === "CELSIUS" ? "C" : "F"),
			};
			if (!p.eco && !p.mode && p.heat_c === undefined && p.cool_c === undefined) {
				throw invalid(`The ${p.thermostat} is already set that way`);
			}
			return p;
		},

		summarize(p) {
			const deg = (c) => (p.unit === "C" ? `${c}°C` : `${Math.round((c * 9) / 5 + 32)}°F`);
			const bits = [];
			if (p.eco === "on") bits.push("turn eco on");
			if (p.eco === "off") bits.push("turn eco off");
			if (p.mode === "OFF") bits.push("turn it off");
			else if (p.mode) bits.push(`switch to ${p.mode === "HEATCOOL" ? "heat-cool" : p.mode.toLowerCase()}`);
			if (p.heat_c !== undefined && p.cool_c !== undefined) bits.push(`keep it between ${deg(p.heat_c)} and ${deg(p.cool_c)}`);
			else if (p.heat_c !== undefined) bits.push(`heat to ${deg(p.heat_c)}`);
			else if (p.cool_c !== undefined) bits.push(`cool to ${deg(p.cool_c)}`);
			return `Set the ${p.thermostat}: ${bits.join(", then ")}`.slice(0, 500);
		},

		async execute(profileId, p) {
			const nest = require("../connectors/nest");
			const C = "sdm.devices.commands.";
			// Eco off first and mode before setpoint: Nest refuses a setpoint
			// while eco is on, or one that does not belong to the current mode.
			const commands = [];
			if (p.eco === "off") commands.push({ command: `${C}ThermostatEco.SetMode`, params: { mode: "OFF" } });
			if (p.mode) commands.push({ command: `${C}ThermostatMode.SetMode`, params: { mode: p.mode } });
			if (p.heat_c !== undefined && p.cool_c !== undefined) {
				commands.push({ command: `${C}ThermostatTemperatureSetpoint.SetRange`, params: { heatCelsius: p.heat_c, coolCelsius: p.cool_c } });
			} else if (p.heat_c !== undefined) {
				commands.push({ command: `${C}ThermostatTemperatureSetpoint.SetHeat`, params: { heatCelsius: p.heat_c } });
			} else if (p.cool_c !== undefined) {
				commands.push({ command: `${C}ThermostatTemperatureSetpoint.SetCool`, params: { coolCelsius: p.cool_c } });
			}
			if (p.eco === "on") commands.push({ command: `${C}ThermostatEco.SetMode`, params: { mode: "MANUAL_ECO" } });
			await nest.executeCommands(profileId, p.device_name, commands);
			return { ref: p.device_name, detail: null };
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

		// Another look is a new look, whatever the reason says; lookRequests
		// caps how many can be outstanding.
		sameAs: false,

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

	// Coding agents (services/codeAgents.js), added on the owner's
	// instruction 2026-10-09 — phase 3 of "Athena: Inner Monologue & Coding
	// Agents". Investigate only: it opens a GitHub issue, and the repo's own
	// workflow has Claude Code and Codex read the code with read-only
	// permissions and comment back. Nothing in this action can change code.
	// Offered only to the Google ids the owner listed in CODE_AGENT_GOOGLE_IDS.
	{
		id: "investigate_code",
		label: "Have Claude Code and Codex investigate a bug",
		provider: null,
		consentType: "action_authority",
		// It opens an issue the owner can close; no code, data or account changes.
		reversible: true,
		// The owner chose "read-only is always approved": a standing approval
		// is allowed, and only the owner can grant it.
		standing: true,
		describe:
			"Ask coding agents (Claude Code and Codex) to read your own source code and diagnose " +
			"something that is wrong with you or your apps — bad data on a dashboard card, a " +
			"feature misbehaving, an error. Read-only: they explain the cause, they change nothing. " +
			"Pick the repository the problem most likely lives in. Their findings come back in a few " +
			"minutes; tell the person you'll pass them on.",
		params: {
			repo: `Which codebase: ${Object.entries(codeAgents.REPOS)
				.map(([k, r]) => `"${k}" (${r.about})`)
				.join("; ")}. Required.`,
			symptom: "What is wrong, in one or two plain sentences, as the person described it. Required.",
			details:
				"Anything you know that would help: what the data should have been, when it started, which card or screen. Optional.",
		},

		availableTo(profileId) {
			return codeAgents.mayUse(profileId);
		},

		async normalize(raw = {}, ctx = {}) {
			const repo = str(raw.repo, 40);
			if (!repo || !Object.prototype.hasOwnProperty.call(codeAgents.REPOS, repo)) {
				throw invalid(`Repo must be one of: ${Object.keys(codeAgents.REPOS).join(", ")}`);
			}
			const symptom = str(raw.symptom, 600);
			if (!symptom || symptom.length < 10) throw invalid("Say what is wrong in a sentence");
			const details = str(raw.details, 2000);
			// Checked here too, not only when offering: a proposal must not
			// outlive the person's place on the owner's list.
			if (!ctx.profileId || !(await codeAgents.mayUse(ctx.profileId))) {
				throw invalid("Coding agents are not available to this account");
			}
			return details ? { repo, symptom, details } : { repo, symptom };
		},

		summarize(p) {
			return `Ask Claude Code and Codex to look into ${p.repo} (read-only): ${p.symptom}`.slice(0, 500);
		},

		// The symptom is reworded every time she proposes it again.
		sameAs(a, b) {
			return a.repo === b.repo && sameText(a.symptom, b.symptom);
		},

		async execute(profileId, params) {
			if (!(await codeAgents.mayUse(profileId))) {
				throw new Error("Coding agents are not available to this account");
			}
			const { ref } = await codeAgents.openInvestigation(params);
			return { ref, detail: null };
		},
	},

	// Code fixes, authorized by the owner 2026-10-10 (workspace AGENTS.md,
	// "Code fixes") — phase 4. Opens an issue labeled `athena-fix`; the repo's
	// athena-fix workflow has one agent write the change and opens a pull
	// request that GitHub auto-merges only when every required check passes,
	// including the protected-path check. Athena never pushes or merges.
	// Never standing: the owner approves every fix.
	{
		id: "fix_code",
		label: "Have a coding agent fix a bug",
		provider: null,
		consentType: "action_authority",
		// A merged fix deploys. Reverting it is another pull request, not an undo.
		reversible: false,
		standing: false,
		describe:
			"Have a coding agent change your own source code: fix a bug (often after an investigation " +
			"found the cause) or make a small change the owner asks for, like spacing, wording or a layout " +
			"tweak on a screen. Changing your own code this way IS allowed: the owner authorized it on " +
			"2026-10-10, and it is not an exception to your security rules, because changes to security, " +
			"sign-in, permissions, your actions, dependencies or deployment are refused automatically by a " +
			"required check before anything merges. So never decline a requested change for security " +
			"reasons; propose it and let the checks decide. One agent writes it and opens a pull request, " +
			"which merges and deploys by itself only if every check passes; say plainly that approving it " +
			"can change and redeploy the app.",
		params: {
			repo: "Which codebase, from the same list as investigate_code. Required.",
			change:
				"What to change, specifically: the file or behavior, what it does now and what it should do. " +
				"Required.",
			investigation:
				'The investigation it follows from, as its reference ("owner/repo#12"), when there is one. Optional.',
			agent:
				'"claude" (default) or "codex" — who writes the fix. Use "codex" when they ask for ' +
				"ChatGPT, OpenAI or Codex. Optional.",
		},

		availableTo(profileId) {
			return codeAgents.mayUse(profileId);
		},

		async normalize(raw = {}, ctx = {}) {
			const repo = str(raw.repo, 40);
			if (!repo || !Object.prototype.hasOwnProperty.call(codeAgents.REPOS, repo)) {
				throw invalid(`Repo must be one of: ${Object.keys(codeAgents.REPOS).join(", ")}`);
			}
			const change = str(raw.change, 1500);
			if (!change || change.length < 20) {
				// Names the field on purpose. The repair pass shows the model this
				// reason, and in production (2026-10-11) "say exactly what to
				// change" alone sent it round twice with the same mistake.
				throw Object.assign(invalid("Say exactly what to change — which screen, and what it should do"), {
					// For the model only (the repair pass); the message above is what
					// the person may be shown.
					hint:
						'Put it in params.change: e.g. "Reduce the top margin above the Good morning greeting on the ' +
						'Companion dashboard". symptom and details belong to investigate_code, not fix_code.',
				});
			}
			const agent = raw.agent === undefined || raw.agent === null || raw.agent === "" ? "claude" : raw.agent;
			if (agent !== "claude" && agent !== "codex") throw invalid('Agent must be "claude" or "codex"');
			let investigation = null;
			if (raw.investigation) {
				const ref = codeAgents.parseRef(str(raw.investigation, 120));
				// Only an investigation in the same repository; anything else is dropped
				// rather than pointing the agent at an unrelated issue.
				if (!ref || ref.full !== codeAgents.REPOS[repo].full) {
					throw invalid("The investigation must be one in the same repository");
				}
				investigation = `${ref.full}#${ref.number}`;
			}
			if (!ctx.profileId || !(await codeAgents.mayUse(ctx.profileId))) {
				throw invalid("Coding agents are not available to this account");
			}
			return { repo, change, agent, ...(investigation ? { investigation } : {}) };
		},

		summarize(p) {
			const who = p.agent === "codex" ? "Codex" : "Claude Code";
			return `Have ${who} fix ${p.repo}: ${p.change} — merges and deploys by itself if every check passes`.slice(0, 500);
		},

		// A different agent is a deliberate second attempt, not a repeat.
		sameAs(a, b) {
			return a.repo === b.repo && a.agent === b.agent && sameText(a.change, b.change);
		},

		async execute(profileId, params) {
			if (!(await codeAgents.mayUse(profileId))) {
				throw new Error("Coding agents are not available to this account");
			}
			const { ref } = await codeAgents.openFix(params);
			return { ref, detail: null };
		},
	},

	// Time reminders (services/timeReminders.js), added on the owner's
	// instruction 2026-10-10 after "remind me tomorrow after soccer" had
	// nowhere to go. Fired by the athena-reminders job once a minute.
	{
		id: "remind_at_time",
		label: "Set a reminder for a time",
		provider: null,
		consentType: "action_authority",
		// Removable from the Community page, and it only ever sends the person a
		// notification.
		reversible: true,
		standing: true,
		describe:
			'Remind the person of something at a time: "remind me at 7 to…", "tomorrow ' +
			'morning remind me…". Say the time back in their words before proposing.',
		alternatives:
			'For "when I get to X" use remind_at_place; for "after the game", remind_at_place at ' +
			"home with after_time, or this at the time the game ends.",
		params: {
			reminder: "What to remind them, in a short sentence addressed to them. Required.",
			at: "When: ISO 8601 with UTC offset (2026-10-11T19:00:00-04:00), or give time_zone. Required.",
			time_zone: "IANA zone (America/New_York) when `at` carries no offset.",
		},

		normalize(raw = {}) {
			const reminder = str(raw.reminder, 300);
			if (!reminder) throw invalid("A reminder needs something to remind them");
			const timeZone = zone(raw.time_zone);
			const at = instant(raw.at, { timeZone });
			if (!at) throw invalid("A reminder needs a time with a UTC offset or a time_zone");
			const when = whenOf(at, timeZone);
			const now = Date.now();
			if (when.getTime() < now + 30_000) throw invalid("That time has already passed");
			if (when.getTime() > now + MAX_EVENT_DAYS * 86400_000) throw invalid("Reminders can be at most a year out");
			return { reminder, at: when.toISOString(), ...(timeZone ? { time_zone: timeZone } : {}) };
		},

		summarize(p) {
			return `At ${humanTime(p.at, p.time_zone)}, remind you: "${p.reminder}"`.slice(0, 500);
		},

		sameAs(a, b) {
			return a.at === b.at && sameText(a.reminder, b.reminder);
		},

		async execute(profileId, params, ctx = {}) {
			const { uuid } = await timeReminders.create(profileId, params, { actionUuid: ctx.actionUuid || null });
			return { ref: uuid, detail: null };
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
			"address from their points of interest, so they can correct you. It can " +
			'wait for something to happen first: "when I get home FROM THE GYM" (after_place) ' +
			'or "when we get home AFTER THE LAST GAME" (after_time = when that calendar event ends). ' +
			'"Home" is their home point of interest.',
		alternatives:
			'For a plain time ("tomorrow at 7") use remind_at_time. If the place isn\'t one of their ' +
			"points of interest and you don't know its street address, ask for the address rather " +
			"than proposing without one.",
		params: {
			place: "The point of interest's name exactly as listed in their community, e.g. \"Missy's\". Required unless address is given.",
			address: "A US street address with town, only when the place is not one of their points of interest.",
			place_name: "What to call an address-only place, e.g. \"Missy's\". Optional.",
			reminder: "What to remind them, in a short sentence addressed to them, e.g. \"Bring back her casserole dish\". Required.",
			repeats: '"next_visit" (default, fires once) or "every_visit" when they said whenever/every time. Always next_visit when there is an after_ condition.',
			after_place: 'Optional. A place they must visit first ("from the gym"): a point of interest\'s name.',
			after_address: "Optional. That first place's US street address, when it isn't a point of interest.",
			after_time:
				"Optional. Fire only on an arrival after this time: ISO 8601 with offset (or give time_zone), e.g. when the last game on their calendar ends.",
			after_label: 'Optional. How to say the condition back: "the gym", "the last soccer game".',
			within_hours: "Optional. How long the condition may take to happen before you ask them about it instead; default 12, at most 48.",
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
			const after = await afterCondition(raw, ctx);
			if (after && repeats === "every_visit") {
				throw invalid("A reminder that waits for something first fires once; drop every_visit or the condition");
			}
			return { ...place, reminder, repeats, ...(after ? { after } : {}) };
		},

		summarize(p) {
			const when = p.repeats === "every_visit" ? "Every time" : "Next time";
			const where = p.address ? `${p.place_name} (${p.address})` : p.place_name;
			if (p.after) {
				const until = humanTime(p.after.expires_at, p.after.time_zone);
				const first =
					p.after.kind === "place"
						? `after you've been at ${p.after.label}`
						: `after ${p.after.label} (${humanTime(p.after.at, p.after.time_zone)})`;
				const watch = p.after.kind === "place" ? ` I'll watch for you at ${p.after.label} too.` : "";
				return `When you get to ${where} ${first}, remind you: "${p.reminder}". If that hasn't happened by ${until}, I'll ask you about it.${watch}`.slice(0, 500);
			}
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

	// Family health watch (services/familyHealth.js), added on the owner's
	// instruction 2026-10-11: "make sure Athena can make health updates from
	// chat". The same write the Family page's Health watch form makes — start
	// a watch, log an update (a reading, a dose), or end it — so a fever
	// logged hourly doesn't need the dashboard open. Who it is about is
	// resolved here against the family's active watches, never taken on trust.
	{
		id: "log_health_update",
		label: "Log a family health update",
		provider: null,
		consentType: "action_authority",
		// Editable and endable from the Family page; it only writes Athena's
		// own note about who is unwell.
		reversible: true,
		// Hourly fever readings are exactly what a standing approval is for;
		// the person still has to grant it themselves.
		standing: true,
		describe:
			"Log a health update on someone in the family: start a health watch when they tell you " +
			'someone is unwell ("Thomas has a fever"), record an update on an active watch ("101.2 at ' +
			'3pm, gave him Tylenol"), change how often to ask for updates, or end the watch when ' +
			"they're feeling better. Use their exact words for the reading; never diagnose or add advice to it.",
		alternatives:
			"To remember a lasting fact about the person (an allergy, a medication they always take) use remember_fact. " +
			"To be reminded to give a dose at a time, use remind_at_time.",
		params: {
			health_person: "Who it's about, by name — for an update, the name on their active health watch. Required.",
			health_symptom: "What's wrong, short (\"a fever\", \"sore throat\"). Required to start a watch; omit on an update to keep it.",
			health_severity: '"mild", "moderate" or "severe". Optional; omit on an update to keep it.',
			health_reading: "This update in their words: a reading, a dose, how they seem. Optional.",
			check_in_hours: "Optional. Ask for an update every N hours (1-168); 0 turns check-ins off; omit to keep the current cadence.",
			feeling_better: "true only to END the watch because they're better. Omit otherwise.",
		},

		async normalize(raw = {}, ctx = {}) {
			if (!ctx.profileId) throw invalid("A health update needs a person");
			const person = str(raw.health_person, 120);
			if (!person) throw invalid("Say who the health update is about");
			const watch = await familyHealth.findActive(ctx.profileId, person);
			if (raw.feeling_better === true || raw.feeling_better === "true") {
				if (!watch) throw invalid(`There's no active health watch on ${person} to end`);
				return { watch_uuid: watch.uuid, person_name: watch.personName, feeling_better: true };
			}
			const symptom = str(raw.health_symptom, 200) || watch?.symptom || null;
			if (!symptom) throw invalid(`Say what's wrong with ${person} to start a health watch`);
			const severityRaw = str(raw.health_severity, 20)?.toLowerCase();
			if (severityRaw && !familyHealth.SEVERITIES.has(severityRaw)) {
				throw invalid('Severity must be "mild", "moderate" or "severe"');
			}
			const out = {
				person_name: watch?.personName || person,
				symptom,
				severity: severityRaw || watch?.severity || "mild",
				...(watch ? { watch_uuid: watch.uuid } : {}),
			};
			const reading = str(raw.health_reading, 500);
			if (reading) out.reading = reading;
			if (raw.check_in_hours !== undefined && raw.check_in_hours !== null && raw.check_in_hours !== "") {
				const hours = Number(raw.check_in_hours);
				if (hours === 0) out.check_in_hours = null;
				else if (Number.isInteger(hours) && hours >= 1 && hours <= familyHealth.MAX_CHECK_IN_HOURS) out.check_in_hours = hours;
				else throw invalid(`check_in_hours must be a whole number from 1 to ${familyHealth.MAX_CHECK_IN_HOURS}, or 0 for none`);
			}
			return out;
		},

		summarize(p) {
			if (p.feeling_better) return `End the health watch on ${p.person_name} — feeling better`;
			const every =
				p.check_in_hours === undefined ? "" : p.check_in_hours === null ? " Stop asking for updates." : ` Ask for an update every ${p.check_in_hours} hour${p.check_in_hours === 1 ? "" : "s"}.`;
			const what = p.watch_uuid
				? `Log an update on ${p.person_name} (${p.symptom}, ${p.severity})${p.reading ? `: "${p.reading}"` : ""}.`
				: `Start a health watch on ${p.person_name}: ${p.symptom}, ${p.severity}${p.reading ? ` — "${p.reading}"` : ""}.`;
			return `${what}${every}`.slice(0, 500);
		},

		// Two readings an hour apart can say the same thing ("still 101"); each
		// is a real update, so a repeat is never refused as already done.
		sameAs() {
			return false;
		},

		async execute(profileId, params) {
			if (params.feeling_better) {
				const ended = await familyHealth.resolve(profileId, params.watch_uuid);
				if (!ended) throw Object.assign(new Error("That health watch is no longer there"), { status: 404 });
				return { ref: ended.uuid, detail: null };
			}
			const saved = await familyHealth.report(profileId, {
				personName: params.person_name,
				symptom: params.symptom,
				severity: params.severity,
				...(params.reading ? { notes: params.reading } : {}),
				// Absent keeps the watch's cadence; null turns it off.
				...(params.check_in_hours !== undefined ? { checkInHours: params.check_in_hours } : {}),
			});
			return { ref: saved.uuid, detail: null };
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
	// Projects (services/projects), added on the owner's instruction 2026-10-13
	// (projects phase 1b: "add and update projects from chat"). The same writes
	// the Projects page makes, so "I finished the gutters" or "add a step to the
	// porch" doesn't need the app open. Which project is meant is resolved here
	// against their own list by title — exact, or one unambiguous match — and
	// never taken on trust; an ambiguous title is refused, naming the choices.
	{
		id: "add_project",
		label: "Start a project",
		provider: null,
		consentType: null,
		// Their own list; they can edit or delete it on the Projects page.
		reversible: true,
		standing: true,
		describe:
			"Start tracking a new project on their Projects page — something they want to get done or work toward " +
			'("I need to fix the attic insulation before winter", "track my bulk through March"). Not for a one-off ' +
			"reminder (remind_at_time) or a calendar slot (create_calendar_event). Check their projects list first; " +
			"if it already exists, use update_project instead.",
		params: {
			project_title: "Short name for it, e.g. \"Insulate the attic\". Required.",
			project_goal: "What done looks like or why it matters, in their words. Optional.",
			project_area: '"health", "family", "community", "home" or "work" — the part of life it mostly belongs to. Default "home".',
			project_priority: "1 (low) to 5 (critical). Optional; default 3.",
			project_deadline: "A hard deadline as YYYY-MM-DD, only if they gave one. Optional.",
			project_part_of: "The title of a bigger project or program this is part of, exactly as listed. Optional.",
		},

		async normalize(raw = {}, ctx = {}) {
			if (!ctx.profileId) throw invalid("A project needs a person");
			const input = {
				title: str(raw.project_title, 190),
				goal: str(raw.project_goal, 2000),
				priority: raw.project_priority === undefined || raw.project_priority === null || raw.project_priority === "" ? 3 : Number(raw.project_priority),
				hardDeadline: str(raw.project_deadline, 10),
				primaryArea: (str(raw.project_area, 16) || "home").toLowerCase(),
			};
			if (!input.title) throw invalid("A project needs a title");
			try {
				projectShape.normalizeProject(input);
				projectShape.normalizeAreas(input);
			} catch (err) {
				throw invalid(err.message);
			}
			let partOf = null;
			if (str(raw.project_part_of, 190)) {
				try {
					const parent = await projectStore.findByTitle(ctx.profileId, raw.project_part_of);
					partOf = { uuid: parent.uuid, title: parent.title };
				} catch (err) {
					throw invalid(err.message);
				}
			}
			return {
				project_title: input.title,
				...(input.goal ? { project_goal: input.goal } : {}),
				project_area: input.primaryArea,
				project_priority: input.priority,
				...(input.hardDeadline ? { project_deadline: input.hardDeadline } : {}),
				...(partOf ? { part_of_uuid: partOf.uuid, part_of_title: partOf.title } : {}),
			};
		},

		summarize(p) {
			const bits = [
				p.project_area !== "home" ? `under ${p.project_area[0].toUpperCase()}${p.project_area.slice(1)}` : null,
				p.part_of_title ? `as part of "${p.part_of_title}"` : null,
				p.project_deadline ? `due ${p.project_deadline}` : null,
			].filter(Boolean);
			return `Start the project "${p.project_title}"${bits.length ? ` ${bits.join(", ")}` : ""}`.slice(0, 500);
		},

		async execute(profileId, params) {
			const { uuid } = await projectStore.create(profileId, {
				title: params.project_title,
				goal: params.project_goal ?? null,
				priority: params.project_priority,
				hardDeadline: params.project_deadline ?? null,
				areas: [params.project_area],
				primaryArea: params.project_area,
				status: "idea",
			}, { source: "chat" });
			if (params.part_of_uuid) {
				await projectStore.addLink(profileId, uuid, { relation: "contributes_to", to: params.part_of_uuid })
					.catch((err) => console.warn("[actions] add_project link failed:", err.message));
			}
			return { ref: uuid, detail: null };
		},
	},

	{
		id: "update_project",
		label: "Update a project",
		provider: null,
		consentType: null,
		reversible: true,
		standing: true,
		describe:
			"Change one of their existing projects: mark it started, done, on hold or dropped; add a step; tick a step " +
			'off; add a note; set a deadline or priority ("I finished the gutters", "the porch is waiting on the ' +
			'lights", "add buying batts to the attic project"). Name the project exactly as it appears in their projects list.',
		params: {
			project: "The project's title exactly as listed. Required.",
			project_status: '"active" (started), "done", "waiting" (on hold), "dropped", or "ready". Optional.',
			project_waiting_on: 'With "waiting": what it waits on, short ("rain", "a quote"). Optional.',
			project_step: "A new step to add, short. Optional.",
			project_step_done: "The title of an existing step they finished. Optional.",
			project_note: "A note for the project's journal, in their words. Optional.",
			project_priority: "1 (low) to 5 (critical). Optional.",
			project_deadline: "A new hard deadline, YYYY-MM-DD. Optional.",
		},

		async normalize(raw = {}, ctx = {}) {
			if (!ctx.profileId) throw invalid("A project update needs a person");
			let row;
			try {
				row = await projectStore.findByTitle(ctx.profileId, str(raw.project, 190));
			} catch (err) {
				throw invalid(err.message);
			}
			const out = { project_uuid: row.uuid, project_title: row.title };
			const status = str(raw.project_status, 16)?.toLowerCase();
			if (status) {
				if (!["active", "done", "waiting", "dropped", "ready"].includes(status)) {
					throw invalid('Status must be "active", "done", "waiting", "dropped" or "ready"');
				}
				out.project_status = status;
				if (status === "waiting" && str(raw.project_waiting_on, 32)) out.project_waiting_on = str(raw.project_waiting_on, 32);
			}
			const step = str(raw.project_step, 190);
			if (step) out.project_step = step;
			const doneTitle = str(raw.project_step_done, 190)?.toLowerCase();
			if (doneTitle) {
				const [steps] = await projectStore.stepsOf(row.id);
				const match = steps.filter((s) => s.title.toLowerCase() === doneTitle);
				const loose = match.length ? match : steps.filter((s) => s.title.toLowerCase().includes(doneTitle) || doneTitle.includes(s.title.toLowerCase()));
				if (loose.length !== 1) {
					throw invalid(loose.length
						? `"${raw.project_step_done}" could be ${loose.slice(0, 4).map((s) => `"${s.title}"`).join(", ")} — say which`
						: `"${row.title}" has no step called "${raw.project_step_done}"`);
				}
				out.step_done_uuid = loose[0].uuid;
				out.step_done_title = loose[0].title;
			}
			const note = str(raw.project_note, 4000);
			if (note) out.project_note = note;
			const deadline = str(raw.project_deadline, 10);
			if (deadline) {
				if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || Number.isNaN(Date.parse(deadline))) throw invalid("Deadline must be YYYY-MM-DD");
				out.project_deadline = deadline;
			}
			if (raw.project_priority !== undefined && raw.project_priority !== null && raw.project_priority !== "") {
				const n = Number(raw.project_priority);
				if (!Number.isInteger(n) || n < 1 || n > 5) throw invalid("Priority is 1 to 5");
				out.project_priority = n;
			}
			if (Object.keys(out).length === 2) throw invalid("Say what to change about the project");
			return out;
		},

		summarize(p) {
			const word = { active: "started", done: "done", waiting: "on hold", dropped: "dropped", ready: "ready" };
			const parts = [
				p.project_status ? `mark it ${word[p.project_status]}${p.project_waiting_on ? ` (waiting on ${p.project_waiting_on})` : ""}` : null,
				p.step_done_title ? `tick off "${p.step_done_title}"` : null,
				p.project_step ? `add the step "${p.project_step}"` : null,
				p.project_note ? `add a note: "${p.project_note.slice(0, 120)}${p.project_note.length > 120 ? "…" : ""}"` : null,
				p.project_deadline ? `set the deadline to ${p.project_deadline}` : null,
				p.project_priority ? `set priority ${p.project_priority} of 5` : null,
			].filter(Boolean);
			return `"${p.project_title}": ${parts.join("; ")}`.slice(0, 500);
		},

		async execute(profileId, params) {
			const patch = {};
			if (params.project_status) patch.status = params.project_status;
			if (params.project_waiting_on) patch.waitingOn = params.project_waiting_on;
			if (params.project_deadline) patch.hardDeadline = params.project_deadline;
			if (params.project_priority) patch.priority = params.project_priority;
			if (Object.keys(patch).length) await projectStore.update(profileId, params.project_uuid, patch);
			if (params.step_done_uuid) await projectStore.updateStep(profileId, params.project_uuid, params.step_done_uuid, { status: "done" });
			if (params.project_step) await projectStore.addStep(profileId, params.project_uuid, { title: params.project_step });
			if (params.project_note) await projectEntries.add(profileId, params.project_uuid, { type: "note", body: params.project_note }, { source: "chat" });
			return { ref: params.project_uuid, detail: null };
		},
	},

	{
		id: "set_guardian_reports",
		label: "Change the Guardian report times",
		// Added on the owner's instruction (2026-10-25): "I or Athena should be
		// able to configure" the 9 PM sweep report and the 6 AM morning report.
		// Deliberately narrow: times and the two report switches only. It cannot
		// turn the sweep off, change cameras, thresholds or who is told — those
		// stay on the Guardian settings page — and never standing: it changes
		// what the whole household hears.
		provider: null,
		consentType: "action_authority",
		reversible: true,
		standing: false,
		availableTo: (profileId) => require("../eufyBridge").allowed(profileId),
		describe:
			"Change when the nightly Guardian sweep runs and sends its evening report (garage doors, umbrella, " +
			"tonight's weather), when the morning report about the night is sent, or turn either report on or off. " +
			"Times are the household's local time as 24-hour HH:MM. Propose it when they ask to move or stop " +
			"those reports. It cannot turn the sweep itself off or change cameras or who is told.",
		alternatives: "Turning the sweep off, cameras, weather limits and recipients are on Property → Security → Guardian → Settings.",
		params: {
			guardian_evening_time: "HH:MM, 24-hour local time for the sweep and its evening report. Only when changing it.",
			guardian_morning_time: "HH:MM, 24-hour local time for the morning report. Only when changing it.",
			guardian_evening_report: "on or off: send the evening report. Only when changing it.",
			guardian_morning_report: "on or off: send the morning report. Only when changing it.",
		},

		async normalize(raw = {}, ctx = {}) {
			if (!require("../eufyBridge").allowed(ctx.profileId)) throw invalid("Only adults authorized for household security can change Guardian reports");
			const { clockTime } = require("../guardianEngine/protocols");
			const given = (v) => v !== undefined && v !== null && v !== "";
			const out = {};
			for (const [name, key] of [["guardian_evening_time", "evening_time"], ["guardian_morning_time", "morning_time"]]) {
				if (!given(raw[name])) continue;
				const t = clockTime(raw[name]);
				if (!t) throw invalid(`${key === "evening_time" ? "The evening" : "The morning"} time must be HH:MM in 24-hour time`);
				out[name] = t;
			}
			for (const name of ["guardian_evening_report", "guardian_morning_report"]) {
				if (!given(raw[name])) continue;
				const v = String(raw[name]).toLowerCase();
				if (v !== "on" && v !== "off") throw invalid('Say "on" or "off" for a report');
				out[name] = v;
			}
			if (!Object.keys(out).length) throw invalid("Say which report time or switch to change");
			return out;
		},

		summarize(p) {
			const clock = (t) => {
				const [h, m] = t.split(":").map(Number);
				return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
			};
			const bits = [];
			if (p.guardian_evening_time) bits.push(`run the nightly sweep and evening report at ${clock(p.guardian_evening_time)}`);
			if (p.guardian_evening_report) bits.push(`turn the evening report ${p.guardian_evening_report}`);
			if (p.guardian_morning_time) bits.push(`send the morning report at ${clock(p.guardian_morning_time)}`);
			if (p.guardian_morning_report) bits.push(`turn the morning report ${p.guardian_morning_report}`);
			return `Guardian: ${bits.join("; ")}`.slice(0, 500);
		},

		async execute(profileId, p) {
			// Re-checked at execution: an allowlist change since the proposal wins.
			if (!require("../eufyBridge").allowed(profileId)) throw new Error("Not authorized for household security");
			const engine = require("../guardianEngine");
			const sweep = (await engine.loadProtocols()).nightly_sweep;
			const config = {
				...sweep.config,
				schedule: { ...sweep.config.schedule, ...(p.guardian_evening_time ? { time: p.guardian_evening_time } : {}) },
				reports: {
					...sweep.config.reports,
					...(p.guardian_morning_time ? { morningTime: p.guardian_morning_time } : {}),
					...(p.guardian_evening_report ? { evening: p.guardian_evening_report === "on" } : {}),
					...(p.guardian_morning_report ? { morning: p.guardian_morning_report === "on" } : {}),
				},
			};
			// enabled is left out on purpose: this never turns the sweep on or off.
			await engine.saveConfig(profileId, "nightly_sweep", { config });
			return { ref: "nightly_sweep", detail: null };
		},
	},
];

// ---------------------------------------------------------------------------
// Direct actions — a person's own click in the app, never a proposal
// ---------------------------------------------------------------------------

/**
 * Actions only a person's own click can run (index.js perform()).
 *
 * Added on the owner's instruction 2026-10-14: ticking a chore on the
 * companion's Family page marks it done in Family Chores, and the snackbar's
 * Undo takes it back. The owner chose "the click is the approval, through the
 * action layer": each tick is one athena_action row, normalized, access-checked
 * and audited exactly like an approved proposal, recorded as approval "human".
 *
 * Kept out of ACTIONS on purpose. Everything that builds Athena's prompt and
 * reply schema reads ACTIONS (availableFor, promptBlock, paramsSchema, the
 * proposed_action id enum), so these are never offered to the model, never
 * proposable from chat, and attempt() refuses one by name. They are never
 * standing either — a click is the approval every time. Letting Athena propose
 * a chore completion in chat would be a separate, owner-approved change (it
 * would also need chore ids in her chat context, which she doesn't have).
 *
 * Which chore is meant is never taken on trust: normalize() finds the id on
 * the person's OWN linked player's list, as Family Chores reports it now, and
 * takes the title from there. The player is always the linked one, never a
 * request field.
 */
const CHORE_ID = /^[A-Za-z0-9_-]{1,128}$/;

async function choreLink(profileId) {
	// Lazy: integration.js pulls in half the services, some of which read this file.
	const integration = require("../integration");
	const creds = await integration.getUsableCredentials(profileId);
	if (!creds?.playerId) throw invalid("Family Chores isn't connected");
	return { integration, creds, opts: { token: creds.token, baseUrl: creds.baseUrl } };
}

/** The chore on the person's own list, in the state this action needs, or a refusal. */
async function findOwnChore(profileId, raw, status) {
	const id = str(raw.chore_id, 128);
	if (!id || !CHORE_ID.test(id)) throw invalid("A chore id is required");
	const { creds, opts } = await choreLink(profileId);
	// Open: due any time (overdue ones are on the list too). Completed: today,
	// which is what the Family page lists and what Undo is for.
	const list = await familyChores.getChores(
		creds.playerId,
		status === "open" ? { range: "all", status: "open", includeRecurring: false } : { range: "today", status: "completed", includeRecurring: false },
		opts
	);
	const chore = list.find((c) => c && String(c.id) === id);
	if (!chore) {
		throw invalid(status === "open" ? "That chore isn't open on your list" : "That chore wasn't completed today");
	}
	return { chore_id: id, chore_title: str(chore.title, 160) || "Untitled chore" };
}

/** A Family Chores refusal, worded for the person; the API's own message when it has one. */
function choreWriteError(err) {
	// 401: the token was revoked. 403 naming a scope: a read-only token from
	// before write:chores existed. Either way the fix is reconnecting; any other
	// 403 (a role Family Chores refuses) keeps its own message.
	if (err?.status === 401 || (err?.status === 403 && /scope/i.test(err.message || ""))) {
		return Object.assign(new Error("Family Chores needs to be reconnected to allow marking chores done"), {
			status: 403,
			code: "family_chores_reconnect",
		});
	}
	return err;
}

const DIRECT_ACTIONS = [
	{
		id: "complete_chore",
		label: "Mark a chore done",
		provider: null,
		consentType: "action_authority",
		reversible: true,
		standing: false,
		direct: true,
		describe: "Mark one of their own Family Chores chores done (the Family page checkbox).",
		params: { chore_id: "The Family Chores chore id." },
		sameAs: false,
		async availableTo(profileId) {
			const integration = require("../integration");
			return integration.canWriteChores(profileId);
		},
		async normalize(raw = {}, ctx = {}) {
			return findOwnChore(ctx.profileId, raw, "open");
		},
		summarize(p) {
			return `Mark "${p.chore_title}" done in Family Chores`.slice(0, 500);
		},
		async execute(profileId, params) {
			const { creds, opts } = await choreLink(profileId);
			try {
				const result = await familyChores.completeChore(creds.playerId, params.chore_id, opts);
				return { ref: params.chore_id, detail: result?.status ? `Now ${result.status}` : null };
			} catch (err) {
				throw choreWriteError(err);
			}
		},
	},
	{
		id: "undo_complete_chore",
		label: "Undo a chore",
		provider: null,
		consentType: "action_authority",
		reversible: true,
		standing: false,
		direct: true,
		describe: "Undo marking one of their own Family Chores chores done (the Family page snackbar's Undo).",
		params: { chore_id: "The Family Chores chore id." },
		sameAs: false,
		async availableTo(profileId) {
			const integration = require("../integration");
			return integration.canWriteChores(profileId);
		},
		async normalize(raw = {}, ctx = {}) {
			return findOwnChore(ctx.profileId, raw, "completed");
		},
		summarize(p) {
			return `Undo "${p.chore_title}" in Family Chores`.slice(0, 500);
		},
		async execute(profileId, params) {
			const { creds, opts } = await choreLink(profileId);
			try {
				const result = await familyChores.undoCompleteChore(creds.playerId, params.chore_id, opts);
				return { ref: params.chore_id, detail: result?.status ? `Now ${result.status}` : null };
			} catch (err) {
				throw choreWriteError(err);
			}
		},
	},
];

const BY_ID = new Map([...ACTIONS, ...DIRECT_ACTIONS].map((a) => [a.id, a]));

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
	operation: { type: "string", enum: ["add", "bought"] },
	grocery_items: { type: "array", items: { type: "string" } },
	all_day: { type: "boolean" },
	// Closed sets, so the model picks a real value instead of inventing one
	// ("companion-dashboard"). normalize() still checks; this only stops waste.
	repo: { type: "string", enum: Object.keys(codeAgents.REPOS) },
	agent: { type: "string", enum: ["claude", "codex"] },
	within_hours: { type: "number" },
	heat_to: { type: "number" },
	cool_to: { type: "number" },
	mode: { type: "string", enum: ["HEAT", "COOL", "HEATCOOL", "OFF"] },
	unit: { type: "string", enum: ["F", "C"] },
	eco: { type: "string", enum: ["on", "off"] },
	check_in_hours: { type: "number" },
	project_priority: { type: "number" },
	feeling_better: { type: "boolean" },
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
/**
 * One order for every param name that agrees with every action's OWN order.
 *
 * Gemini's structured output writes object fields in a fixed order —
 * alphabetical unless told otherwise — and once it has written a field it
 * cannot go back for an earlier one. With every action's params flattened
 * into one object, that cost real proposals (found in production 2026-10-11):
 * fix_code started at `repo` and, unable to return to `change`, put the
 * change in `value`; remind_at_time put its time in `value` for the same
 * reason. A plain registry order fixed those but broke remind_at_place, whose
 * `reminder` comes after its place fields. So: a topological order over each
 * action's declared sequence, ties broken by first appearance. Should two
 * actions ever declare contradictory orders, the rest fall back to first
 * appearance rather than failing.
 */
function paramOrder() {
	const first = [];
	const after = new Map(); // name -> names that must come later
	const before = new Map(); // name -> count of names that must come earlier
	for (const action of ACTIONS) {
		const own = Object.keys(action.params || {});
		for (const name of own) {
			if (!after.has(name)) {
				first.push(name);
				after.set(name, new Set());
				before.set(name, 0);
			}
		}
		for (let i = 1; i < own.length; i++) {
			const edges = after.get(own[i - 1]);
			if (!edges.has(own[i])) {
				edges.add(own[i]);
				before.set(own[i], before.get(own[i]) + 1);
			}
		}
	}
	const order = [];
	const ready = first.filter((n) => before.get(n) === 0);
	while (ready.length) {
		ready.sort((a, b) => first.indexOf(a) - first.indexOf(b));
		const name = ready.shift();
		order.push(name);
		for (const next of after.get(name)) {
			before.set(next, before.get(next) - 1);
			if (before.get(next) === 0) ready.push(next);
		}
	}
	return [...order, ...first.filter((n) => !order.includes(n))];
}

function paramsSchema() {
	const order = paramOrder();
	const properties = {};
	for (const name of order) properties[name] = PARAM_TYPES[name] || { type: "string" };
	// Gemini-only keyword (openaiCompat strips it for strict mode).
	return { type: "object", properties, propertyOrdering: order };
}

/** The descriptor, or null. Callers must treat null as "refuse", not "allow". */
function get(id) {
	return (typeof id === "string" && BY_ID.get(id)) || null;
}

module.exports = { ACTIONS, DIRECT_ACTIONS, get, invalid, paramsSchema };
