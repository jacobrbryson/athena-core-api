/**
 * "Within three miles of me" — the arithmetic behind that sentence.
 *
 * Two things can be "me": a saved place (home, a parent's house, wherever you
 * asked me to keep an eye on) and wherever the phone currently is. Both are
 * just a point with a radius, so both go through the same function and the
 * only difference is where the point came from and how much it is trusted.
 *
 * Distances are great-circle, in miles, and that is accurate enough by a wide
 * margin: we are asking "is this fire closer than three miles", not surveying
 * a boundary. Over three miles the error from ignoring the ellipsoid is
 * measured in feet.
 *
 * Nothing here does I/O, which is why it is the part that can be tested
 * properly.
 */

const EARTH_RADIUS_MILES = 3958.7613;
const toRadians = (degrees) => (degrees * Math.PI) / 180;

/** A latitude/longitude that is actually on Earth and actually a number. */
function isPoint(point) {
	if (!point || typeof point !== "object") return false;
	const { latitude, longitude } = point;
	if (typeof latitude !== "number" || !Number.isFinite(latitude)) return false;
	if (typeof longitude !== "number" || !Number.isFinite(longitude))
		return false;
	if (latitude < -90 || latitude > 90) return false;
	if (longitude < -180 || longitude > 180) return false;
	// 0,0 is in the Gulf of Guinea. In practice it means "a field was empty
	// and something coerced it", and treating it as a real place puts every
	// incident on Earth thousands of miles away rather than flagging the bug.
	if (latitude === 0 && longitude === 0) return false;
	return true;
}

/**
 * Great-circle distance in miles, or null if either end is not a real point.
 *
 * Null rather than NaN or Infinity: a missing coordinate must never compare
 * as "closer than three miles" by accident, and null makes every caller say
 * out loud what it wants to do about not knowing.
 */
function milesBetween(a, b) {
	if (!isPoint(a) || !isPoint(b)) return null;
	const dLat = toRadians(b.latitude - a.latitude);
	const dLon = toRadians(b.longitude - a.longitude);
	const lat1 = toRadians(a.latitude);
	const lat2 = toRadians(b.latitude);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
	return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Which of the watched places is this incident near, and how near.
 *
 * Returns every match, nearest first, not just the closest one — a fire that
 * is near both your house and your mother's is a different sentence from one
 * that is only near yours, and the caller needs to be able to say so.
 *
 * A place with no radius of its own uses `defaultRadiusMiles`. A place whose
 * coordinates are missing is skipped rather than throwing: places are user
 * data, and one bad row must not stop the alerting for every other row.
 */
function placesNear(incident, places, defaultRadiusMiles = 3) {
	if (!isPoint(incident) || !Array.isArray(places)) return [];
	const matches = [];
	for (const place of places) {
		if (!isPoint(place)) continue;
		const radius =
			Number.isFinite(place.radiusMiles) && place.radiusMiles > 0
				? place.radiusMiles
				: defaultRadiusMiles;
		const miles = milesBetween(incident, place);
		if (miles === null || miles > radius) continue;
		matches.push({ place, miles, radiusMiles: radius });
	}
	return matches.sort((a, b) => a.miles - b.miles);
}

/**
 * "0.4 miles", "2 miles", "just under a mile" — a distance a person can
 * picture, given we are never more precise than the dispatch address anyway.
 */
function describeDistance(miles) {
	if (typeof miles !== "number" || !Number.isFinite(miles)) return "nearby";
	if (miles < 0.1) return "right here";
	if (miles < 1) return `${miles.toFixed(1)} miles`;
	if (miles < 10) return `${miles.toFixed(1)} miles`;
	return `${Math.round(miles)} miles`;
}

module.exports = {
	isPoint,
	milesBetween,
	placesNear,
	describeDistance,
	EARTH_RADIUS_MILES,
};
