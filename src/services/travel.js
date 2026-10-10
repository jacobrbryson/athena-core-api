/**
 * "How far away is Statesville Soccer Complex?"
 *
 * A real driving distance and time, from home or from where their phone is
 * right now, as grounding for the reply — the same shape as a connector read.
 * Before this she answered from memory, which for a local soccer complex
 * means not at all.
 *
 * Two Google Maps Platform calls, both keyed by GOOGLE_MAPS_API_KEY (Secret
 * Manager, read at runtime like every other app-level secret):
 *
 *   - Places Text Search finds the destination by name, biased toward home,
 *     because "the soccer complex" means the one near them.
 *   - Routes computes the drive, traffic-aware, from each origin.
 *
 * ## Which "from"
 *
 * Home is the Community page's point of interest of kind "home". Their
 * current position is asked of the paired phone at the moment of the question
 * (push.requestLocation — a silent message, only when location sharing is on)
 * and waited for briefly. When both exist and are more than a little apart
 * the block asks her to check which they mean before giving a number; the
 * answer to that ("from here") is a follow-up this module recognises for a few
 * minutes, with both routes already computed so it costs nothing.
 *
 * Nothing here is stored: the routes live in process memory for the follow-up
 * and the phone's sample is kept (or refused) by services/location under its
 * own consent and retention.
 *
 * Adults only, never throws — a failure is a block that says the lookup didn't
 * work, so she says so rather than guessing a number.
 */
const pool = require("../helpers/db");
const secrets = require("./secrets");
const push = require("./push");
const watch = require("./pulsepoint/watch");
const geo = require("./pulsepoint/geo");

const TIMEOUT_MS = 6000;
/** How long to wait for the phone to answer with its position. */
const FIX_WAIT_MS = 9000;
const FIX_POLL_MS = 750;
/** A fix older than this is where they were, not where they are. */
const FIX_FRESH_S = 10 * 60;
/** Closer than this to home, "from here" and "from home" are the same answer. */
const SAME_PLACE_MILES = 0.5;
/** How long "from here" / "from home" still answers the last question. */
const PENDING_MS = 15 * 60 * 1000;
const PENDING_MAX = 200;
const BIAS_RADIUS_M = 50000;

const pending = new Map(); // profileId -> { destination, place, home, here, at }

const ASK = [
	// "How far", not "how long": "how long is the movie" is not a drive.
	/\bhow far(?: away)? (?:is it )?(?:is|to|from|am i from|are we from)\b/i,
	/\bhow long (?:does it|would it|will it) take (?:me |us )?to (?:get|drive) to\b/i,
	/\bhow long (?:of a )?drive (?:is it )?to\b/i,
	/\b(?:driving )?distance (?:to|from)\b/i,
	/\b(?:drive|driving|travel) time (?:to|from)\b/i,
];

/** True when the message asks how far, or how long a drive, somewhere is. */
function matches(message) {
	return typeof message === "string" && ASK.some((pattern) => pattern.test(message));
}

const ORIGIN_HOME = /\bfrom (?:my |our |the )?(?:home|house|place)\b/i;
const ORIGIN_HERE = /\bfrom (?:here|where (?:i|we) am|where (?:i|we)'?re|my (?:current )?location|my phone|me)\b/i;

/** The origin they named in the question itself, if any: "home", "here" or null. */
function namedOrigin(message) {
	if (ORIGIN_HERE.test(message)) return "here";
	if (ORIGIN_HOME.test(message)) return "home";
	return null;
}

/**
 * "How far away is Statesville Soccer Complex?" -> "Statesville Soccer Complex".
 * Null when nothing destination-like is left.
 */
function destinationOf(message) {
	let text = String(message || "").replace(/\s+/g, " ").trim();
	text = text
		.replace(/^.*?\bhow long (?:does it|would it|will it) take (?:me |us )?to (?:get|drive) to\b/i, "")
		.replace(/^.*?\bhow long (?:of a )?drive (?:is it )?to\b/i, "")
		.replace(/^.*?\b(?:driving )?distance (?:from (?:here|home) )?to\b/i, "")
		.replace(/^.*?\b(?:drive|driving|travel) time (?:from (?:here|home) )?to\b/i, "")
		.replace(/^.*?\bhow far(?: away)? (?:is it )?(?:from (?:here|home) )?(?:is|to|am i from|are we from)\b/i, "");
	text = text
		.replace(ORIGIN_HOME, "")
		.replace(ORIGIN_HERE, "")
		.replace(/\b(?:away|from here|by car|driving|right now|today)\b/gi, "")
		.replace(/\b(?:the drive )?to\s*$/i, "")
		.replace(/[?.!,]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (/^(?:it|that|there|this)$/i.test(text)) return null;
	return text.length >= 2 ? text.slice(0, 120) : null;
}

const FOLLOW_UP_HOME = /\b(?:home|house|my place)\b/i;
const FOLLOW_UP_HERE = /\b(?:here|current(?:ly)?|where (?:i|we) am|where (?:i|we)'?re|right now|my location|my phone|now)\b/i;
const FOLLOW_UP_BOTH = /\b(?:both|either|each)\b/i;

/**
 * Their answer to "from home or from where you are?", while the question is
 * still open: "home", "here", "both" or null.
 */
function followUpChoice(profileId, message) {
	const open = pending.get(profileId);
	if (!open || Date.now() - open.at > PENDING_MS) return null;
	if (typeof message !== "string" || message.length > 80) return null;
	if (FOLLOW_UP_BOTH.test(message)) return "both";
	const home = FOLLOW_UP_HOME.test(message);
	const here = FOLLOW_UP_HERE.test(message);
	if (home && here) return "both";
	return home ? "home" : here ? "here" : null;
}

function remember(profileId, value) {
	pending.delete(profileId);
	pending.set(profileId, { ...value, at: Date.now() });
	if (pending.size > PENDING_MAX) pending.delete(pending.keys().next().value);
}

async function post(url, apiKey, fieldMask, body) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Goog-Api-Key": apiKey,
				"X-Goog-FieldMask": fieldMask,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const json = await response.json().catch(() => null);
		if (!response.ok) {
			throw new Error(json?.error?.message || `Google Maps answered ${response.status}`);
		}
		return json || {};
	} finally {
		clearTimeout(timer);
	}
}

const latLng = (point) => ({ latitude: point.latitude, longitude: point.longitude });

/** The destination by name, near `near` when we know where near is. */
async function findPlace(apiKey, query, near) {
	const body = { textQuery: query, maxResultCount: 1, languageCode: "en", regionCode: "US" };
	if (near) body.locationBias = { circle: { center: latLng(near), radius: BIAS_RADIUS_M } };
	const json = await post(
		"https://places.googleapis.com/v1/places:searchText",
		apiKey,
		"places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri",
		body
	);
	const found = json.places?.[0];
	if (!found?.id) return null;
	return {
		id: found.id,
		name: found.displayName?.text || query,
		address: found.formattedAddress || null,
		latitude: found.location?.latitude,
		longitude: found.location?.longitude,
		mapsUrl: found.googleMapsUri || null,
	};
}

/** Drive from `origin` to the place: { miles, minutes, typicalMinutes } or null. */
async function drive(apiKey, origin, place) {
	const json = await post(
		"https://routes.googleapis.com/directions/v2:computeRoutes",
		apiKey,
		"routes.distanceMeters,routes.duration,routes.staticDuration",
		{
			origin: { location: { latLng: latLng(origin) } },
			destination: { placeId: place.id },
			travelMode: "DRIVE",
			routingPreference: "TRAFFIC_AWARE",
			units: "IMPERIAL",
		}
	);
	const route = json.routes?.[0];
	if (!route?.distanceMeters) return null;
	const seconds = (value) => Number(String(value || "").replace(/s$/, "")) || null;
	return {
		miles: Math.round((route.distanceMeters / 1609.344) * 10) / 10,
		minutes: seconds(route.duration) ? Math.round(seconds(route.duration) / 60) : null,
		typicalMinutes: seconds(route.staticDuration) ? Math.round(seconds(route.staticDuration) / 60) : null,
	};
}

/** Home from the Community page, or null. */
async function homeOf(profileId) {
	const places = await watch.listPlaces(profileId).catch(() => []);
	const home = places.find((p) => p.kind === "home" && geo.isPoint(p));
	return home ? { name: home.name, latitude: home.latitude, longitude: home.longitude } : null;
}

/** The newest sample the phone sent within the last `sinceSeconds`, if it is fresh. */
async function latestFix(profileId, sinceSeconds) {
	const [rows] = await pool.query(
		`SELECT latitude, longitude FROM athena_location_sample
		 WHERE profile_id = ? AND received_at >= NOW() - INTERVAL ? SECOND
		   AND observed_at >= NOW() - INTERVAL ? SECOND
		 ORDER BY observed_at DESC LIMIT 1`,
		[profileId, sinceSeconds, FIX_FRESH_S]
	);
	const row = rows[0];
	if (!row) return null;
	const point = { latitude: Number(row.latitude), longitude: Number(row.longitude) };
	return geo.isPoint(point) ? point : null;
}

/**
 * Where their phone is now: asks it, then waits a few seconds for the sample.
 * Null when location sharing is off, no phone answers, or it takes too long.
 */
async function currentFix(profileId, { wait = FIX_WAIT_MS, sleep } = {}) {
	const started = Date.now();
	const { asked } = await push.requestLocation(profileId);
	if (!asked) return null;
	const pause = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	while (Date.now() - started < wait) {
		await pause(FIX_POLL_MS);
		// Only a sample that arrived since we asked: an older one is the last
		// PulsePoint call or geofence, which could be anywhere.
		const since = Math.ceil((Date.now() - started) / 1000) + 2;
		const fix = await latestFix(profileId, since).catch(() => null);
		if (fix) return fix;
	}
	return null;
}

function describe(result) {
	if (!result) return "couldn't work out a driving route";
	const time = result.minutes ? `about ${result.minutes} min by car right now` : "drive time unknown";
	const usual =
		result.typicalMinutes && result.minutes && Math.abs(result.minutes - result.typicalMinutes) >= 5
			? ` (usually ${result.typicalMinutes} min without traffic)`
			: "";
	return `${result.miles} miles, ${time}${usual}`;
}

function placeLines(place) {
	// Google often leads the address with the place's own name; say it once.
	const address = place.address && place.address.startsWith(`${place.name}, `)
		? place.address.slice(place.name.length + 2)
		: place.address;
	return [
		`- Destination: ${place.name}${address ? `, ${address}` : ""}`,
		...(place.mapsUrl ? [`- Google Maps: ${place.mapsUrl}`] : []),
	];
}

const HEADER = "# Driving distance (Google Maps, just looked up)";

function answerBlock(open, choice) {
	const lines = [HEADER, "", ...placeLines(open.place)];
	if ((choice === "home" || choice === "both") && open.home) lines.push(`- From home: ${describe(open.home)}`);
	if ((choice === "here" || choice === "both") && open.here) lines.push(`- From where their phone is now: ${describe(open.here)}`);
	if (choice === "here" && !open.here) {
		lines.push("- Their phone didn't send a current position, so you only have the drive from home:", `- From home: ${describe(open.home)}`);
	}
	if (choice === "home" && !open.home) {
		lines.push("- No home is saved on the Community page, so you only have the drive from where they are:", `- From where their phone is now: ${describe(open.here)}`);
	}
	lines.push(
		"",
		"Answer with these numbers, saying which starting point you mean. Round naturally in speech (\"about 20 minutes, 14 miles\"). Don't invent a different route or time."
	);
	return lines.join("\n");
}

/**
 * Grounding for a distance question, or for the answer to "from home or from
 * here?". Null when the message is neither. Never throws.
 */
async function buildContext(profileId, message, { audience, fix = currentFix } = {}) {
	if (!profileId || audience !== "adult") return null;
	try {
		const choice = followUpChoice(profileId, message);
		if (choice && !matches(message)) {
			const open = pending.get(profileId);
			pending.delete(profileId);
			return answerBlock(open, choice);
		}
		if (!matches(message)) return null;

		const destination = destinationOf(message);
		if (!destination) return null;
		const apiKey = await secrets.getSecret("GOOGLE_MAPS_API_KEY").catch(() => null);
		if (!apiKey) {
			return `${HEADER}\n\nThe map lookup isn't set up yet (no Google Maps key), so you can't give a real distance to ${destination}. Say so plainly; don't estimate.`;
		}

		const named = namedOrigin(message);
		const home = named === "here" ? null : await homeOf(profileId);
		// Ask the phone straight away; the place lookup runs while it answers.
		const herePromise = named === "home" && home ? Promise.resolve(null) : fix(profileId).catch(() => null);
		const place = await findPlace(apiKey, destination, home);
		if (!place) {
			return `${HEADER}\n\nGoogle Maps found no place matching "${destination}". Ask them for the town or address rather than guessing.`;
		}
		const here = await herePromise;
		const [fromHome, fromHere] = await Promise.all([
			home ? drive(apiKey, home, place).catch(() => null) : null,
			here ? drive(apiKey, here, place).catch(() => null) : null,
		]);
		const open = { destination, place, home: home ? fromHome : null, here: here ? fromHere : null };

		const apart = home && here && geo.milesBetween(home, here) > SAME_PLACE_MILES;
		if (!named && apart && open.home && open.here) {
			remember(profileId, open);
			return [
				HEADER,
				"",
				...placeLines(place),
				"- You have the drive both from home and from where their phone is now, and those are different places.",
				"",
				"Before giving any number, ask which they mean, in a few words: \"From home, or from where you are now?\" Don't give either number yet. Their next answer will bring the right one back to you.",
			].join("\n");
		}

		if (!open.home && !open.here) {
			const missing = [
				home ? "Google Maps couldn't route from home" : "no home saved on the Community page",
				here ? "Google Maps couldn't route from where they are" : "no current position from their phone (location sharing off, or the phone didn't answer)",
			].filter(Boolean);
			return [
				HEADER,
				"",
				...placeLines(place),
				`- No starting point to measure from: ${missing.join("; ")}.`,
				"",
				"Say you found the place but have nothing to measure from, and say what would fix it (saving Home on the Community page, or turning on location sharing). Don't estimate a distance.",
			].join("\n");
		}
		const pick = named === "here" ? "here" : named === "home" ? "home" : open.here && !open.home ? "here" : "home";
		return answerBlock(open, pick);
	} catch (err) {
		console.warn("[travel] lookup failed:", err.message);
		return `${HEADER}\n\nThe map lookup failed just now (${err.message}). Say you couldn't look it up; don't estimate a distance.`;
	}
}

function reset() {
	pending.clear();
}

module.exports = { matches, destinationOf, namedOrigin, followUpChoice, buildContext, currentFix, reset };
