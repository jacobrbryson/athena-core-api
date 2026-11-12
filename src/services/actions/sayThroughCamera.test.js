/**
 * say_through_camera — Athena's voice out of a house camera, the exact words on
 * a card the person confirms. Offered only to the household adults in the
 * family whose house the bridge is in; the camera must be one the bridge
 * reports now and can play sound; everyday use writes no test result.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("../consent", () => ({ hasConsentForProfile: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn() }));
jest.mock("../family", () => ({ getFamilyForProfile: jest.fn() }));
jest.mock("../connectors/googleCalendar", () => ({ createEvent: jest.fn(), deleteEvent: jest.fn() }));
jest.mock("../lookRequests", () => ({ create: jest.fn() }));
jest.mock("../memory", () => ({ CATEGORIES: new Set(["other"]), upsertMemoryForProfile: jest.fn() }));
jest.mock("../llm", () => ({ speech: jest.fn() }));
jest.mock("../eufyBridge", () => ({ configured: jest.fn(), allowed: jest.fn(), bridge: jest.fn(), status: jest.fn(), SERIAL: /^[A-Za-z0-9_-]{4,40}$/ }));
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
const llm = require("../llm");
const registry = require("./registry");

const action = registry.get("say_through_camera");
const parent = { id: 3, family_id: 1 };
const capability = { id: 8, cap_key: "speak_through_camera", mission_only: 1 };
const talk = { ptz: false, presets: false, talkback: true };
const devices = [
	{ serial: "T8210DOOR01", name: "Doorbell", model: "T8210", control: talk },
	{ serial: "T8170DRIVE1", name: "Driveway Cam", model: "T8170", control: { ...talk, ptz: true } },
	{ serial: "T8170BACK01", name: "Back Yard", model: "T8170", control: talk },
	{ serial: "T8400INDOOR", name: "Indoor", model: "T8400", control: { ptz: false, presets: false, talkback: false } },
];

const answers = (status, body) => ({ ok: status < 300, status, json: async () => body });

beforeEach(() => {
	jest.clearAllMocks();
	eufyBridge.configured.mockReturnValue(true);
	eufyBridge.allowed.mockReturnValue(true);
	eufyBridge.status.mockResolvedValue({ state: "connected", devices });
	eufyBridge.bridge.mockResolvedValue(answers(200, { latencyMs: 2100 }));
	llm.speech.mockResolvedValue({ audioBase64: Buffer.alloc(480).toString("base64"), sampleRate: 24000 });
	missions.parentActor.mockResolvedValue(parent);
	missions.capabilityByKey.mockResolvedValue(capability);
	missions.control.mockResolvedValue({ mode: "paused", kill_switch: 0 });
	missions.gate.mayUse.mockReturnValue({ allowed: true, verdict: "allow" });
});

test("asks every time and can't be taken back", () => {
	expect(action).toMatchObject({ provider: null, consentType: "action_authority", reversible: false, standing: false, sameAs: false });
});

describe("normalize", () => {
	test("finds the camera by how people say it and keeps the exact words", async () => {
		await expect(action.normalize({ camera: "the driveway camera", message: "  Dinner's ready!  " })).resolves.toEqual({ camera_serial: "T8170DRIVE1", camera_name: "Driveway Cam", message: "Dinner's ready!" });
		await expect(action.normalize({ camera: "backyard", message: "Hi" })).resolves.toMatchObject({ camera_serial: "T8170BACK01" });
		await expect(action.normalize({ camera: "DOORBELL", message: "Hi", camera_serial: "ATTACKER" })).resolves.toMatchObject({ camera_serial: "T8210DOOR01" });
		expect(action.summarize({ camera_name: "Driveway Cam", message: "Dinner's ready!" })).toBe('Say through the Driveway Cam camera: "Dinner\'s ready!"');
	});

	test("refuses a missing camera or message, and never cuts the words", async () => {
		await expect(action.normalize({ message: "Hi" })).rejects.toThrow(/which camera/);
		await expect(action.normalize({ camera: "Doorbell", message: "  " })).rejects.toThrow(/what to say/);
		await expect(action.normalize({ camera: "Doorbell", message: "x".repeat(301) })).rejects.toThrow(/300 characters/);
		await expect(action.normalize({ camera: "Doorbell", message: "x".repeat(300) })).resolves.toMatchObject({ message: "x".repeat(300) });
	});

	test("only a camera the bridge reports, that can play sound", async () => {
		await expect(action.normalize({ camera: "garage", message: "Hi" })).rejects.toThrow(/no camera called "garage".*Doorbell, Driveway Cam, Back Yard, Indoor/);
		await expect(action.normalize({ camera: "indoor", message: "Hi" })).rejects.toThrow(/can't play sound/);
		eufyBridge.status.mockResolvedValueOnce({ state: "connected", devices: [devices[1], { ...devices[2], name: "Driveway Side" }] });
		await expect(action.normalize({ camera: "drive", message: "Hi" })).rejects.toThrow(/More than one/);
	});

	test("says so when the cameras can't be reached", async () => {
		eufyBridge.status.mockResolvedValueOnce(null);
		await expect(action.normalize({ camera: "Doorbell", message: "Hi" })).rejects.toThrow(/can't be reached/);
		eufyBridge.configured.mockReturnValueOnce(false);
		await expect(action.normalize({ camera: "Doorbell", message: "Hi" })).rejects.toThrow(/aren't connected/);
	});
});

describe("who is offered it", () => {
	test("an authorized adult in the family with the capability", async () => {
		expect(await action.availableTo(7)).toBe(true);
		expect(missions.capabilityByKey).toHaveBeenCalledWith(1, "speak_through_camera");
	});
	test("nobody when the bridge isn't configured, or outside the camera list", async () => {
		eufyBridge.configured.mockReturnValueOnce(false);
		expect(await action.availableTo(7)).toBe(false);
		eufyBridge.allowed.mockReturnValueOnce(false);
		expect(await action.availableTo(7)).toBe(false);
	});
	test("not someone who isn't a parent, or a family without the capability", async () => {
		missions.parentActor.mockResolvedValueOnce(null);
		expect(await action.availableTo(7)).toBe(false);
		missions.capabilityByKey.mockResolvedValueOnce(null);
		expect(await action.availableTo(7)).toBe(false);
	});
});

describe("execute", () => {
	const params = { camera_serial: "T8170DRIVE1", camera_name: "Driveway Cam", message: "Dinner's ready!" };

	test("speaks the approved words as WAV to that camera, logs it, and records no test result", async () => {
		await expect(action.execute(7, params)).resolves.toEqual({ ref: "T8170DRIVE1", detail: "Said through the Driveway Cam camera" });
		expect(llm.speech).toHaveBeenCalledWith("Dinner's ready!");
		const [path, , opts] = eufyBridge.bridge.mock.calls[0];
		expect(path).toBe("/v1/devices/T8170DRIVE1/talk");
		expect(opts.contentType).toBe("audio/wav");
		expect(opts.body.subarray(0, 4).toString()).toBe("RIFF");
		expect(missions.log).toHaveBeenCalledWith(1, "speak_through_camera_command", expect.objectContaining({ actorId: 3, outcome: "ok" }));
		expect(missions.recordTest).not.toHaveBeenCalled();
	});

	test("isn't held to mission mode or a pause, as a parent's own request", async () => {
		await action.execute(7, params);
		const { capability: asked, control } = missions.gate.mayUse.mock.calls[0][0];
		expect(asked.mission_only).toBe(0);
		expect(control.mode).toBe("running");
	});

	test("the kill switch stops it before any voice is made or sent", async () => {
		missions.gate.mayUse.mockReturnValue({ allowed: false, verdict: "refuse", reason: "the kill switch is on" });
		await expect(action.execute(7, params)).rejects.toThrow(/kill switch/);
		expect(llm.speech).not.toHaveBeenCalled();
		expect(eufyBridge.bridge).not.toHaveBeenCalled();
	});

	test("fails out loud when the bridge refuses", async () => {
		eufyBridge.bridge.mockResolvedValueOnce(answers(405, { error: "Control is off on this bridge (EUFY_BRIDGE_CONTROL)" }));
		await expect(action.execute(7, params)).rejects.toThrow(/Driveway Cam camera didn't play it: Control is off/);
		expect(missions.log).toHaveBeenLastCalledWith(1, "speak_through_camera_command", expect.objectContaining({ outcome: "failed" }));
		expect(missions.recordTest).not.toHaveBeenCalled();
	});

	test("only a parent in the house", async () => {
		missions.parentActor.mockResolvedValueOnce(null);
		await expect(action.execute(7, params)).rejects.toThrow(/Only a parent/);
		expect(eufyBridge.bridge).not.toHaveBeenCalled();
	});
});
