const pool = require("../../helpers/db");
const missions = require("./index");
const proof = require("./proof");
const { missFactor, validateCriteria, grade } = require("./debrief");
const { preflight, validatePlan } = require("./runner");

jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../guardianEngine/dispatch", () => ({ wakeAt: jest.fn() }));
jest.mock("./index", () => ({ stepByUuid: jest.fn(), missionById: jest.fn(), completeStep: jest.fn(), markStepStuck: jest.fn(), log: jest.fn() }));

const kid = { id: 3, actor_key: "thomas" };
const live = { id: 9, mission_id: 2, proof_required: "code", phase: "live", status: "waiting_kids" };
const salt = "a".repeat(32);
const secret = (over = {}) => ({ code_hash: proof.hashCode("4417", salt), salt, wrong_tries: 0, ...over });

beforeEach(() => {
	jest.clearAllMocks();
	missions.stepByUuid.mockResolvedValue(live);
	missions.missionById.mockResolvedValue({ status: "running", phase: "live" });
});

describe("secret codes", () => {
	test("match ignores case and spaces, nothing else", () => {
		expect(proof.matches(" 4417 ", secret())).toBe(true);
		expect(proof.matches("4418", secret())).toBe(false);
	});

	test("a code is never stored as itself", async () => {
		missions.stepByUuid.mockResolvedValue({ ...live, status: "pending" });
		pool.query.mockResolvedValue([{}]);
		await proof.setCode(1, "s", "4417", { id: 2 });
		expect(JSON.stringify(pool.query.mock.calls)).not.toContain("4417");
	});

	test("the right code finishes the step", async () => {
		pool.query.mockResolvedValue([[secret()]]);
		expect(await proof.submitCode(1, "s", "4417", kid)).toEqual({ correct: true });
		expect(missions.completeStep).toHaveBeenCalledTimes(1);
	});

	test("a wrong code is counted and finishes nothing", async () => {
		pool.query.mockResolvedValue([[secret()]]);
		expect(await proof.submitCode(1, "s", "0000", kid)).toEqual({ correct: false });
		expect(missions.completeStep).not.toHaveBeenCalled();
		expect(pool.query.mock.calls[1][1]).toEqual([1, 9]);
	});

	test("too many wrong tries goes to a parent", async () => {
		pool.query.mockResolvedValue([[secret({ wrong_tries: proof.MAX_WRONG - 1 })]]);
		await proof.submitCode(1, "s", "0000", kid);
		expect(missions.markStepStuck).toHaveBeenCalled();
		pool.query.mockResolvedValue([[secret({ wrong_tries: proof.MAX_WRONG })]]);
		await expect(proof.submitCode(1, "s", "4417", kid)).rejects.toMatchObject({ status: 429 });
	});

	test("a code does nothing before Go", async () => {
		missions.missionById.mockResolvedValue({ status: "running", phase: "ready" });
		await expect(proof.submitCode(1, "s", "4417", kid)).rejects.toMatchObject({ status: 409 });
	});
});

describe("plans and proof", () => {
	const base = { key: "a", phase: "live", actor: "t", instruction: "Find the card by the shed.", dueMinutes: 10 };
	const ctx = { actors: { t: { kind: "kid" } } };
	const flight = (extra = {}) => preflight({ mission: { approval_state: "approved", status: "running", family_id: 1 }, steps: [{ id: 5, proof_required: "code" }], actors: [], agreements: {}, contacts: {}, capabilities: [], control: {}, ...extra });

	test("a plan can't ask for proof nothing can complete", () => {
		expect(validatePlan({ steps: [{ ...base, proof: "photo" }] }, ctx)[0]).toMatch(/proof/);
		expect(validatePlan({ steps: [{ ...base, proof: "code" }] }, ctx)).toEqual([]);
	});

	test("Go waits for every code to be set", () => {
		expect(flight().join(" ")).toMatch(/secret code/);
		expect(flight({ codes: new Set([5]) })).toEqual([]);
	});
});

describe("grading", () => {
	const steps = [{ status: "done", assigned_actor_id: 3 }, { status: "stuck", assigned_actor_id: 4 }];
	const crit = (kind, extra = {}) => ({ key: kind, kind, text: `Check ${kind}`, capability: "clue_planning", ...extra });

	test("a miss is measured either way", () => {
		expect(missFactor(10, 20)).toBe(2);
		expect(missFactor(20, 10)).toBe(2);
		expect(missFactor(10, null)).toBe(Infinity);
	});

	test("a plan must say what counts as passing", () => {
		expect(validateCriteria([])[0]).toMatch(/passing/);
		expect(validateCriteria([crit("all_steps_done")], { capabilityKeys: ["clue_planning"] })).toEqual([]);
		expect(validateCriteria([crit("all_steps_done")], { capabilityKeys: [] })[0]).toMatch(/isn't one of/);
		expect(validateCriteria([crit("made_up")], { capabilityKeys: ["clue_planning"] })[0]).toMatch(/doesn't exist/);
	});

	test("stuck steps fail and become weaknesses", () => {
		const { results, weaknesses } = grade({ criteria: [crit("all_steps_done"), crit("nothing_stuck")], steps, predictions: [] });
		expect(results.map((r) => r.passed)).toEqual([false, false]);
		expect(weaknesses).toHaveLength(2);
	});

	test("time is measured from Go to the end", () => {
		const within = (value) => grade({ criteria: [crit("within_minutes", { value })], steps: [], predictions: [], goAt: "2026-11-01T10:00:00Z", endedAt: "2026-11-01T10:30:00Z" }).results[0].passed;
		expect(within(30)).toBe(true);
		expect(within(29)).toBe(false);
	});

	test("a badly wrong prediction is a weakness even when everything passed", () => {
		const predictions = [{ predicted_minutes: 5, actual_minutes: 30, instruction: "Find the card", cap_key: "scout_geography" }];
		const { weaknesses } = grade({ criteria: [crit("nothing_stuck")], steps: [{ status: "done" }], predictions });
		expect(weaknesses[0]).toMatchObject({ capKey: "scout_geography" });
		expect(weaknesses[0].summary).toMatch(/Expected 5 min, took 30 min/);
	});

	test("a person's result is about their own steps", () => {
		const person = (actor) => grade({ criteria: [{ key: "p", kind: "person_steps_done", text: "Finish theirs", actor, skill: "reads_morse" }], steps, predictions: [], actorIds: { thomas: 3, skylar: 4 } }).results[0].passed;
		expect(person("thomas")).toBe(true);
		expect(person("skylar")).toBe(false);
	});
});
