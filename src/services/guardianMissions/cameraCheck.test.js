/**
 * Camera proof: only what she saw finishes the step, and she only says she can
 * see someone after she did.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../guardianEngine/dispatch", () => ({ wakeAt: jest.fn() }));
jest.mock("./consent", () => ({ standingFor: jest.fn(), standingsFor: jest.fn(), blockedReason: (a) => `${a.display_name} hasn't agreed.` }));
jest.mock("./partners", () => ({ people: jest.fn(), planKey: (a) => a.actor_key }));
jest.mock("./scout", () => ({ storeProofPhoto: jest.fn(async () => ({ uuid: "photo", path: "p" })) }));
jest.mock("../sightings", () => ({ listSubjects: jest.fn(), photoBase64: jest.fn(async () => "ref") }));
jest.mock("../eufyBridge", () => ({ freshSnapshot: jest.fn(), SERIAL: /.*/ }));
jest.mock("./house", () => ({ permit: jest.fn(), say: jest.fn(), cameras: jest.fn() }));

const pool = require("../../helpers/db");
const consent = require("./consent");
const house = require("./house");
const missions = require("./index");
const partners = require("./partners");
const sightings = require("../sightings");
const camera = require("./cameraCheck");
const eufyBridge = require("../eufyBridge");

const thomas = { id: 3, actor_key: "thomas", display_name: "Thomas", kind: "kid" };
const plan = { steps: [{ key: "a", subject: "thomas", camera: "Doorbell", gesture: "a big wave" }] };
const step = { id: 9, uuid: "s", mission_id: 2, plan_key: "a", status: "waiting_parent", proof_required: "camera_check", cap_key: "doorbell_camera", mission_plan: plan };
const mission = { id: 2, status: "running", phase: "live", capabilityIds: [8] };
const llmSaying = (verdict) => ({ generateJson: jest.fn(async () => ({ data: verdict })), speech: jest.fn() });
const frame = { frameBase64: Buffer.from("x").toString("base64"), serial: "T1", source: "look" };

beforeEach(() => {
	jest.restoreAllMocks();
	pool.query.mockReset().mockResolvedValue([[]]);
	consent.standingFor.mockReset().mockResolvedValue({ allowed: true });
	partners.people.mockReset().mockResolvedValue([thomas]);
	sightings.listSubjects.mockReset().mockResolvedValue([{ name: "Thomas Bryson", kind: "person", photos: ["m1"] }]);
	house.permit.mockReset().mockResolvedValue({});
	house.say.mockReset().mockResolvedValue({ ok: true });
	jest.spyOn(missions, "missionById").mockResolvedValue(mission);
	jest.spyOn(missions, "stepByUuid").mockResolvedValue(step);
	jest.spyOn(missions, "capabilityByKey").mockResolvedValue({ id: 8 });
	jest.spyOn(missions, "recordTest").mockResolvedValue();
	jest.spyOn(missions, "completeStep").mockResolvedValue();
});

test("the right person not doing it, or anyone else doing it, is not a pass", () => {
	const names = ["Thomas"];
	expect(camera.passed({ seen: ["thomas"], doing_it: true }, names)).toBe(true);
	expect(camera.passed({ seen: ["Thomas"], doing_it: false }, names)).toBe(false);
	expect(camera.passed({ seen: ["Skylar"], doing_it: true }, names)).toBe(false);
	expect(camera.passed(null, names)).toBe(false);
});

test("everyone asked for has to be in the frame", () => {
	const names = ["Thomas", "Skylar", "Eric"];
	expect(camera.passed({ seen: ["Thomas", "Skylar", "Eric"], doing_it: true }, names)).toBe(true);
	expect(camera.passed({ seen: ["Thomas", "Skylar"], doing_it: true }, names)).toBe(false);
});

test("the greeting names everyone it saw", () => {
	expect(camera.greeting([{ display_name: "Thomas" }])).toBe("I can see you, Thomas. You look great!");
	expect(camera.greeting([{ display_name: "Thomas" }, { display_name: "Skylar" }, { display_name: "Eric" }])).toBe("I can see you, Thomas, Skylar and Eric. You look great!");
});

test("a guest with no reference photo can't be checked", async () => {
	const guested = { ...step, mission_plan: { steps: [{ ...plan.steps[0], guest: "Eric" }] } };
	const llm = llmSaying({ seen: ["Thomas", "Eric"], doing_it: true, why: "together" });
	await expect(camera.check(1, guested, frame, { llm })).rejects.toThrow("reference photo of Eric");
	expect(llm.generateJson).not.toHaveBeenCalled();
});

test("she confirms the family's agreement for everyone in the frame, and a guest's is an adult's prep step", async () => {
	const guested = { ...step, mission_plan: { steps: [{ ...plan.steps[0], also: ["skylar"], guest: "Eric" }] } };
	partners.people.mockResolvedValue([thomas, { id: 4, actor_key: "skylar", display_name: "Skylar", kind: "kid" }]);
	sightings.listSubjects.mockResolvedValue([{ name: "Thomas Bryson", kind: "person", photos: ["a"] }, { name: "Skylar Bryson", kind: "person", photos: ["b"] }, { name: "Eric", kind: "person", photos: ["c"] }]);
	const out = await camera.check(1, guested, frame, { llm: llmSaying({ seen: ["Thomas", "Skylar", "Eric"], doing_it: true, why: "together" }) });
	expect(out.seen).toBe(true);
	expect(consent.standingFor).toHaveBeenCalledTimes(2);
	expect(house.say.mock.calls[0][2]).toBe("I can see you, Thomas, Skylar and Eric. You look great!");
});

test("the gallery's full name matches, and a longer first name doesn't", () => {
	const gallery = [{ name: "Thomason Lee", kind: "person" }, { name: "Thomas Bryson", kind: "person" }];
	expect(camera.galleryEntry(gallery, thomas).name).toBe("Thomas Bryson");
});

test("seen: it speaks the fixed words, keeps the frame and finishes the step", async () => {
	const out = await camera.check(1, step, frame, { llm: llmSaying({ seen: ["Thomas"], doing_it: true, why: "waving" }) });
	expect(out).toMatchObject({ seen: true, spoke: true });
	expect(house.say.mock.calls[0][2]).toBe("I can see you, Thomas. You look great!");
	expect(missions.completeStep.mock.calls[0][2].proof).toMatchObject({ kind: "camera", camera: "Doorbell", people: ["Thomas"], photo: "photo" });
});

test("not seen on a look: no words, the step stays open, and it counts as a failed test", async () => {
	const out = await camera.check(1, step, frame, { llm: llmSaying({ seen: ["Thomas"], doing_it: false, why: "hands down" }) });
	expect(out.seen).toBe(false);
	expect(house.say).not.toHaveBeenCalled();
	expect(missions.completeStep).not.toHaveBeenCalled();
	expect(missions.recordTest).toHaveBeenCalledWith(1, "doorbell_camera", expect.objectContaining({ passed: false }));
});

test("an event showing someone else is no result at all", async () => {
	await camera.check(1, step, { ...frame, source: "event" }, { llm: llmSaying({ seen: [], doing_it: false, why: "a courier" }) });
	expect(missions.recordTest).not.toHaveBeenCalled();
	expect(missions.completeStep).not.toHaveBeenCalled();
});

test("a failed greeting doesn't undo what she saw", async () => {
	house.say.mockRejectedValue(new Error("control is off"));
	const out = await camera.check(1, step, frame, { llm: llmSaying({ seen: ["Thomas"], doing_it: true, why: "waving" }) });
	expect(out).toMatchObject({ seen: true, spoke: false });
	expect(missions.completeStep).toHaveBeenCalled();
});

test("she doesn't speak unless the mission lists it", async () => {
	missions.missionById.mockResolvedValue({ ...mission, capabilityIds: [1] });
	await camera.check(1, step, frame, { llm: llmSaying({ seen: ["Thomas"], doing_it: true, why: "waving" }) });
	expect(house.say).not.toHaveBeenCalled();
});

test("she doesn't look for someone who hasn't agreed", async () => {
	consent.standingFor.mockResolvedValue({ allowed: false });
	const llm = llmSaying({ seen: ["Thomas"], doing_it: true, why: "waving" });
	await expect(camera.check(1, step, frame, { llm })).rejects.toThrow("hasn't agreed");
	expect(llm.generateJson).not.toHaveBeenCalled();
});

test("the gate stands: a refused camera means no look", async () => {
	house.permit.mockRejectedValue(new Error("the kill switch is on"));
	const llm = llmSaying({ seen: ["Thomas"], doing_it: true, why: "waving" });
	await expect(camera.check(1, step, frame, { llm })).rejects.toThrow("kill switch");
	expect(llm.generateJson).not.toHaveBeenCalled();
});

test("a model outage records nothing", async () => {
	const llm = { generateJson: jest.fn(async () => { throw new Error("down"); }) };
	await expect(camera.check(1, step, frame, { llm })).rejects.toThrow("down");
	expect(missions.recordTest).not.toHaveBeenCalled();
});

test("a step that isn't open can't be finished", async () => {
	await expect(camera.check(1, { ...step, status: "stuck" }, frame, { llm: llmSaying({ seen: ["Thomas"], doing_it: true }) })).rejects.toThrow("isn't open");
});

test("an event on another camera is ignored", async () => {
	pool.query.mockResolvedValue([[{ uuid: "s", family_id: 1 }]]);
	const llm = llmSaying({ seen: ["Thomas"], doing_it: true, why: "waving" });
	expect(await camera.onEvent({ deviceName: "Backyard", deviceSn: "T2" }, "ZnJhbWU=", { llm })).toBe(0);
	expect(llm.generateJson).not.toHaveBeenCalled();
});

test("an event with no frame does nothing", async () => {
	expect(await camera.onEvent({ deviceName: "Doorbell" }, null, { llm: {} })).toBe(0);
	expect(pool.query).not.toHaveBeenCalled();
});

test("lookNow takes a fresh frame from the plan's camera", async () => {
	house.cameras.mockResolvedValue({ cameras: [{ name: "Doorbell", serial: "T1", freshSnapshot: true }] });
	eufyBridge.freshSnapshot.mockResolvedValue({ ok: true, jpeg: Buffer.from("x") });
	const out = await camera.lookNow(1, "s", { id: 2 }, { llm: llmSaying({ seen: ["Thomas"], doing_it: true, why: "waving" }) });
	expect(eufyBridge.freshSnapshot).toHaveBeenCalledWith("T1");
	expect(out.seen).toBe(true);
});
