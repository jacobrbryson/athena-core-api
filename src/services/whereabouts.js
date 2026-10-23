/**
 * "Where am I?" / "Where's my phone?"
 *
 * Asks the paired phone for a fresh position (the same silent request the
 * distance lookup uses — travel.currentFix, only when location sharing is on)
 * and turns the bare coordinate into something she can say:
 *
 *   - Home, or one of their Community points of interest, when it is inside
 *     that place's circle.
 *   - Otherwise the nearest named place from Google Places (searchNearby,
 *     the same Maps key and the same Places API as the distance lookup).
 *   - What is on their calendar right now, and whether its location is where
 *     the phone is — so "it looks like you're at Skylar's softball game" comes
 *     from an event whose address actually matched, not from a guess.
 *
 * When the phone doesn't answer, the last position it sent (inside the
 * location-context retention, which services/location enforces) is offered
 * as "last seen", clearly aged, because for "where's my phone?" that is the
 * useful answer.
 *
 * Nothing is stored here. Adults only, never throws.
 */
const pool = require("../helpers/db");
const secrets = require("./secrets");
const travel = require("./travel");
const googleCalendar = require("./connectors/googleCalendar");
const watch = require("./pulsepoint/watch");
const geo = require("./pulsepoint/geo");

const ASK = [
	// End-anchored: "where am I on the leaderboard" is not a location question.
	/\bwhere (?:am i|are we)(?: (?:right )?now| at| exactly)?\s*[?.!]*\s*$/i,
	/\bwhere(?:'s| is) my (?:phone|cell|device)\b/i,
	/\bfind my phone\b/i,
	/\bwhat(?:'s| is) my (?:current )?location\b/i,
	/\bwhere (?:did i|have i) (?:leave|left|put) my phone\b/i,
];

/** True when the message asks where they (or their phone) are right now. */
function matches(message) {
	return typeof message === "string" && message.length <= 200 && ASK.some((pattern) => pattern.test(message));
}

/** Inside a saved place's own circle, but never wider than this. */
const PLACE_MAX_MILES = 0.25;
/** An event's address within this of the phone counts as "there". */
const EVENT_NEAR_MILES = 0.4;
/** An event counts as "now" from this long before it starts to this long after it ends. */
const EVENT_EARLY_MS = 30 * 60 * 1000;
const EVENT_LATE_MS = 30 * 60 * 1000;
/** At most this many event addresses are looked up per question. */
const EVENT_LOOKUPS = 3;
const NEARBY_RADIUS_M = 150;
/** Faster than this the phone is in a car, not at the place it's passing. */
const MOVING_MPS = 6;

const HEADER = "# Where their phone is (just asked it)";

/** The newest position the phone ever sent that's still kept, with its age. */
async function lastSeen(profileId) {
	const [rows] = await pool.query(
		`SELECT latitude, longitude, accuracy_m, TIMESTAMPDIFF(MINUTE, observed_at, NOW()) AS age_min
		 FROM athena_location_sample WHERE profile_id = ?
		 ORDER BY observed_at DESC LIMIT 1`,
		[profileId]
	);
	const row = rows[0];
	if (!row) return null;
	const point = {
		latitude: Number(row.latitude),
		longitude: Number(row.longitude),
		ageMinutes: Math.max(0, Number(row.age_min) || 0),
	};
	if (row.accuracy_m != null) point.accuracyMeters = Number(row.accuracy_m);
	return geo.isPoint(point) ? point : null;
}

/** Their saved place this point is inside (home first, then nearest), or null. */
function savedPlaceAt(point, places) {
	let best = null;
	for (const place of places) {
		const miles = geo.milesBetween(point, place);
		if (miles == null) continue;
		const radius = Math.min(Number(place.radiusMiles) || PLACE_MAX_MILES, PLACE_MAX_MILES);
		if (miles > radius) continue;
		if (!best || (place.kind === "home") > (best.place.kind === "home") || miles < best.miles) {
			best = { place, miles };
		}
	}
	return best;
}

/** The nearest named place Google knows of, or null. */
async function nearestPlace(apiKey, point) {
	const json = await travel.mapsPost(
		"https://places.googleapis.com/v1/places:searchNearby",
		apiKey,
		"places.displayName,places.formattedAddress,places.location,places.primaryTypeDisplayName",
		{
			locationRestriction: {
				circle: { center: { latitude: point.latitude, longitude: point.longitude }, radius: NEARBY_RADIUS_M },
			},
			maxResultCount: 3,
			rankPreference: "DISTANCE",
			languageCode: "en",
		}
	);
	const found = (json.places || []).find((p) => p.displayName?.text);
	if (!found) return null;
	return {
		name: found.displayName.text,
		address: found.formattedAddress || null,
		kind: found.primaryTypeDisplayName?.text || null,
		miles: geo.milesBetween(point, found.location || {}),
	};
}

function timeIn(value, timeZone) {
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(value));
	} catch {
		return new Date(value).toISOString().slice(11, 16);
	}
}

/**
 * Calendar events happening about now, each with whether its location is
 * where the phone is: { events: [{ title, when, location, calendar, here }] }.
 * `connected: false` when Google Calendar isn't linked.
 */
async function eventsNow(profileId, point, now = Date.now()) {
	let read;
	try {
		read = await googleCalendar.collectEvents(profileId, { days: 1 });
	} catch (err) {
		if (err && err.code === "not_connected") return { connected: false, events: [] };
		throw err;
	}
	const timeZone = googleCalendar.displayTimeZone(read.calendars);
	const current = read.events.filter((e) => {
		if (e.allDay) return !!e.location; // an all-day tournament only counts if its place matches
		const start = new Date(e.start).getTime();
		const end = new Date(e.end || e.start).getTime();
		return start - EVENT_EARLY_MS <= now && now <= end + EVENT_LATE_MS;
	});
	let lookups = 0;
	const events = [];
	for (const e of current) {
		let here = null;
		if (e.location && point && lookups < EVENT_LOOKUPS) {
			lookups += 1;
			const place = await travel.locate(profileId, e.location);
			const miles = place ? geo.milesBetween(point, place) : null;
			here = miles == null ? null : miles <= EVENT_NEAR_MILES;
		}
		if (e.allDay && here !== true) continue;
		events.push({
			title: e.title,
			when: e.allDay ? "all day" : `${timeIn(e.start, timeZone)}–${timeIn(e.end || e.start, timeZone)}`,
			location: e.location,
			calendar: e.shared ? e.calendar : null,
			here,
		});
	}
	return { connected: true, events };
}

function ago(minutes) {
	if (minutes < 2) return "just now";
	if (minutes < 90) return `${minutes} minutes ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 36) return `about ${hours} hours ago`;
	return `about ${Math.round(hours / 24)} days ago`;
}

function eventLine(e) {
	const where = e.location ? ` at ${e.location}` : "";
	const whose = e.calendar ? ` (on the ${e.calendar} calendar)` : "";
	const match =
		e.here === true ? " — its location matches where the phone is"
			: e.here === false ? " — its location is NOT where the phone is"
				: e.location ? " — couldn't check its location" : " — no location on the event";
	return `- ${e.title}, ${e.when}${where}${whose}${match}`;
}

/**
 * Grounding for "where am I?" / "where's my phone?". Null when the message is
 * neither or the person isn't an adult. Never throws.
 */
async function buildContext(profileId, message, { audience, force = false, fix = travel.currentFix, now = Date.now() } = {}) {
	// `force`: the fast guess (services/toolIntent) heard a location question
	// the patterns above missed — "what town is this?". Still adults only.
	if (!profileId || audience !== "adult" || !(force || matches(message))) return null;
	try {
		const fresh = await fix(profileId).catch(() => null);
		const point = fresh || (await lastSeen(profileId).catch(() => null));
		if (!point) {
			return [
				HEADER,
				"",
				"- Their phone didn't send a position, and there is no earlier one kept. Either location context is off (⋯ menu → Initiative → location context), Android location or Athena's location permission is off, or the phone is offline.",
				"",
				"Say you couldn't get a location from their phone and what would fix it. Don't guess where they are.",
			].join("\n");
		}

		const lines = [HEADER, ""];
		if (fresh) lines.push("- The phone answered just now.");
		else lines.push(`- The phone didn't answer. The last position it sent was ${ago(point.ageMinutes)} — this is where it was, not necessarily where it is.`);
		if (point.accuracyMeters) lines.push(`- Accurate to about ${Math.round(point.accuracyMeters * 3.28084)} feet.`);
		if (fresh && point.speedMps >= MOVING_MPS) {
			lines.push(`- It's moving at about ${Math.round(point.speedMps * 2.23694)} mph — they're probably driving or riding, not at the place below.`);
		}

		const places = await watch.listPlaces(profileId).catch(() => []);
		const saved = savedPlaceAt(point, places.filter((p) => geo.isPoint(p)));
		const apiKey = await secrets.getSecret("GOOGLE_MAPS_API_KEY").catch(() => null);
		const [nearby, calendar] = await Promise.all([
			!saved && apiKey ? nearestPlace(apiKey, point).catch(() => null) : null,
			eventsNow(profileId, point, now).catch((err) => {
				console.warn("[whereabouts] calendar read failed:", err.message);
				return { connected: true, failed: true, events: [] };
			}),
		]);

		if (saved) {
			const p = saved.place;
			lines.push(p.kind === "home" ? `- At home (${p.name}).` : `- At ${p.name}, one of their saved places${p.address ? ` (${p.address})` : ""}.`);
		} else if (nearby) {
			const dist = nearby.miles != null && nearby.miles > 0.03 ? `, about ${Math.round(nearby.miles * 5280)} feet away` : "";
			lines.push(`- Nearest named place: ${nearby.name}${nearby.kind ? ` (${nearby.kind})` : ""}${nearby.address ? `, ${nearby.address}` : ""}${dist}.`);
		} else {
			lines.push(`- No named place found right there${apiKey ? "" : " (the map lookup isn't set up)"}.`);
		}
		const home = places.find((p) => p.kind === "home" && geo.isPoint(p));
		const fromHome = home && (!saved || saved.place.kind !== "home") ? geo.milesBetween(point, home) : null;
		if (fromHome != null) lines.push(`- About ${fromHome < 10 ? fromHome.toFixed(1) : Math.round(fromHome)} miles from home in a straight line.`);
		lines.push(`- Map: https://www.google.com/maps/search/?api=1&query=${point.latitude},${point.longitude}`);

		if (!calendar.connected) {
			lines.push("- Google Calendar isn't linked, so there's no schedule to compare with.");
		} else if (calendar.failed) {
			lines.push("- The calendar couldn't be read just now.");
		} else if (calendar.events.length) {
			lines.push("", "On their calendar about now:", ...calendar.events.map(eventLine));
		} else {
			lines.push("- Nothing on their calendar right now.");
		}

		const matched = calendar.events.find((e) => e.here === true);
		lines.push(
			"",
			"Answer in a sentence or two, the way a friend would: the place, not coordinates. Offer the map link only if they want it.",
			matched
				? `The calendar and the phone agree, so you can say it looks like they're at "${matched.title}" — say "looks like", not "you are" — and, if it fits, ask one natural question about it (a game: how it's going or the score; a meeting or appointment: nothing, just confirm).`
				: "Only connect them to a calendar event whose location matches; don't infer an event from the place alone.",
			fresh ? "" : "Make clear this is where the phone last reported, and how long ago."
		);
		return lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n").trim();
	} catch (err) {
		console.warn("[whereabouts] lookup failed:", err.message);
		return `${HEADER}\n\nThe location lookup failed just now (${err.message}). Say you couldn't find out; don't guess.`;
	}
}

module.exports = { matches, buildContext, savedPlaceAt, eventsNow };
