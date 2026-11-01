const pool = require("../../helpers/db");
const debrief = require("./debrief");
const missions = require("./index");
const runner = require("./runner");
const scout = require("./scout");
const identity = require("./identity");

jest.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }));
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../guardianEngine/dispatch", () => ({ wakeAt: jest.fn() }));
jest.mock("../../helpers/crypto", () => ({ encrypt: jest.fn(), decrypt: jest.fn() }));

const STEP = "11111111-1111-4111-8111-111111111111";
const row = { id: 5, uuid: STEP, assigned_actor_id: 3, mission_id: 2, due_minutes: 30 };

beforeEach(() => {
	jest.restoreAllMocks();
	pool.query.mockReset();
});

describe("a Guardian with no phone", () => {
	const kid = { kind: "kid", profile_id: 3, guardian_credential_id: 9 };
	const step = { uuid: "s", instruction: "Find the card.", proof_required: "code" };
	const deliver = (result) => scout.deliverer({ sendToProfile: jest.fn(async () => result) })(kid, step);

	test("waiting in the app is not a sent push", async () => {
		expect(await deliver({ sent: 0, devices: 0, skipped: "no registered device" })).toMatchObject({ sent: 0, waiting: true, pushFailed: false });
	});

	test("a paired device that refused it is a failed push", async () => {
		expect(await deliver({ sent: 0, failed: 1, devices: 1 })).toMatchObject({ waiting: true, pushFailed: true });
	});

	test("a real push is a real push", async () => {
		const out = await deliver({ sent: 1, devices: 1 });
		expect(out.sent).toBe(1);
		expect(out.waiting).toBeUndefined();
	});
});

describe("stepSeen", () => {
	test("only their own step", async () => {
		pool.query.mockResolvedValueOnce([[row]]);
		await expect(missions.stepSeen(1, STEP, { id: 4 })).rejects.toThrow(/someone else/);
	});

	test("the clock starts once", async () => {
		pool.query.mockResolvedValueOnce([[row]]).mockResolvedValueOnce([{ affectedRows: 1 }]).mockResolvedValueOnce([[]]);
		expect(await missions.stepSeen(1, STEP, { id: 3 })).toBeInstanceOf(Date);
		pool.query.mockResolvedValueOnce([[row]]).mockResolvedValueOnce([{ affectedRows: 0 }]);
		expect(await missions.stepSeen(1, STEP, { id: 3 })).toBeNull();
	});
});

describe("a planned adult check", () => {
	const open = { ...row, uuid: STEP, status: "waiting_parent", proof_required: "parent_confirm", location_id: null };
	const statuses = () => pool.query.mock.calls.map(([sql]) => sql).filter((sql) => /UPDATE athena_gm_mission_step/.test(sql)).join(" ");
	const answer = (step, mission = { id: 2, status: "running", plan: null }) => async (sql) => {
		if (/FROM athena_gm_mission_step s\s+JOIN/.test(sql)) return [[step]];
		if (/FROM athena_gm_mission\b/.test(sql)) return [[mission]];
		return [[]];
	};

	test("needs no scouted place", async () => {
		pool.query.mockImplementation(answer(open));
		await scout.verify(1, STEP, { matches: true, actorId: 2 });
		expect(statuses()).toMatch(/status = 'done'/);
	});

	test("saying it didn't happen flags it rather than passing it", async () => {
		pool.query.mockImplementation(answer(open));
		await scout.verify(1, STEP, { matches: false, note: "Nobody went", actorId: 2 });
		expect(statuses()).toMatch(/status = 'stuck'/);
	});

	test("an adult's own step with no proof can be finished too", async () => {
		pool.query.mockImplementation(answer({ ...open, proof_required: "none", actor_kind: "parent" }));
		await scout.verify(1, STEP, { matches: true, actorId: 2 });
		expect(statuses()).toMatch(/status = 'done'/);
	});

	test("a kid's own proof can't be settled here", async () => {
		pool.query.mockImplementation(answer({ ...open, proof_required: "code" }));
		await expect(scout.verify(1, STEP, { matches: true, actorId: 2 })).rejects.toThrow(/isn't a verification/);
	});
});

describe("plans people can actually finish", () => {
	const actors = { ross: { kind: "parent" }, thomas: { kind: "kid" } };
	const plan = (over) => ({ steps: [{ key: "a", phase: "live", actor: "thomas", instruction: "Do the real thing here.", dueMinutes: 10, proof: "code", ...over }] });
	const problems = (over) => runner.validatePlan(plan(over), { capabilityKeys: ["clue_planning"], actors }).join(" ");

	test("a tap can't prove a tested tool", () => {
		expect(problems({ capability: "clue_planning", proof: "kid_confirm" })).toMatch(/tap on Done/);
		expect(problems({ capability: "clue_planning", proof: "none" })).toMatch(/tap on Done/);
		expect(problems({ capability: "clue_planning", proof: "parent_confirm" })).toBe("");
		expect(problems({ proof: "none" })).toBe("");
	});

	test("an adult can't be given a proof with no screen", () => {
		expect(problems({ actor: "ross", proof: "code" })).toMatch(/adult has no way/);
		expect(problems({ actor: "ross", proof: "photo" })).toMatch(/adult has no way/);
		expect(problems({ actor: "ross", proof: "parent_confirm" })).toBe("");
	});

	test("scouting photos need a paired phone, not just the app", () => {
		const flight = (contacts) => runner.preflight({
			mission: { approval_state: "approved", status: "running", family_id: 1 },
			steps: [{ assigned_actor_id: 3, proof_required: "photo_set" }],
			actors: [{ id: 3, kind: "kid", family_id: 1, display_name: "Thomas" }],
			agreements: { 3: { allowed: true } },
			contacts: { 3: contacts },
			capabilities: [{ cap_key: "push_notification", name: "Push", enabled: 1 }],
			control: {},
		}).join(" ");
		expect(flight([{ channel: "chat", reachable: true }])).toMatch(/paired phone/);
		expect(flight([{ channel: "push", reachable: true }])).toBe("");
	});
});

describe("taps aren't evidence", () => {
	const crit = { key: "c", kind: "all_steps_done", text: "Every step done", capability: "clue_planning" };
	const grade = (steps) => debrief.grade({ criteria: [crit], steps, predictions: [] }).results[0];
	const done = (over) => ({ status: "done", phase: "live", proof_required: "code", ...over });

	test("real proof counts", () => {
		expect(grade([done({ cap_key: "clue_planning" })])).toMatchObject({ passed: true, counted: true });
	});

	test("a tested tool that was only tapped doesn't", () => {
		const out = grade([done({ cap_key: "clue_planning", proof_required: "kid_confirm" }), done({})]);
		expect(out).toMatchObject({ passed: true, counted: false });
		expect(out.detail).toMatch(/only taps/);
	});

	test("nothing but taps doesn't, even with no tool named", () => {
		expect(grade([done({ proof_required: "none" })]).counted).toBe(false);
	});

	test("a story step tapped beside real proof is fine", () => {
		expect(grade([done({ proof_required: "none" }), done({ cap_key: "clue_planning" })]).counted).toBe(true);
	});

	test("a failure still counts, and prep doesn't matter", () => {
		expect(grade([{ status: "stuck", phase: "live", proof_required: "none" }])).toMatchObject({ passed: false, counted: true });
		expect(grade([done({ phase: "prep", proof_required: "none" }), done({ cap_key: "clue_planning" })]).counted).toBe(true);
	});

	test("a skill credit looks only at that person's steps", () => {
		const skill = { key: "s", kind: "person_steps_done", text: "Thomas finished", skill: "read_morse", actor: "thomas" };
		const steps = [done({ assigned_actor_id: 3 }), done({ assigned_actor_id: 4, proof_required: "none" })];
		expect(debrief.grade({ criteria: [skill], steps, predictions: [], actorIds: { thomas: 3 } }).results[0].counted).toBe(true);
		expect(debrief.grade({ criteria: [{ ...skill, actor: "skylar" }], steps, predictions: [], actorIds: { skylar: 4 } }).results[0].counted).toBe(false);
	});
});
