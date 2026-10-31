/**
 * Bearings and heading-line intersection for scouting.
 *
 * A phone compass is good to roughly 10-20 degrees and drifts near metal, so
 * every result here is approximate and says so: an intersection carries the
 * angle between the two lines, and lines closer than MIN_CROSS_DEG to
 * parallel are refused - the error would be larger than the answer.
 */

const EARTH_M = 6371000;
const MIN_CROSS_DEG = 15;
// A typical phone main camera's horizontal field of view, held upright.
const PHONE_HFOV_DEG = 65;

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const norm = (d) => ((d % 360) + 360) % 360;

/** The bearing to something at horizontal position x (0 left edge .. 1 right edge) in a photo taken facing `heading`. */
function bearingInPhoto(heading, x, hfov = PHONE_HFOV_DEG) {
	if (!Number.isFinite(heading) || !Number.isFinite(x)) return null;
	const clamped = Math.min(1, Math.max(0, x));
	return norm(heading + (clamped - 0.5) * hfov);
}

/** Local flat-earth projection around a reference point; fine over a yard. */
function toXY(ref, p) {
	const x = rad(p.lng - ref.lng) * Math.cos(rad(ref.lat)) * EARTH_M;
	const y = rad(p.lat - ref.lat) * EARTH_M;
	return { x, y };
}

function fromXY(ref, { x, y }) {
	return { lat: ref.lat + deg(y / EARTH_M), lng: ref.lng + deg(x / (EARTH_M * Math.cos(rad(ref.lat)))) };
}

function distanceM(a, b) {
	const { x, y } = toXY(a, b);
	return Math.hypot(x, y);
}

/**
 * Where two heading lines cross: from point a along bearing ba, and from b
 * along bb (degrees clockwise from north). Returns { lat, lng, crossDeg,
 * distanceFromA } or null when the lines are near-parallel or cross behind
 * either observer.
 */
function intersect(a, ba, b, bb) {
	if (![a?.lat, a?.lng, b?.lat, b?.lng, ba, bb].every(Number.isFinite)) return null;
	const cross = Math.abs(((ba - bb + 540) % 360) - 180);
	const crossDeg = Math.min(cross, 180 - cross);
	if (crossDeg < MIN_CROSS_DEG) return null;
	const p = { x: 0, y: 0 };
	const q = toXY(a, b);
	const r = { x: Math.sin(rad(ba)), y: Math.cos(rad(ba)) };
	const s = { x: Math.sin(rad(bb)), y: Math.cos(rad(bb)) };
	const denom = r.x * s.y - r.y * s.x;
	if (Math.abs(denom) < 1e-9) return null;
	const t = ((q.x - p.x) * s.y - (q.y - p.y) * s.x) / denom;
	const u = ((q.x - p.x) * r.y - (q.y - p.y) * r.x) / denom;
	if (t <= 0 || u <= 0) return null;
	const point = fromXY(a, { x: r.x * t, y: r.y * t });
	return { ...point, crossDeg: Math.round(crossDeg), distanceFromA: Math.round(t) };
}

/** The compass direction a heading is closest to. */
function cardinal(heading) {
	if (!Number.isFinite(heading)) return null;
	return ["N", "E", "S", "W"][Math.round(norm(heading) / 90) % 4];
}

module.exports = { bearingInPhoto, intersect, distanceM, cardinal, norm, MIN_CROSS_DEG, PHONE_HFOV_DEG };
