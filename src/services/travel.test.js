jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./secrets", () => ({ getSecret: jest.fn() }));
jest.mock("./push", () => ({ requestLocation: jest.fn() }));
jest.mock("./pulsepoint/watch", () => ({ listPlaces: jest.fn() }));

const db = require("../helpers/db");
const secrets = require("./secrets");
const push = require("./push");
const watch = require("./pulsepoint/watch");
const travel = require("./travel");

const HOME = { name: "Home", kind: "home", latitude: 35.7, longitude: -80.88, enabled: true };
// Downtown Statesville: ~12 miles from the Troutman home above.
const DOWNTOWN = { latitude: 35.78, longitude: -80.89 };
const PLACE = {
	id: "ChIJsoccer",
	displayName: { text: "Statesville Soccer Complex" },
	formattedAddress: "1100 Old Mocksville Rd, Statesville, NC 28625",
	location: { latitude: 35.81, longitude: -80.86 },
	googleMapsUri: "https://maps.google.com/?cid=123",
};

function mockGoogle({ place = PLACE, routes = {} } = {}) {
	global.fetch = jest.fn(async (url, init) => {
		const body = JSON.parse(init.body);
		if (url.includes("places:searchText")) {
			return { ok: true, json: async () => ({ places: place ? [place] : [] }) };
		}
		const fromHome = body.origin.location.latLng.latitude === HOME.latitude;
		const route = fromHome ? routes.home : routes.here;
		return { ok: true, json: async () => ({ routes: route ? [route] : [] }) };
	});
}

const ROUTE_HOME = { distanceMeters: 22531, duration: "1260s", staticDuration: "1200s" };
const ROUTE_HERE = { distanceMeters: 6437, duration: "600s", staticDuration: "600s" };

beforeEach(() => {
	jest.clearAllMocks();
	travel.reset();
	secrets.getSecret.mockResolvedValue("test-key");
	watch.listPlaces.mockResolvedValue([HOME]);
});

describe("matches / destinationOf", () => {
	test.each([
		["How far away is Statesville Soccer Complex?", "Statesville Soccer Complex"],
		["how far is it to the Charlotte airport", "the Charlotte airport"],
		["How long does it take to get to Lake Norman State Park?", "Lake Norman State Park"],
		["What's the drive time to Mooresville from home?", "Mooresville"],
		["how far am I from Target", "Target"],
	])("%s", (message, destination) => {
		expect(travel.matches(message)).toBe(true);
		expect(travel.destinationOf(message)).toBe(destination);
	});

	test("ignores things that are not a drive", () => {
		expect(travel.matches("How long is the movie?")).toBe(false);
		expect(travel.matches("how far along is the project")).toBe(false);
		expect(travel.matches("how long until Christmas")).toBe(false);
	});

	test("reads an origin named in the question", () => {
		expect(travel.namedOrigin("how far is Target from here")).toBe("here");
		expect(travel.namedOrigin("how far is Target from my house")).toBe("home");
		expect(travel.namedOrigin("how far is Target")).toBe(null);
	});
});

describe("buildContext", () => {
	test("asks which origin when home and the phone are apart, then answers the follow-up", async () => {
		mockGoogle({ routes: { home: ROUTE_HOME, here: ROUTE_HERE } });
		const fix = jest.fn().mockResolvedValue(DOWNTOWN);

		const first = await travel.buildContext(1, "How far away is Statesville Soccer Complex?", { audience: "adult", fix });
		expect(first).toContain("Statesville Soccer Complex, 1100 Old Mocksville Rd");
		expect(first).toContain("From home, or from where you are now?");
		expect(first).not.toMatch(/\d+(\.\d)? miles/);
		// Biased toward home, so "the soccer complex" means the local one.
		const search = JSON.parse(global.fetch.mock.calls[0][1].body);
		expect(search.locationBias.circle.center).toEqual({ latitude: HOME.latitude, longitude: HOME.longitude });

		expect(travel.followUpChoice(1, "from where I am")).toBe("here");
		const answer = await travel.buildContext(1, "from where I am", { audience: "adult", fix });
		expect(answer).toContain("From where their phone is now: 4 miles, about 10 min");
		expect(answer).not.toContain("From home:");
		// Used once: the next "home" is just a word again.
		expect(travel.followUpChoice(1, "home")).toBe(null);
	});

	test("answers from home without asking when the phone is at home", async () => {
		mockGoogle({ routes: { home: ROUTE_HOME, here: ROUTE_HOME } });
		const fix = jest.fn().mockResolvedValue({ latitude: 35.7001, longitude: -80.8801 });
		const block = await travel.buildContext(1, "How far away is Statesville Soccer Complex?", { audience: "adult", fix });
		expect(block).toContain("From home: 14 miles, about 21 min");
		expect(block).not.toContain("From home, or from where");
		expect(travel.followUpChoice(1, "from here")).toBe(null);
	});

	test("answers from home when the phone doesn't answer", async () => {
		mockGoogle({ routes: { home: ROUTE_HOME } });
		const block = await travel.buildContext(1, "how far is the soccer complex", { audience: "adult", fix: async () => null });
		expect(block).toContain("From home: 14 miles");
	});

	test("does not ask the phone when they said from home", async () => {
		mockGoogle({ routes: { home: ROUTE_HOME } });
		const fix = jest.fn();
		await travel.buildContext(1, "how far is the soccer complex from home", { audience: "adult", fix });
		expect(fix).not.toHaveBeenCalled();
	});

	test("says so instead of estimating when there is no key", async () => {
		secrets.getSecret.mockResolvedValue(null);
		const block = await travel.buildContext(1, "how far is the soccer complex", { audience: "adult", fix: jest.fn() });
		expect(block).toMatch(/isn't set up yet/);
		expect(block).toMatch(/don't estimate/);
	});

	test("children get nothing and nothing is looked up", async () => {
		global.fetch = jest.fn();
		expect(await travel.buildContext(1, "how far is the soccer complex", { audience: "child" })).toBe(null);
		expect(global.fetch).not.toHaveBeenCalled();
	});
});

describe("currentFix", () => {
	test("asks the phone and returns the sample that arrives", async () => {
		push.requestLocation.mockResolvedValue({ asked: 1 });
		db.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ latitude: "35.78", longitude: "-80.89" }]]);
		const fix = await travel.currentFix(1, { sleep: async () => {} });
		expect(fix).toEqual(DOWNTOWN);
	});

	test("waits for nothing when no phone was asked (location sharing off)", async () => {
		push.requestLocation.mockResolvedValue({ asked: 0, skipped: "location sharing off" });
		expect(await travel.currentFix(1, { sleep: async () => {} })).toBe(null);
		expect(db.query).not.toHaveBeenCalled();
	});
});
