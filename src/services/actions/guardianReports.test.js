/**
 * set_guardian_reports — Athena changing the Guardian report times from chat
 * (owner, 2026-10-25). Weighted toward refusal: it must stay narrow.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("../consent", () => ({ hasConsentForProfile: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn() }));
jest.mock("../family", () => ({ getFamilyForProfile: jest.fn() }));
jest.mock("../connectors/googleCalendar", () => ({ createEvent: jest.fn(), deleteEvent: jest.fn() }));
jest.mock("../lookRequests", () => ({ create: jest.fn() }));
jest.mock("../memory", () => ({ CATEGORIES: new Set(["other"]), upsertMemoryForProfile: jest.fn() }));
jest.mock("../guardianEngine", () => ({ loadProtocols: jest.fn(), saveConfig: jest.fn() }));

const registry = require("./registry");
const engine = require("../guardianEngine");

const action = registry.get("set_guardian_reports");
const oldEnv = { ...process.env };
beforeEach(() => {
	process.env.EUFY_AUTHORIZED_PROFILE_IDS = "1,2";
	engine.loadProtocols.mockReset().mockResolvedValue({
		nightly_sweep: { enabled: true, config: { recipients: [], schedule: { time: "21:00", timeZone: "America/New_York" }, reports: { evening: true, morning: true, morningTime: "06:00" }, garageDoors: [{ key: "main", name: "Garage door", serial: "CAM1", region: null }] } },
	});
	engine.saveConfig.mockReset().mockResolvedValue({});
});
afterAll(() => (process.env = oldEnv));

describe("set_guardian_reports", () => {
	test("is offered only to household-security adults", async () => {
		expect(action.availableTo(1)).toBe(true);
		expect(action.availableTo(7)).toBe(false);
		await expect(action.normalize({ guardian_morning_time: "06:30" }, { profileId: 7 })).rejects.toThrow(/authorized for household security/);
	});

	test("accepts only times and on/off, and nothing else", async () => {
		const p = await action.normalize({ guardian_evening_time: "9:30", guardian_morning_report: "OFF", enabled: false, recipients: ["99"] }, { profileId: 1 });
		expect(p).toEqual({ guardian_evening_time: "09:30", guardian_morning_report: "off" });
		await expect(action.normalize({ guardian_evening_time: "9pm" }, { profileId: 1 })).rejects.toThrow(/HH:MM/);
		await expect(action.normalize({ guardian_evening_report: "maybe" }, { profileId: 1 })).rejects.toThrow(/on" or "off/);
		await expect(action.normalize({}, { profileId: 1 })).rejects.toThrow(/which report/);
	});

	test("the card says it in plain time", () => {
		expect(action.summarize({ guardian_evening_time: "21:30", guardian_morning_time: "06:15" })).toBe("Guardian: run the nightly sweep and evening report at 9:30 PM; send the morning report at 6:15 AM");
	});

	test("executes as the approving adult, keeps the rest of the settings, and never touches on/off of the sweep", async () => {
		await action.execute(2, { guardian_morning_time: "06:45", guardian_evening_report: "off" });
		const [profileId, protocolId, body] = engine.saveConfig.mock.calls[0];
		expect([profileId, protocolId]).toEqual([2, "nightly_sweep"]);
		expect(body).not.toHaveProperty("enabled");
		expect(body.config.reports).toEqual({ evening: false, morning: true, morningTime: "06:45" });
		expect(body.config.schedule.time).toBe("21:00");
		expect(body.config.garageDoors).toHaveLength(1);
	});

	test("re-checks authorization at execution", async () => {
		process.env.EUFY_AUTHORIZED_PROFILE_IDS = "1";
		await expect(action.execute(2, { guardian_morning_time: "06:45" })).rejects.toThrow(/Not authorized/);
		expect(engine.saveConfig).not.toHaveBeenCalled();
	});

	test("always asks: never a standing approval", () => {
		expect(action.standing).toBe(false);
	});
});
