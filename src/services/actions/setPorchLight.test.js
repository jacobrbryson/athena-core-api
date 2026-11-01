/**
 * set_porch_light — the front porch lights, every change on a card the person
 * confirms. Offered only to the household adults in the family whose house the
 * bridge is in, and everyday use writes no test result.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("../consent", () => ({ hasConsentForProfile: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn() }));
jest.mock("../family", () => ({ getFamilyForProfile: jest.fn() }));
jest.mock("../connectors/googleCalendar", () => ({ createEvent: jest.fn(), deleteEvent: jest.fn() }));
jest.mock("../lookRequests", () => ({ create: jest.fn() }));
jest.mock("../memory", () => ({ CATEGORIES: new Set(["other"]), upsertMemoryForProfile: jest.fn() }));
jest.mock("../eufyBridge", () => ({ configured: jest.fn(), allowed: jest.fn(), bridge: jest.fn() }));
jest.mock("../guardianMissions", () => ({
	parentActor: jest.fn(),
	capabilityByKey: jest.fn(),
	control: jest.fn(),
	log: jest.fn(),
	recordTest: jest.fn(),
	gate: { mayUse: jest.fn() },
}));

const eufyBridge = require("../eufyBridge");
const missions = require("../guardianMissions");
const house = require("../guardianMissions/house");
const registry = require("./registry");

const action = registry.get("set_porch_light");
const parent = { id: 3, family_id: 1 };
const capability = { id: 9, cap_key: "porch_light", mission_only: 1 };

const answers = (status, body) => ({ ok: status < 300, status, json: async () => body });

beforeEach(() => {
	jest.clearAllMocks();
	eufyBridge.configured.mockReturnValue(true);
	eufyBridge.allowed.mockReturnValue(true);
	eufyBridge.bridge.mockResolvedValue(answers(200, { on: true, confirmed: true, latencyMs: 300 }));
	missions.parentActor.mockResolvedValue(parent);
	missions.capabilityByKey.mockResolvedValue(capability);
	missions.control.mockResolvedValue({ mode: "paused", kill_switch: 0 });
	missions.gate.mayUse.mockReturnValue({ allowed: true, verdict: "allow" });
});

test("asks every time and can be undone", () => {
	expect(action).toMatchObject({ provider: null, consentType: "action_authority", reversible: true, standing: false, sameAs: false });
});

test("accepts on or off and nothing else", () => {
	expect(action.normalize({ state: "ON" })).toEqual({ state: "on" });
	expect(action.normalize({ state: "off", extra: "dropped" })).toEqual({ state: "off" });
	for (const state of [undefined, true, "dim", "blink", ""]) expect(() => action.normalize({ state })).toThrow(/on.*off/);
	expect(action.summarize({ state: "on" })).toBe("Turn the front porch lights on");
});

describe("who is offered it", () => {
	test("an authorized adult in the family with the capability", async () => {
		expect(await action.availableTo(7)).toBe(true);
	});
	test("nobody when the bridge isn't configured", async () => {
		eufyBridge.configured.mockReturnValue(false);
		expect(await action.availableTo(7)).toBe(false);
	});
	test("not an adult outside the camera list", async () => {
		eufyBridge.allowed.mockReturnValue(false);
		expect(await action.availableTo(7)).toBe(false);
	});
	test("not someone who isn't a parent, or a family without the light", async () => {
		missions.parentActor.mockResolvedValueOnce(null);
		expect(await action.availableTo(7)).toBe(false);
		missions.capabilityByKey.mockResolvedValueOnce(null);
		expect(await action.availableTo(7)).toBe(false);
	});
});

describe("execute", () => {
	test("sends the state, logs it, and records no test result", async () => {
		await expect(action.execute(7, { state: "on" })).resolves.toEqual({ ref: "porch_light", detail: "Lights on" });
		expect(eufyBridge.bridge.mock.calls[0][0]).toBe("/v1/porch-light");
		expect(JSON.parse(eufyBridge.bridge.mock.calls[0][2].body)).toEqual({ on: true });
		expect(missions.log).toHaveBeenCalledWith(1, "porch_light_command", expect.objectContaining({ actorId: 3, outcome: "ok" }));
		expect(missions.recordTest).not.toHaveBeenCalled();
	});

	test("isn't held to mission mode or a pause, as a parent's own request", async () => {
		await action.execute(7, { state: "off" });
		const { capability: asked, control } = missions.gate.mayUse.mock.calls[0][0];
		expect(asked.mission_only).toBe(0);
		expect(control.mode).toBe("running");
		expect(control.kill_switch).toBe(0);
	});

	test("the kill switch stops it before anything is sent", async () => {
		missions.gate.mayUse.mockReturnValue({ allowed: false, verdict: "refuse", reason: "the kill switch is on" });
		await expect(action.execute(7, { state: "on" })).rejects.toThrow(/kill switch/);
		expect(eufyBridge.bridge).not.toHaveBeenCalled();
	});

	test("fails out loud when the switch doesn't read back or the bridge refuses", async () => {
		eufyBridge.bridge.mockResolvedValueOnce(answers(200, { on: false, confirmed: false }));
		await expect(action.execute(7, { state: "on" })).rejects.toThrow(/didn't read back/);
		eufyBridge.bridge.mockResolvedValueOnce(answers(405, { error: "Control is off on this bridge (EUFY_BRIDGE_CONTROL)" }));
		await expect(action.execute(7, { state: "on" })).rejects.toThrow(/Control is off/);
		expect(missions.log).toHaveBeenLastCalledWith(1, "porch_light_command", expect.objectContaining({ outcome: "failed" }));
		expect(missions.recordTest).not.toHaveBeenCalled();
	});
});

describe("porchLightState", () => {
	test("reads the switch", async () => {
		eufyBridge.bridge.mockResolvedValueOnce(answers(200, { on: false, latencyMs: 200 }));
		expect(await house.porchLightState()).toEqual({ ok: true, on: false });
		expect(eufyBridge.bridge.mock.calls[0][0]).toBe("/v1/porch-light");
		expect(eufyBridge.bridge.mock.calls[0][2]).toBeUndefined();
	});
	test("never guesses when it can't", async () => {
		eufyBridge.bridge.mockResolvedValueOnce(answers(503, { error: "Porch light unreachable" }));
		expect(await house.porchLightState()).toEqual({ ok: false, error: "Porch light unreachable" });
		eufyBridge.bridge.mockRejectedValueOnce(new Error("unconfigured"));
		expect(await house.porchLightState()).toEqual({ ok: false, error: "unconfigured" });
	});
});
