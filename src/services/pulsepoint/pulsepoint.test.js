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

describe("watch", () => {
	jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
	const watch = require("./watch");
	const home = { name: "Home", latitude: 35.6741, longitude: -80.9073, radiusMiles: 3 };
	const at = (id, code, lat, lon, extra = {}) => ({
		id, code, status: "active", what: calltypes.describe(code),
		category: calltypes.lookup(code)?.category || null, alertable: calltypes.isAlertable(code),
		latitude: lat, longitude: lon, locatable: lat !== null, address: "SHADY COVE RD & PERTH RD, TROUTMAN, NC",
		units: 3, receivedAt: new Date(), ...extra,
	});

	test("tree down near home is told, even though PulsePoint says not alertable", async () => {
		const hits = await watch.nearbyFor(1, { list: [at("t1", "TD", 35.69, -80.9073)], places: [home] });
		expect(hits).toHaveLength(1);
		expect(hits[0].incident.alertable).toBe(false);
	});

	test("medical calls and far calls are not", async () => {
		const list = [at("m1", "ME", 35.6745, -80.9073), at("f1", "SF", 35.9, -80.9073)];
		expect(await watch.nearbyFor(1, { list, places: [home] })).toHaveLength(0);
	});

	test("recent (closed) calls are not", async () => {
		const list = [at("c1", "TD", 35.675, -80.9073, { status: "recent" })];
		expect(await watch.nearbyFor(1, { list, places: [home] })).toHaveLength(0);
	});

	test("wording names what, where and how far", async () => {
		const hits = await watch.nearbyFor(1, { list: [at("t1", "TD", 35.69, -80.9073)], places: [home] });
		expect(watch.wording(hits)).toBe("Tree Down 1.1 miles from home: Shady Cove Rd & Perth Rd (3 units).");
	});

	test("several calls become one message, nearest first", async () => {
		const list = [at("a", "TD", 35.69, -80.9073), at("b", "HC", 35.68, -80.9073)];
		const text = watch.wording(await watch.nearbyFor(1, { list, places: [home] }));
		expect(text.split("\n")[0]).toBe("2 new emergency calls near home:");
		expect(text.split("\n")[1]).toMatch(/^• Hazardous Condition/);
	});
});

describe("situation assessment", () => {
	const watch = require("./watch");
	const home = { name: "Home", latitude: 35.6741, longitude: -80.9073, radiusMiles: 3 };
	const call = (id, code, lat) => ({
		id, code, status: "active", what: calltypes.describe(code),
		category: calltypes.lookup(code)?.category || null, alertable: calltypes.isAlertable(code),
		latitude: lat, longitude: -80.9073, locatable: true, address: "PERTH RD, TROUTMAN, NC",
		units: 2, receivedAt: new Date(),
	});
	const hitsFor = (list) => watch.nearbyFor(1, { list, places: [home] });

	test("two trees down is urgent even though neither is 'alertable' — the owner's rule", async () => {
		const hits = await hitsFor([call("a", "TD", 35.69), call("b", "TD", 35.68)]);
		expect(watch.floorLevel(hits)).toBe("urgent");
	});

	test("one serious call alone is urgent; one routine call is watch", async () => {
		expect(watch.floorLevel(await hitsFor([call("f", "SF", 35.69)]))).toBe("urgent");
		expect(watch.floorLevel(await hitsFor([call("t", "TD", 35.69)]))).toBe("watch");
		expect(watch.floorLevel([])).toBe("none");
	});

	test("the model writes the words but cannot talk the level down", async () => {
		const hits = await hitsFor([call("a", "TD", 35.69), call("b", "HC", 35.68)]);
		const generate = async () => ({ data: { level: "watch", headline: "Storm damage near home.", body: "Two calls on Perth Rd." }, model: "test" });
		const s = await watch.assess(hits, { generate });
		expect(s.level).toBe("urgent");
		expect(s.headline).toBe("Storm damage near home");
		expect(s.body).toBe("Two calls on Perth Rd.");
		expect(s.assessedBy).toBe("test");
	});

	test("the model may raise the level", async () => {
		const hits = await hitsFor([call("t", "TD", 35.69)]);
		const generate = async () => ({ data: { level: "urgent", headline: "Tree down", body: "On Perth Rd." } });
		expect((await watch.assess(hits, { generate })).level).toBe("urgent");
	});

	test("a failing model still produces the alert, from the rules", async () => {
		const hits = await hitsFor([call("a", "TD", 35.69), call("b", "TD", 35.68)]);
		const s = await watch.assess(hits, { generate: async () => { throw new Error("down"); } });
		expect(s.level).toBe("urgent");
		expect(s.assessedBy).toBe("rules");
		expect(s.headline).toBe("2 emergencies near home");
		expect(s.body).toMatch(/Tree Down/);
	});

	test("a model answer with no words falls back rather than sending an empty alert", async () => {
		const hits = await hitsFor([call("f", "SF", 35.69)]);
		const s = await watch.assess(hits, { generate: async () => ({ data: { level: "urgent", headline: "", body: "" } }) });
		expect(s.assessedBy).toBe("rules");
		expect(s.headline).toBe("Structure Fire near home");
	});
});

describe("dashboard alert merge", () => {
	jest.mock("../llm", () => ({}));
	jest.mock("../dashboard", () => ({}));
	jest.mock("../actions", () => ({}));
	jest.mock("../readCache", () => ({}));
	const { mergeAlert } = require("../dashboardPriority");
	const urgent = { level: "urgent", headline: "Fires near home", body: "Two calls." };

	test("an urgent situation shows even when the model raised nothing", () => {
		expect(mergeAlert(null, urgent)).toMatchObject({ level: "urgent", source: "emergencies" });
	});
	test("the model cannot downgrade it", () => {
		expect(mergeAlert({ level: "watch", headline: "x", body: "y" }, urgent).level).toBe("urgent");
	});
	test("the model can raise an alert about anything else", () => {
		expect(mergeAlert({ level: "urgent", headline: "Flight in 40 min", body: "Leave now." }, { level: "none" })).toMatchObject({ source: "athena", level: "urgent" });
	});
	test("most days: nothing", () => {
		expect(mergeAlert(null, { level: "none" })).toBeNull();
	});
});

describe("answer check", () => {
	const { checkAnswer } = require("./watch");
	const ok = { level: "urgent", headline: "Fire near home", body: "A structure fire on Brer Fox Trail and a hazard on Neill Farm Road." };
	test("accepts an answer that names every call", () => {
		expect(checkAnswer(ok, ["brer", "neill"])).toBe(true);
	});
	test("rejects one that drops a call, so the router tries a stronger model", () => {
		expect(checkAnswer({ ...ok, body: "Fire on Brer Fox Trail." }, ["brer", "neill"])).toMatch(/missing: neill/);
	});
	test("with more than three calls it only needs the shape", () => {
		expect(checkAnswer({ ...ok, body: "Five calls nearby." }, ["a1", "b1", "c1", "d1"])).toBe(true);
	});
});

describe("cadence", () => {
	const { isDue, rhythmFor } = require("./watch");
	// The database measures both of these, so the tests speak in seconds-ago
	// and seconds-from-now rather than in timestamps — see hotUntil().
	const health = (over = {}) => ({ blocked: false, hotInSeconds: null, sinceAttemptSeconds: null, ...over });

	test("quiet: every 15 minutes", () => {
		expect(rhythmFor(health()).everyMs).toBe(15 * 60000);
		expect(isDue(health({ sinceAttemptSeconds: 10 * 60 })).due).toBe(false);
		expect(isDue(health({ sinceAttemptSeconds: 15 * 60 })).due).toBe(true);
	});

	test("something nearby: every 5 minutes until the hour runs out", () => {
		const hot = health({ hotInSeconds: 30 * 60, sinceAttemptSeconds: 5 * 60 });
		expect(rhythmFor(hot).everyMs).toBe(5 * 60000);
		expect(isDue(hot).due).toBe(true);
		const cooled = health({ hotInSeconds: -60, sinceAttemptSeconds: 5 * 60 });
		expect(isDue(cooled).due).toBe(false);
	});

	test("a scheduler tick a few seconds early still counts", () => {
		expect(isDue(health({ sinceAttemptSeconds: 15 * 60 - 20 })).due).toBe(true);
	});

	test("blocked: back right off, whatever else is going on", () => {
		const blocked = health({ blocked: true, hotInSeconds: 30 * 60, sinceAttemptSeconds: 20 * 60 });
		expect(rhythmFor(blocked).everyMs).toBe(6 * 60 * 60000);
		expect(isDue(blocked).due).toBe(false);
	});

	test("never read: due immediately", () => {
		expect(isDue(health()).due).toBe(true);
	});
});

describe("weather alerts", () => {
	const nws = require("./nws");
	const watch = require("./watch");
	const soon = () => new Date(Date.now() + 3600_000).toISOString();
	const feature = (over = {}) => ({
		properties: {
			id: "urn:oid:1.2.3",
			event: "Tornado Warning",
			severity: "Extreme",
			urgency: "Immediate",
			status: "Actual",
			messageType: "Alert",
			areaDesc: "Iredell, NC",
			headline: "Tornado Warning issued...",
			instruction: "Take shelter now.",
			expires: soon(),
			...over,
		},
	});
	const place = { name: "Home" };

	test("keeps a live warning, with the service's own advice", () => {
		const a = nws.alert(feature(), place);
		expect(a).toMatchObject({ event: "Tornado Warning", serious: true, place: "Home", instruction: "Take shelter now." });
	});

	test("a watch is kept but is not 'serious' — it has not started", () => {
		expect(nws.alert(feature({ event: "Tornado Watch", severity: "Severe", urgency: "Future" }), place).serious).toBe(false);
	});

	test("drops advisories, tests, cancellations and expired alerts", () => {
		expect(nws.alert(feature({ severity: "Minor" }), place)).toBeNull();
		expect(nws.alert(feature({ status: "Test" }), place)).toBeNull();
		expect(nws.alert(feature({ messageType: "Cancel" }), place)).toBeNull();
		expect(nws.alert(feature({ expires: new Date(Date.now() - 1000).toISOString() }), place)).toBeNull();
		expect(nws.alert(feature({ urgency: "Past" }), place)).toBeNull();
	});

	test("one serious weather alert alone is urgent; a watch alone is watch", () => {
		const warning = [{ serious: true }];
		const watchOnly = [{ serious: false }];
		expect(watch.floorLevel([], warning)).toBe("urgent");
		expect(watch.floorLevel([], watchOnly)).toBe("watch");
		// a call plus any weather alert is two things at once
		expect(watch.floorLevel([{ serious: false }], watchOnly)).toBe("urgent");
	});

	test("the assessment covers weather even with no calls at all", async () => {
		const alerts = [{ id: "w1", event: "Tornado Warning", severity: "Extreme", urgency: "Immediate", area: "Iredell", instruction: "Take shelter now.", place: "Home", serious: true }];
		const s = await watch.assess([], { weather: alerts, generate: async () => { throw new Error("no model"); } });
		expect(s.level).toBe("urgent");
		expect(s.headline).toMatch(/Tornado Warning/);
		expect(s.body).toMatch(/Take shelter now/);
	});
});
