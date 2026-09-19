const geo = require("./geo");
const calltypes = require("./calltypes");

describe("geo.milesBetween", () => {
	test("a known distance, to within a rounding error", () => {
		// Statue of Liberty -> Empire State Building. ~5.12 miles: 4.09 north,
		// 3.08 east, and sqrt(4.09^2 + 3.08^2) = 5.12.
		const liberty = { latitude: 40.6892, longitude: -74.0445 };
		const empire = { latitude: 40.7484, longitude: -73.9857 };
		expect(geo.milesBetween(liberty, empire)).toBeCloseTo(5.12, 1);
	});

	test("zero for the same point", () => {
		const p = { latitude: 41.5, longitude: -81.6 };
		expect(geo.milesBetween(p, p)).toBe(0);
	});

	test("null, never NaN, when a coordinate is missing", () => {
		const p = { latitude: 41.5, longitude: -81.6 };
		expect(geo.milesBetween(p, null)).toBeNull();
		expect(
			geo.milesBetween(p, { latitude: "41.5", longitude: -81.6 }),
		).toBeNull();
		expect(geo.milesBetween(p, { latitude: 0, longitude: 0 })).toBeNull();
	});
});

describe("geo.placesNear", () => {
	const home = { name: "Home", latitude: 41.5, longitude: -81.6 };
	// ~1.4 miles north of home.
	const incidentClose = { latitude: 41.52, longitude: -81.6 };
	// ~6.9 miles north of home.
	const incidentFar = { latitude: 41.6, longitude: -81.6 };

	test("matches inside the default three miles", () => {
		const matches = geo.placesNear(incidentClose, [home]);
		expect(matches).toHaveLength(1);
		expect(matches[0].place.name).toBe("Home");
		expect(matches[0].miles).toBeLessThan(3);
	});

	test("no match outside the radius", () => {
		expect(geo.placesNear(incidentFar, [home])).toHaveLength(0);
	});

	test("a per-place radius overrides the default", () => {
		const wide = { ...home, radiusMiles: 10 };
		expect(geo.placesNear(incidentFar, [wide])).toHaveLength(1);
	});

	test("several places come back nearest first", () => {
		const mother = { name: "Mom", latitude: 41.51, longitude: -81.6 };
		const matches = geo.placesNear(incidentClose, [home, mother]);
		expect(matches.map((m) => m.place.name)).toEqual(["Mom", "Home"]);
	});

	test("one unusable place does not break the rest", () => {
		const broken = { name: "Typo", latitude: null, longitude: -81.6 };
		const matches = geo.placesNear(incidentClose, [broken, home]);
		expect(matches.map((m) => m.place.name)).toEqual(["Home"]);
	});

	test("an incident with no coordinates matches nothing", () => {
		expect(geo.placesNear({ latitude: null, longitude: null }, [home])).toEqual(
			[],
		);
	});
});

describe("calltypes", () => {
	test("names a code a person would otherwise have to look up", () => {
		expect(calltypes.describe("SF")).toBe("Structure Fire");
		expect(calltypes.describe("ME")).toBe("Medical Emergency");
	});

	test("falls back to the raw code rather than saying nothing", () => {
		expect(calltypes.describe("ZZZ9")).toBe("ZZZ9");
		expect(calltypes.describe(null)).toBe("Unknown incident");
	});

	test("follows PulsePoint's own alertable judgement", () => {
		expect(calltypes.isAlertable("WSF")).toBe(true); // confirmed structure fire
		expect(calltypes.isAlertable("ME")).toBe(false); // routine medical call
	});

	test("an unknown code is never alertable", () => {
		expect(calltypes.isAlertable("ZZZ9")).toBe(false);
	});

	test("the table survived extraction intact", () => {
		expect(calltypes.TABLE.length).toBeGreaterThan(100);
		for (const entry of calltypes.TABLE) {
			expect(typeof entry.id).toBe("string");
			expect(entry.description).toBeTruthy();
			expect(entry.category).toBeTruthy();
			expect(typeof entry.alertable).toBe("boolean");
		}
	});
});

describe("normalise", () => {
	const normalise = require("./normalise");

	// Shaped exactly like a live EMS1681 response, including the string
	// coordinates and the 0,0 redaction on the medical call.
	const payload = {
		incidents: {
			alerts: [],
			active: [
				{
					ID: "a1",
					AgencyID: "EMS1681",
					PulsePointIncidentCallType: "VF",
					Latitude: "35.5826600000",
					Longitude: "-80.8101000000",
					FullDisplayAddress: "N CHURCH ST & E MOORE AVE, MOORESVILLE, NC",
					CallReceivedDateTime: "2026-09-19T22:11:08Z",
					AddressTruncated: "0",
					Unit: [{}, {}],
				},
				{
					ID: "a2",
					AgencyID: "EMS1681",
					PulsePointIncidentCallType: "ME",
					Latitude: "0.0000000000",
					Longitude: "0.0000000000",
					FullDisplayAddress: "BERACAH RD, MOORESVILLE, NC",
					CallReceivedDateTime: "2026-09-19T22:04:04Z",
					AddressTruncated: "1",
					Unit: [{}],
				},
			],
			recent: [
				{
					ID: "a1",
					PulsePointIncidentCallType: "VF",
					Latitude: "35.58",
					Longitude: "-80.81",
				},
			],
		},
	};

	test("parses string coordinates into numbers", () => {
		const [fire] = normalise.incidents(payload);
		expect(fire.latitude).toBeCloseTo(35.58266, 4);
		expect(fire.longitude).toBeCloseTo(-80.8101, 4);
		expect(fire.locatable).toBe(true);
	});

	test("treats a redacted 0,0 medical call as unlocatable, not as the Atlantic", () => {
		const medical = normalise.incidents(payload).find((i) => i.id === "a2");
		expect(medical.latitude).toBeNull();
		expect(medical.locatable).toBe(false);
		expect(medical.addressTruncated).toBe(true);
		// still kept, still named
		expect(medical.what).toBe("Medical Emergency");
	});

	test("names the call and carries PulsePoint's alertable judgement", () => {
		const [fire] = normalise.incidents(payload);
		expect(fire.what).toBe("Vehicle Fire");
		expect(fire.category).toBe("Fire");
		expect(fire.alertable).toBe(true);
		expect(fire.units).toBe(2);
	});

	test("an id in two buckets is kept once, as active", () => {
		const list = normalise.incidents(payload);
		expect(list.filter((i) => i.id === "a1")).toHaveLength(1);
		expect(list.find((i) => i.id === "a1").status).toBe("active");
	});

	test("a redacted incident never matches a radius", () => {
		const medical = normalise.incidents(payload).find((i) => i.id === "a2");
		const home = { name: "Home", latitude: 35.5826, longitude: -80.8101 };
		expect(geo.placesNear(medical, [home])).toEqual([]);
	});
});
