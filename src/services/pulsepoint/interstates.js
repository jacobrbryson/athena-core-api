/**
 * Interstate "addresses" -> a point.
 *
 * Iredell 911 gives a call on the interstate as a block number on the route:
 * "3658 N I77, MOORESVILLE" is northbound I-77 at mile 36.58. No street
 * geocoder can place that (the Census one finds nothing), and those calls were
 * most of what Athena said she "couldn't place" (2026-10-08: five of eight).
 *
 * Exit numbers on both roads are mile markers, so the exits below are the
 * reference points and a mile between two exits is interpolated along the
 * straight line joining them. That is good to a few tenths of a mile — fine
 * for "how close is this to home", never meant for navigation.
 *
 * Positions are the midpoints of each exit's motorway_junction nodes in
 * OpenStreetMap (© OpenStreetMap contributors, ODbL), fetched 2026-10-09.
 * Only the stretch through and just around Iredell County is covered; a mile
 * outside it is not placed rather than extrapolated.
 */

/** [mile, latitude, longitude], by mile. */
const ROUTES = {
	77: [
		[25, 35.44232, -80.86911],
		[28, 35.48302, -80.87469],
		[30, 35.50399, -80.86668],
		[31, 35.5303, -80.86239],
		[33, 35.5543, -80.85818],
		[35, 35.57974, -80.85676],
		[36, 35.59352, -80.85956],
		[42, 35.67172, -80.85775],
		[45, 35.72546, -80.85787],
		[49, 35.77339, -80.86325],
		[50, 35.79061, -80.86267],
		[51, 35.80885, -80.86112],
		[54, 35.84923, -80.85978],
		[59, 35.91725, -80.8549],
		[65, 36.00726, -80.83378],
	],
	40: [
		[132, 35.72254, -81.20528],
		[133, 35.72161, -81.18632],
		[135, 35.72287, -81.15777],
		[138, 35.73744, -81.09234],
		[141, 35.75094, -81.05503],
		[144, 35.77261, -80.99764],
		[146, 35.78066, -80.97496],
		[148, 35.79393, -80.93572],
		[150, 35.8019, -80.90412],
		[154, 35.81509, -80.83142],
		[162, 35.86988, -80.71048],
	],
};

/** "3658 N I77", "4922 S I-77", "15000 W I 40" — block number, direction, route. */
const PATTERN = /^(\d{3,6})\s+([NSEW])\s+I[\s-]?(\d{2,3})\b/i;

/**
 * The point for an interstate block-number address, or null when the text is
 * not one, the route is not covered, or the mile is off the covered stretch.
 */
function locate(address) {
	const m = typeof address === "string" ? address.trim().match(PATTERN) : null;
	if (!m) return null;
	const route = ROUTES[Number(m[3])];
	if (!route) return null;
	const mile = Number(m[1]) / 100;
	for (let i = 1; i < route.length; i++) {
		const [m0, lat0, lon0] = route[i - 1];
		const [m1, lat1, lon1] = route[i];
		if (mile < m0 || mile > m1) continue;
		const t = (mile - m0) / (m1 - m0);
		return {
			latitude: Math.round((lat0 + t * (lat1 - lat0)) * 1e5) / 1e5,
			longitude: Math.round((lon0 + t * (lon1 - lon0)) * 1e5) / 1e5,
			label: `I-${m[3]} ${m[2].toUpperCase()}, mile ${Math.round(mile * 10) / 10}`,
		};
	}
	return null;
}

module.exports = { locate, ROUTES };
