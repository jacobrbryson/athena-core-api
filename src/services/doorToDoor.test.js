jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./news", () => ({ getNews: jest.fn() }));
jest.mock("./connectors/googleContacts", () => ({ listContacts: jest.fn() }));
jest.mock("./connectors/googleCalendar", () => ({ collectEvents: jest.fn(), displayTimeZone: jest.fn(() => "America/New_York") }));
jest.mock("./pulsepoint/watch", () => ({ listPlaces: jest.fn() }));
jest.mock("./community", () => ({ listNeighbors: jest.fn(), streetKey: jest.requireActual("./community").streetKey }));

const db = require("../helpers/db");
const watch = require("./pulsepoint/watch");
const community = require("./community");
const doors = require("./doorToDoor");

const PLACE = { uuid: "p-1", name: "Home", address: "148 Rushing Water Lane, Troutman, NC 28166", latitude: 35.6741, longitude: -80.9073 };
const osm = (...els) => jest.fn().mockResolvedValue({ ok: true, json: async () => ({ elements: els }) });
const node = (n, street = "Rushing Water Lane") => ({ type: "node", lat: 35.67, lon: -80.9, tags: { "addr:housenumber": String(n), "addr:street": street } });

beforeEach(() => { jest.resetAllMocks(); community.listNeighbors.mockResolvedValue([]); });

describe("street naming", () => {
	test("street and its core come from an address", () => {
		expect(doors.streetOf("148 Rushing Water Lane, Troutman, NC")).toBe("Rushing Water Lane");
		expect(doors.streetCore("Rushing Water Lane")).toBe("Rushing Water");
		expect(doors.streetCore("Main")).toBe("Main");
	});
	test("walk order is one side up, the other side back down", () => {
		const out = ["150", "148", "152", "149", "151"].sort(doors.walkOrder);
		expect(out).toEqual(["149", "151", "152", "150", "148"]);
	});
});

describe("lookupStreet", () => {
	test("lists distinct houses in walking order and sends only a rounded point", async () => {
		const fetchImpl = osm(node(152), node(148), node(149), node(152), node(150, "Rushing Water Ln"));
		const out = await doors.lookupStreet({ street: "Rushing Water Lane", latitude: 35.6741, longitude: -80.9073 }, fetchImpl);
		expect(out.map((d) => d.address)).toEqual(["149 Rushing Water Lane", "152 Rushing Water Lane", "150 Rushing Water Ln", "148 Rushing Water Lane"]);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toMatch(/overpass/);
		expect(init.headers["User-Agent"]).toMatch(/athena/);
		const sent = decodeURIComponent(init.body);
		expect(sent).toContain("35.67,-80.91");
		expect(sent).not.toContain("35.6741");
		expect(sent).toContain('"^Rushing Water"');
	});

	test("an unreachable map is a friendly 503, not a crash", async () => {
		await expect(doors.lookupStreet({ street: "Quiet Street", latitude: 35.1, longitude: -80.1 }, jest.fn().mockRejectedValue(new Error("down")))).rejects.toMatchObject({ status: 503 });
		await expect(doors.lookupStreet({ street: "Busy Street", latitude: 35.2, longitude: -80.2 }, jest.fn().mockResolvedValue({ ok: false }))).rejects.toMatchObject({ status: 503 });
	});

	test("needs a street and a location", async () => {
		await expect(doors.lookupStreet({ street: "A", latitude: 35, longitude: -80 }, osm())).rejects.toMatchObject({ status: 400 });
		await expect(doors.lookupStreet({ street: "Main Street", latitude: null, longitude: -80 }, osm())).rejects.toMatchObject({ status: 400 });
	});
});

describe("startRound", () => {
	test("only the caller's own place can anchor a street", async () => {
		watch.listPlaces.mockResolvedValue([PLACE]);
		await expect(doors.startRound(1, { placeUuid: "someone-elses" }, osm())).rejects.toMatchObject({ status: 400 });
		expect(db.query).not.toHaveBeenCalled();
	});

	test("adds a neighbour household the map is missing", async () => {
		watch.listPlaces.mockResolvedValue([{ ...PLACE, latitude: 36.01, longitude: -81.01 }]);
		community.listNeighbors.mockResolvedValue([
			{ address: "154 RUSHING WATER LN, TROUTMAN", latitude: null, longitude: null },
			{ address: "9 Elsewhere Road", latitude: null, longitude: null },
		]);
		const inserts = [];
		db.query.mockImplementation(async (sql, params) => {
			if (/COUNT\(\*\) AS n FROM athena_door_round/.test(sql)) return [[{ n: 0 }]];
			if (/INSERT INTO athena_door_round/.test(sql)) return [{ insertId: 5 }];
			if (/INSERT IGNORE INTO athena_door_check/.test(sql)) inserts.push(params[2]);
			if (/FROM athena_door_round WHERE/.test(sql)) return [[{ id: 5, uuid: "r", street: "Rushing Water Lane", created_at: new Date(), closed_at: null, source: "osm" }]];
			return [[]];
		});
		await doors.startRound(1, { placeUuid: "p-1" }, osm(node(148), node(150)));
		expect(inserts).toEqual(["150 Rushing Water Lane", "148 Rushing Water Lane", "154 RUSHING WATER LN"]);
	});
});

describe("applyMarks", () => {
	const mock = () => db.query.mockImplementation(async (sql) => (/FROM athena_door_round WHERE/.test(sql) ? [[{ id: 5, uuid: "r", street: "S", created_at: new Date(), closed_at: null }]] : [[]]));

	test("a mark never overwrites a newer one, and todo clears the time", async () => {
		mock();
		await doors.applyMarks(1, "r", [{ address: "148 Rushing Water Lane", status: "safe", at: "2026-10-06T12:00:00Z" }, { address: "150 Rushing Water Lane", status: "todo" }]);
		const updates = db.query.mock.calls.filter(([sql]) => /UPDATE athena_door_check/.test(sql));
		expect(updates[0][0]).toMatch(/checked_at IS NULL OR checked_at <= \?/);
		expect(updates[0][1].slice(0, 2)).toEqual(["safe", null]);
		expect(updates[1][1][2]).toBeNull();
	});

	test("an unknown status is refused", async () => {
		mock();
		await expect(doors.applyMarks(1, "r", [{ address: "148 Rushing Water Lane", status: "dead" }])).rejects.toMatchObject({ status: 400 });
	});

	test("someone else's round is a 404", async () => {
		db.query.mockResolvedValue([[]]);
		await expect(doors.applyMarks(1, "nope", [])).rejects.toMatchObject({ status: 404 });
	});
});

describe("addDoor", () => {
	test("needs a house number and street", async () => {
		db.query.mockImplementation(async (sql) => (/FROM athena_door_round WHERE/.test(sql) ? [[{ id: 5, uuid: "r", street: "S", created_at: new Date() }]] : [[{ n: 0 }]]));
		await expect(doors.addDoor(1, "r", "the blue house")).rejects.toMatchObject({ status: 400 });
	});
});
