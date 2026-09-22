/**
 * PulsePoint's own notifications, read off the owner's phone.
 *
 * PulsePoint blocked automated readers from their feed on 2026-09-22, and that
 * decision stands. What they do still offer any member of the public is their
 * app, PulsePoint Respond (`mobi.firedepartment`), which pushes notifications
 * for the incident types you choose across a whole agency — all of Iredell
 * County, in this case.
 *
 * So the phone forwards those notifications here, and this turns them back
 * into "is that near one of my places". Nothing is circumvented: these are the
 * owner's own notifications, on the owner's own phone, forwarded with
 * notification access they granted and can revoke in Android settings.
 *
 * ## What it can and cannot know
 *
 * A notification is a line of text, not a dispatch record. There is no incident
 * id, no coordinates and no "closed" event — so:
 *
 *   - the call type is recognised by matching PulsePoint's own call-type names
 *     (the 112 in calltypes.json) against the text;
 *   - the position comes from geocoding the address in the text, which is
 *     street-level at best;
 *   - and an alert EXPIRES on a timer (PHONE_ALERT_TTL_MS) rather than being
 *     cleared, because nothing will ever tell us it is over.
 *
 * Anything that cannot be recognised or placed is dropped rather than guessed
 * at. A wrong pin on an emergency map is worse than no pin.
 */
const { createHash } = require("node:crypto");
const { TABLE, lookup, isAlertable } = require("./calltypes");
const geocode = require("./geocode");

/** The app whose notifications this understands. */
const PULSEPOINT_PACKAGE = "mobi.firedepartment";

/** How long a phone-sourced call stays on the board. Nothing closes it. */
const PHONE_ALERT_TTL_MS = 3 * 60 * 60 * 1000;

/** Geocoding the same street twice in an hour helps nobody. */
const GEOCODE_CACHE_MS = 60 * 60 * 1000;
const geocoded = new Map(); // address -> { at, point }

/** Never news to a neighbour: someone's medical call, a drill, a unit move. */
const QUIET_CODES = new Set(["LA", "PS", "IFT", "CPR", "ME", "MCI", "TRNG", "STBY", "MOVE"]);
const QUIET_CATEGORIES = new Set(["Medical"]);

/** Longest names first: "Confirmed Structure Fire" must beat "Structure Fire". */
const CALL_TYPES = [...TABLE].sort((a, b) => b.description.length - a.description.length);

const clean = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

/**
 * Which call type this notification is about, by matching PulsePoint's own
 * names against the text. Returns the table entry, or null.
 */
function callTypeIn(text) {
	const haystack = text.toLowerCase();
	for (const entry of CALL_TYPES) {
		const name = entry.description.toLowerCase();
		const at = haystack.indexOf(name);
		if (at < 0) continue;
		// Whole words only: "Fire" inside "Firearm" is not a fire.
		const before = at === 0 ? " " : haystack[at - 1];
		const after = haystack[at + name.length] ?? " ";
		if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
		return entry;
	}
	return null;
}

/**
 * The address in the notification.
 *
 * Two shapes cover what dispatch text looks like: a street number with a name
 * ("101 Brer Fox Trl") and an intersection ("Shady Cove Rd & Perth Rd"). The
 * call type's own name is removed first so "Vehicle Fire" cannot be mistaken
 * for part of a street.
 */
function addressIn(text, callType) {
	let rest = text;
	if (callType) rest = rest.replace(new RegExp(callType.description, "i"), " ");
	// Whatever the app put before a dash — its own name, the agency's — is not
	// part of the address, so keep only the last dash-separated piece.
	rest = rest.split(/\s[-–—|:]\s/).pop() || rest;
	rest = clean(rest.replace(/^[\s\-–—:,|]+/, "").replace(/\bPulsePoint\b/gi, " "));

	// A town and state are kept when the text has them: "400 Main St,
	// Mooresville, NC" must not be geocoded as a Troutman address.
	const word = "[A-Za-z0-9'.-]+";
	const tail = "(?:,\\s*[A-Za-z .]{2,30}){0,2}(?:,?\\s*[A-Z]{2}\\b)?";
	const intersection = rest.match(
		new RegExp(`(${word}(?:\\s+${word}){0,4}\\s(?:&|and)\\s${word}(?:\\s+${word}){0,4}${tail})`)
	);
	if (intersection) return clean(intersection[1]);
	const numbered = rest.match(new RegExp(`(\\d{1,6}\\s+${word}(?:\\s+${word}){0,4}${tail})`));
	if (numbered) return clean(numbered[1]);
	return null;
}

/**
 * A notification -> what we can act on, or a reason we cannot.
 * `region` ("Troutman, NC") is appended when the text carries no town, which
 * dispatch notifications usually do not.
 */
function parse({ title, text, region }) {
	const whole = clean(`${clean(title)} ${clean(text)}`);
	if (!whole) return { ok: false, why: "empty" };
	const callType = callTypeIn(whole);
	if (!callType) return { ok: false, why: "no recognised call type", text: whole };
	// The same judgement the feed makes, plus the ones that are not emergencies
	// at all: a training exercise or a unit move is not news to a neighbour.
	if (QUIET_CODES.has(callType.id) || QUIET_CATEGORIES.has(callType.category)) {
		return { ok: false, why: "not worth telling", what: callType.description, text: whole };
	}
	const address = addressIn(whole, callType);
	if (!address) return { ok: false, why: "no address", what: callType.description, text: whole };
	const hasTown = /,\s*[A-Za-z .]+/.test(address) || /\b[A-Z]{2}\b/.test(address);
	return {
		ok: true,
		code: callType.id,
		what: callType.description,
		category: callType.category,
		serious: isAlertable(callType.id),
		address,
		query: hasTown || !region ? address : `${address}, ${region}`,
	};
}

/** Geocode, with a small cache. Null when the address cannot be placed. */
async function place(query) {
	const key = query.toLowerCase();
	const hit = geocoded.get(key);
	if (hit && Date.now() - hit.at < GEOCODE_CACHE_MS) return hit.point;
	let point = null;
	try {
		const matches = await geocode.lookup(query);
		point = matches[0] || null;
	} catch (error) {
		console.warn("[phone-alert] could not geocode:", error.message);
		return null;
	}
	geocoded.set(key, { at: Date.now(), point });
	return point;
}

/**
 * The same shape the 911 feed produces, so everything downstream — the
 * situation, the banner, the map, the chat block — treats it identically.
 * `via: "phone"` is what lets the carry-forward know to expire it.
 */
function incidentFrom(parsed, point, nearest, postedAt) {
	const at = postedAt ? new Date(postedAt) : new Date();
	return {
		id: `ph:${createHash("sha1").update(`${parsed.code}|${parsed.address.toLowerCase()}|${at.toISOString().slice(0, 13)}`).digest("hex").slice(0, 16)}`,
		what: parsed.what,
		category: parsed.category,
		where: parsed.address,
		miles: Math.round(nearest.miles * 10) / 10,
		place: nearest.place.live ? "you" : nearest.place.name,
		units: 0,
		receivedAt: at,
		serious: parsed.serious,
		latitude: Math.round(point.latitude * 1e5) / 1e5,
		longitude: Math.round(point.longitude * 1e5) / 1e5,
		via: "phone",
	};
}

/** Has this phone-sourced call been on the board long enough to drop? */
function expired(incident, now = Date.now()) {
	if (incident?.via !== "phone") return false;
	const at = incident.receivedAt ? new Date(incident.receivedAt).getTime() : 0;
	return !at || now - at > PHONE_ALERT_TTL_MS;
}

module.exports = {
	PULSEPOINT_PACKAGE,
	PHONE_ALERT_TTL_MS,
	parse,
	place,
	incidentFrom,
	expired,
	callTypeIn,
	addressIn,
	_resetCache: () => geocoded.clear(),
};
