const pool = require("../../helpers/db");
const missions = require("./index");
const partners = require("./partners");
const settings = require("./settings");
const proof = require("./proof");
const runner = require("./runner");
const consent = require("./consent");
const { validPrint, similarity, bestMatch } = require("./voiceprints");

jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../guardianEngine/dispatch", () => ({ wakeAt: jest.fn() }));
jest.mock("../../helpers/crypto", () => ({ encrypt: jest.fn(), decrypt: jest.fn() }));
jest.mock("./scout", () => ({ storeProofPhoto: jest.fn(async () => ({ uuid: "p", path: "gs://b/p" })) }));
jest.mock("./index", () => ({
	missionByUuid: jest.fn(),
	missionById: jest.fn(),
	stepByUuid: jest.fn(),
	completeStep: jest.fn(),
	recordTest: jest.fn(),
	stopMission: jest.fn(),
	log: jest.fn(),
	control: jest.fn(),
}));

beforeEach(() => {
	jest.clearAllMocks();
	pool.query.mockReset();
	delete process.env.GM_TEMPLATES_ENABLED;
	delete process.env.GM_CONSENT_ENFORCED;
});

describe("switches", () => {
	const owner = { id: 2, can_create_templates: 1 };

	test("a saved setting turns one on, and a failed read counts as off", async () => {
		pool.query.mockResolvedValue([[{ enabled: 1 }]]);
		expect(await settings.isOn("templates")).toBe(true);
		pool.query.mockRejectedValue(new Error("down"));
		expect(await settings.isOn("templates")).toBe(false);
	});

	test("only the owner can flip one", async () => {
		await expect(settings.setSwitch("templates", true, { id: 6, can_create_templates: 0 })).rejects.toMatchObject({ status: 403 });
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("chat consent refuses while Guardians can't agree", async () => {
		pool.query.mockResolvedValueOnce([[{ n: 9 }]]);
		await expect(settings.setSwitch("chat_consent", true, owner)).rejects.toThrow(/9 Guardians/);
	});

	test("chat consent can always be turned off", async () => {
		pool.query.mockResolvedValue([{}]);
		await settings.setSwitch("chat_consent", false, owner);
		expect(pool.query).toHaveBeenCalledTimes(1);
	});
});

describe("partner families", () => {
	test("a partner's kid is named with their family, and home kids plainly", () => {
		expect(partners.planKey({ actor_key: "thomas", family_id: 1 }, 1)).toBe("thomas");
		expect(partners.planKey({ actor_key: "lena", family_id: 2 }, 1)).toBe("lena@2");
	});

	test("only accepted families' people can be named", async () => {
		pool.query.mockResolvedValue([[]]);
		await partners.people({ id: 5, family_id: 1 });
		expect(pool.query.mock.calls[0][0]).toMatch(/status = 'accepted'/);
	});

	test("an invitation can only be answered while open, by that family", async () => {
		pool.query.mockResolvedValue([[]]);
		await expect(partners.respond(3, "m", true, { id: 9 })).rejects.toMatchObject({ status: 404 });
		pool.query.mockResolvedValue([[{ status: "declined", id: 5, family_id: 1 }]]);
		await expect(partners.respond(2, "m", true, { id: 6 })).rejects.toMatchObject({ status: 409 });
	});

	test("leaving cancels their kids' asks and stops the mission", async () => {
		pool.query.mockResolvedValueOnce([[{ status: "accepted", id: 5, family_id: 1, uuid: "m", mission_status: "running" }]]).mockResolvedValue([{}]);
		await partners.leave(2, "m", { id: 6 });
		expect(pool.query.mock.calls[2][0]).toMatch(/status = 'declined'/);
		expect(missions.stopMission).toHaveBeenCalledWith(1, "m", expect.objectContaining({ reason: "a family left" }));
	});

	test("a kid can act on their own family's step or one assigned to them, nothing else", async () => {
		const kid = { id: 7, family_id: 2 };
		pool.query.mockResolvedValueOnce([[{ family_id: 1, assigned_actor_id: 7 }]]);
		expect(await partners.stepFamilyFor(kid, "s")).toBe(1);
		pool.query.mockResolvedValueOnce([[{ family_id: 1, assigned_actor_id: 3 }]]);
		await expect(partners.stepFamilyFor(kid, "s")).rejects.toMatchObject({ status: 403 });
	});
});

describe("photo proof", () => {
	const image = Buffer.alloc(2000).toString("base64");
	const open = { id: 9, uuid: "s", mission_id: 2, proof_required: "photo", status: "waiting_kids", instruction: "Show the card." };
	const kid = { id: 3, actor_key: "thomas" };
	const llm = (data) => ({ generateJson: jest.fn(async () => ({ data })) });

	beforeEach(() => {
		missions.stepByUuid.mockResolvedValue(open);
		missions.missionById.mockResolvedValue({ status: "running" });
		pool.query.mockResolvedValue([{}]);
	});

	test("a photo that shows it finishes the step", async () => {
		expect(await proof.submitPhoto(1, "s", { imageBase64: image }, kid, llm({ shows_it: true, why: "It shows the card." }))).toEqual({ correct: true });
		expect(missions.completeStep).toHaveBeenCalledTimes(1);
		expect(missions.recordTest).toHaveBeenCalledWith(1, "photo_proof", expect.objectContaining({ passed: true }));
	});

	test("one that doesn't says why, and the step stays open", async () => {
		const out = await proof.submitPhoto(1, "s", { imageBase64: image }, kid, llm({ shows_it: false, why: "No card." }));
		expect(out).toEqual({ correct: false, why: "No card." });
		expect(missions.completeStep).not.toHaveBeenCalled();
	});

	test("a model outage records nothing against her", async () => {
		const down = { generateJson: jest.fn(async () => { throw new Error("down"); }) };
		await expect(proof.submitPhoto(1, "s", { imageBase64: image }, kid, down)).rejects.toMatchObject({ status: 503 });
		expect(missions.recordTest).not.toHaveBeenCalled();
	});

	test("an empty photo or a closed step is refused", async () => {
		await expect(proof.submitPhoto(1, "s", { imageBase64: "" }, kid, llm({}))).rejects.toThrow(/empty/);
		missions.stepByUuid.mockResolvedValue({ ...open, status: "pending" });
		await expect(proof.submitPhoto(1, "s", { imageBase64: image }, kid, llm({}))).rejects.toMatchObject({ status: 409 });
	});
});

describe("kid Go", () => {
	const kid = { id: 3, family_id: 1, kind: "kid", actor_key: "thomas", display_name: "Thomas" };
	const go = () => runner.kidGo(kid, "m", { deliver: jest.fn(), tellAdults: jest.fn() });

	test("refused unless a template allows it and they're in the plan", async () => {
		pool.query.mockResolvedValue([[]]);
		await expect(go()).rejects.toMatchObject({ status: 403 });
		pool.query.mockResolvedValue([[{ uuid: "m", plan: '{"steps":[{"actor":"skylar"}]}' }]]);
		await expect(go()).rejects.toMatchObject({ status: 403 });
	});

	test("the query only finds live templates that allow it", async () => {
		pool.query.mockResolvedValue([[]]);
		await runner.kidGoMissions(kid);
		expect(pool.query.mock.calls[0][0]).toMatch(/allow_kid_go = 1 AND t\.retired_at IS NULL/);
	});

	test("refused while templates are switched off", async () => {
		pool.query.mockImplementation(async (sql) => (/athena_gm_template/.test(sql) ? [[{ uuid: "m", plan: '{"steps":[{"actor":"thomas"}]}' }]] : [[{ enabled: 0 }]]));
		await expect(go()).rejects.toMatchObject({ status: 403 });
		expect(consent.FIXED_REPLY).toBeTruthy();
	});
});

describe("voice matching", () => {
	const v = (...n) => [...n, ...Array(64 - n.length).fill(0)];

	test("prints must be real vectors of a sensible size", () => {
		expect(validPrint(v(1))).toBe(true);
		expect(validPrint([1, 2])).toBe(false);
		expect(validPrint(v(NaN))).toBe(false);
		expect(validPrint("audio")).toBe(false);
	});

	test("same voice is alike, unrelated isn't, and different models don't compare", () => {
		expect(similarity(v(1, 0), v(2, 0))).toBeCloseTo(1);
		expect(similarity(v(1, 0), v(0, 1))).toBe(0);
		expect(similarity([1, 2], [1, 2, 3])).toBe(0);
	});

	test("names someone only when clearly ahead", () => {
		const known = [{ actorId: 3, print: v(1, 0) }, { actorId: 4, print: v(0, 1) }];
		expect(bestMatch(v(1, 0.05), known).actorId).toBe(3);
		expect(bestMatch(v(0, 0, 1), known)).toBeNull();
		const twins = [{ actorId: 3, print: v(1, 0) }, { actorId: 4, print: v(1, 0.01) }];
		expect(bestMatch(v(1, 0), twins)).toBeNull();
	});
});
