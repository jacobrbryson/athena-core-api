/**
 * PulsePoint's incident shape -> ours.
 *
 * One file, so that the day their schema shifts there is exactly one place to
 * look. Everything downstream — the radius check, the alert, the dashboard —
 * sees only what comes out of here.
 *
 * ## Two things about their data that drive this whole design
 *
 * **Coordinates arrive as strings.** `"35.5826600000"`, not `35.58266`. They
 * are parsed here, once, so no other file has to remember.
 *
 * **Medical calls have their coordinates redacted to 0,0**, with the street
 * address truncated to a road name. That is PulsePoint protecting the person
 * having the emergency, and it is right. Measured against a live sample of 115
 * incidents, the split is total and clean:
 *
 *   alertable calls   15 with real coordinates,  0 redacted
 *   routine calls     22 with real coordinates, 68 redacted (all medical)
 *
 * So a redacted incident can never be placed on a map, and never needs to be:
 * the calls we would interrupt someone for all carry real coordinates, and the
 * calls that do not are the ones nobody should be able to locate anyway. We
 * keep them, we show them, we simply cannot say how far away they are — and
 * `locatable` is how a caller asks, rather than every caller re-discovering
 * that 0,0 is a sentinel.
 */
const {
	describe: describeCallType,
	isAlertable,
	lookup,
} = require("./calltypes");

/** "35.5826600000" -> 35.58266, and their 0,0 redaction sentinel -> null. */
function coordinate(value) {
	if (value === null || value === undefined) return null;
	const number =
		typeof value === "number" ? value : Number.parseFloat(String(value));
	if (!Number.isFinite(number)) return null;
	if (number === 0) return null; // the redaction sentinel, not the Atlantic
	return number;
}

/** Their timestamps are ISO-8601 in Z. Anything unparseable becomes null. */
function when(value) {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** How many units are rolling — the fastest read on how serious it is. */
function unitCount(incident) {
	return Array.isArray(incident.Unit) ? incident.Unit.length : 0;
}

/**
 * One incident, in our terms.
 *
 * `status` is which bucket it came from — active calls are happening now,
 * recent ones are closed. The caller decides what that is worth; this only
 * records it.
 */
function incident(raw, status = "active") {
	if (!raw || typeof raw !== "object") return null;
	const code = raw.PulsePointIncidentCallType || null;
	const latitude = coordinate(raw.Latitude);
	const longitude = coordinate(raw.Longitude);
	const entry = lookup(code);

	return {
		id: raw.ID ? String(raw.ID) : null,
		agencyId: raw.AgencyID ? String(raw.AgencyID) : null,
		status,
		code,
		what: describeCallType(code),
		category: entry ? entry.category : null,
		alertable: isAlertable(code),
		known: Boolean(entry),
		latitude,
		longitude,
		/** False when PulsePoint redacted the position — see the note above. */
		locatable: latitude !== null && longitude !== null,
		address:
			raw.FullDisplayAddress || raw.MedicalEmergencyDisplayAddress || null,
		addressTruncated: String(raw.AddressTruncated) === "1",
		receivedAt: when(raw.CallReceivedDateTime),
		closedAt: when(raw.ClosedDateTime),
		units: unitCount(raw),
	};
}

/**
 * The whole payload -> a flat list, active first.
 *
 * `alerts` is their third bucket; it is folded in as active because an agency
 * putting something there has decided it is the most important thing on the
 * board.
 */
function incidents(payload) {
	const buckets = (payload && payload.incidents) || {};
	const out = [];
	for (const [key, status] of [
		["alerts", "active"],
		["active", "active"],
		["recent", "recent"],
	]) {
		const list = Array.isArray(buckets[key]) ? buckets[key] : [];
		for (const raw of list) {
			const parsed = incident(raw, status);
			if (parsed && parsed.id) out.push(parsed);
		}
	}
	// One id can appear in two buckets as a call closes mid-fetch; first wins,
	// and because active is read first, the live view wins over the closed one.
	const seen = new Set();
	return out.filter((i) => (seen.has(i.id) ? false : seen.add(i.id)));
}

module.exports = { incidents, incident, coordinate, when };
