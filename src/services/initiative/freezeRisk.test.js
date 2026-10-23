/**
 * freeze_risk and hvac_struggling (owner, 2026-10-20), and the one quiet-hours
 * exception: freeze_risk is pushed overnight; everything else is still held.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("../consent", () => ({ hasConsentForProfile: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn() }));
jest.mock("../llm", () => ({ generateJson: jest.fn() }));
jest.mock("../connectors/googleCalendar", () => ({ collectEvents: jest.fn(), displayTimeZone: jest.fn(() => "UTC") }));
jest.mock("../connectors/whoop", () => ({ listRecovery: jest.fn() }));
jest.mock("uuid", () => ({ v4: () => "00000000-0000-0000-0000-000000000000" }));
jest.mock("../push", () => ({ deliverNudge: jest.fn() }));
jest.mock("../connectors/nest", () => ({
	refreshIfStale: jest.fn(),
	storedDevices: jest.fn(),
	offlineDevices: jest.fn(),
	deviceTitle: (d) => d.displayName || `${d.room} thermostat`,
	clockTime: (iso) => iso,
}));
jest.mock("../hvacHealth", () => ({ assess: jest.fn(), describe: (i) => `${i.title} not keeping up.` }));
jest.mock("../weatherAlerts", () => ({ homePlace: jest.fn() }));
jest.mock("../weather", () => ({ hourlyRows: jest.fn(), nightsOf: jest.requireActual("../weather").nightsOf }));
jest.mock("../dreams/questions", () => ({ pendingFor: jest.fn() }));
jest.mock("../sightings", () => ({
	activeAlerts: jest.fn(),
	matches: (rule, s) => s.label === rule.label && (!rule.device_serial || s.device_serial === rule.device_serial),
}));
jest.mock("../packageWatch", () => ({ stillThere: jest.fn(), sightingsNear: jest.fn() }));
jest.mock("../deliveries", () => ({ forPackage: jest.fn(), unseen: jest.fn() }));

const pool = require("../../helpers/db");
const access = require("../../security/access");
const consent = require("../consent");
const credentials = require("../credentials");
const llm = require("../llm");
const nest = require("../connectors/nest");
const hvacHealth = require("../hvacHealth");
const weatherAlerts = require("../weatherAlerts");
const weather = require("../weather");
const push = require("../push");
const initiative = require("./index");
const triggers = require("./triggers");

const PROFILE = 42;
const freeze = triggers.get("freeze_risk");
const hvac = triggers.get("hvac_struggling");

// 03:00 UTC on a night forecast to drop to 24°F at 06:00 (NWS local -04:00).
const NOW = new Date("2026-12-10T03:00:00Z");
const hours = (lows) =>
	lows.map((f, i) => ({
		start: new Date(NOW.getTime() + i * 3_600_000).toISOString().replace("Z", "").replace(/\.\d+$/, "") + "-04:00",
		temperatureF: f,
		windMph: 3,
		shortForecast: "Clear",
	}));
const device = (over = {}) => ({
	name: "enterprises/p/devices/den",
	displayName: null,
	room: "Den",
	connectivity: "ONLINE",
	notReporting: false,
	readings: { temperatureC: 20, mode: "HEAT" },
	...over,
});

function db({ pref } = {}) {
	pool.query.mockImplementation(async (sql) => {
		if (sql.includes("FROM athena_initiative_pref")) return [pref ? [pref] : []];
		if (sql.includes("INSERT IGNORE INTO athena_nudge")) return [{ affectedRows: 1 }];
		return [[], {}];
	});
}

beforeEach(() => {
	jest.clearAllMocks();
	access.assertModelAccess.mockResolvedValue(undefined);
	consent.hasConsentForProfile.mockResolvedValue(true);
	credentials.list.mockResolvedValue([{ provider: "nest", status: "active" }]);
	llm.generateJson.mockResolvedValue({ data: { text: "Worded." } });
	nest.refreshIfStale.mockResolvedValue(false);
	nest.offlineDevices.mockResolvedValue([]);
	nest.storedDevices.mockResolvedValue([device()]);
	hvacHealth.assess.mockResolvedValue([]);
	weatherAlerts.homePlace.mockResolvedValue({ name: "Home", latitude: 35.6, longitude: -80.9 });
	weather.hourlyRows.mockResolvedValue({ hours: hours([30, 28, 26, 24, 25, 29]) });
	push.deliverNudge.mockResolvedValue({ sent: 1 });
	db({ pref: { enabled: 1, timezone: "UTC", quiet_from: 0, quiet_to: 0 } });
	jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("freeze_risk", () => {
	test("a warm, heating house on a freezing night says nothing", async () => {
		expect(await freeze.evaluate(PROFILE, { now: NOW })).toBeNull();
	});

	test("an offline thermostat on a hard-freeze night is a risk", async () => {
		nest.storedDevices.mockResolvedValue([device({ connectivity: "OFFLINE" })]);
		const hit = await freeze.evaluate(PROFILE, { now: NOW });
		expect(hit.facts).toMatchObject({ lowF: 24, risk: "hard_freeze", place: "Home" });
		expect(hit.facts.reasons).toEqual([{ title: "Den thermostat", why: "offline" }]);
		expect(freeze.brief(hit.facts)).toMatch(/24°F/);
	});

	test("heat switched off, or the house already at 50°F, are risks too", async () => {
		nest.storedDevices.mockResolvedValue([
			device({ readings: { temperatureC: 20, mode: "OFF" } }),
			device({ name: "enterprises/p/devices/up", room: "Upstairs", readings: { temperatureC: 9.5, mode: "HEAT" } }),
		]);
		const hit = await freeze.evaluate(PROFILE, { now: NOW });
		expect(hit.facts.reasons.map((r) => r.why)).toEqual(["set to off", "reading 49°F inside"]);
	});

	test("no freeze in the forecast means no alert, whatever the thermostat says", async () => {
		nest.storedDevices.mockResolvedValue([device({ connectivity: "OFFLINE" })]);
		weather.hourlyRows.mockResolvedValue({ hours: hours([40, 38, 37, 36, 37, 39]) });
		expect(await freeze.evaluate(PROFILE, { now: NOW })).toBeNull();
	});

	test("the same night and reasons dedupe; a new reason is a new occurrence", async () => {
		nest.storedDevices.mockResolvedValue([device({ connectivity: "OFFLINE" })]);
		const a = await freeze.evaluate(PROFILE, { now: NOW });
		const b = await freeze.evaluate(PROFILE, { now: NOW });
		nest.storedDevices.mockResolvedValue([
			device({ connectivity: "OFFLINE" }),
			device({ name: "enterprises/p/devices/up", room: "Upstairs", readings: { mode: "OFF" } }),
		]);
		const c = await freeze.evaluate(PROFILE, { now: NOW });
		expect(a.dedupeKey).toBe(b.dedupeKey);
		expect(c.dedupeKey).not.toBe(a.dedupeKey);
	});
});

describe("quiet hours", () => {
	test("freeze_risk is the only trigger marked to pierce them", () => {
		expect(triggers.TRIGGERS.filter((t) => t.piercesQuiet).map((t) => t.id)).toEqual(["freeze_risk"]);
	});

	test("overnight, freeze_risk is pushed and everything else is held", async () => {
		db({ pref: { enabled: 1, timezone: "UTC", quiet_from: 22, quiet_to: 7 } });
		nest.storedDevices.mockResolvedValue([device({ connectivity: "OFFLINE", offlineSince: NOW.toISOString() })]);
		nest.offlineDevices.mockResolvedValue([device({ connectivity: "OFFLINE", offlineSince: NOW.toISOString() })]);

		const out = await initiative.evaluateProfile(PROFILE, { now: NOW });

		const ids = out.nudges.map((n) => n.trigger_id).sort();
		expect(ids).toEqual(["freeze_risk", "nest_offline"]);
		expect(out.held).toBe(1);
		expect(push.deliverNudge).toHaveBeenCalledTimes(1);
		expect(push.deliverNudge.mock.calls[0][1].trigger_id).toBe("freeze_risk");
		expect(push.deliverNudge.mock.calls[0][1]).not.toHaveProperty("piercesQuiet");
	});

	test("a muted freeze_risk stays muted, quiet hours or not", async () => {
		pool.query.mockImplementation(async (sql) => {
			if (sql.includes("FROM athena_initiative_pref")) return [[{ enabled: 1, timezone: "UTC", quiet_from: 22, quiet_to: 7 }]];
			if (sql.includes("FROM athena_trigger_mute")) return [[{ trigger_id: "freeze_risk" }]];
			if (sql.includes("INSERT IGNORE INTO athena_nudge")) return [{ affectedRows: 1 }];
			return [[], {}];
		});
		nest.storedDevices.mockResolvedValue([device({ connectivity: "OFFLINE" })]);
		const out = await initiative.evaluateProfile(PROFILE, { now: NOW });
		expect((out.nudges || []).map((n) => n.trigger_id)).not.toContain("freeze_risk");
		expect(push.deliverNudge).not.toHaveBeenCalled();
	});
});

describe("hvac_struggling", () => {
	test("silent when the heating is keeping up", async () => {
		expect(await hvac.evaluate(PROFILE, { now: NOW })).toBeNull();
	});

	test("names what was measured, one occurrence per device, kind and day", async () => {
		const issue = { device: "d1", title: "Den thermostat", room: "Den", kind: "not_keeping_up", hvac: "HEATING", since: "2026-12-10T01:00:00Z" };
		hvacHealth.assess.mockResolvedValue([issue]);
		const a = await hvac.evaluate(PROFILE, { now: NOW });
		hvacHealth.assess.mockResolvedValue([{ ...issue, since: "2026-12-10T02:30:00Z" }]);
		const b = await hvac.evaluate(PROFILE, { now: NOW });
		hvacHealth.assess.mockResolvedValue([{ ...issue, since: "2026-12-11T01:00:00Z" }]);
		const c = await hvac.evaluate(PROFILE, { now: NOW });
		expect(a.dedupeKey).toBe(b.dedupeKey);
		expect(c.dedupeKey).not.toBe(a.dedupeKey);
		expect(hvac.brief(a.facts)).toMatch(/don't guess a cause/);
	});
});

describe("packages", () => {
	const packageWatch = require("../packageWatch");
	const deliveries = require("../deliveries");
	const waiting = triggers.get("package_waiting");
	const unseen = triggers.get("delivery_not_seen");
	const rules = (list) => pool.query.mockImplementation(async (sql) => {
		if (sql.includes("FROM athena_sighting_rule")) return [list];
		return [[], {}];
	});
	const watchRow = { uuid: "w1", device_serial: "T8213", device_name: "Front Door", zone: null, where_text: "brown box on the mat", first_seen_at: new Date("2026-12-10T17:00:00Z") };

	test("nothing is said without the person's own package alert", async () => {
		rules([]);
		packageWatch.stillThere.mockResolvedValue([watchRow]);
		expect(await waiting.evaluate(PROFILE, { now: NOW })).toBeNull();
		expect(packageWatch.stillThere).not.toHaveBeenCalled();
		expect(await unseen.evaluate(PROFILE, { now: NOW })).toBeNull();
		expect(deliveries.unseen).not.toHaveBeenCalled();
	});

	test("a package still there names the order from their email when it fits", async () => {
		rules([{ label: "package", device_serial: null }]);
		packageWatch.stillThere.mockResolvedValue([watchRow]);
		deliveries.forPackage.mockResolvedValue({ merchant: "Walmart", items_summary: "paper towels" });
		const hit = await waiting.evaluate(PROFILE, { now: NOW });
		expect(hit.facts.packages[0]).toMatchObject({ camera: "Front Door", order: "Walmart", items: "paper towels" });
		expect(waiting.brief(hit.facts)).toMatch(/Walmart delivery \(paper towels\)/);
	});

	test("a rule for another camera doesn't cover this one", async () => {
		rules([{ label: "package", device_serial: "BACKYARD1" }]);
		packageWatch.stillThere.mockResolvedValue([watchRow]);
		expect(await waiting.evaluate(PROFILE, { now: NOW })).toBeNull();
	});

	test("delivered with nothing on camera says so, and never says stolen", async () => {
		rules([{ label: "package" }]);
		deliveries.unseen.mockResolvedValue([{ uuid: "d1", merchant: "Walmart", delivered_at: new Date("2026-12-10T15:00:00Z") }]);
		const hit = await unseen.evaluate(PROFILE, { now: NOW });
		expect(hit.facts.orders[0].from).toBe("Walmart");
		expect(unseen.brief(hit.facts)).toMatch(/don't suggest it was stolen/);
	});
});
