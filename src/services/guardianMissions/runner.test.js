const { mayUse } = require("./gate");
const { validatePlan, nextSteps, phaseDone, preflight } = require("./runner");

jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../guardianEngine/dispatch", () => ({ wakeAt: jest.fn() }));

const actors = { ross: { kind: "parent" }, thomas: { kind: "kid" } };
const step = (over = {}) => ({ key: "hide", phase: "prep", actor: "ross", instruction: "Hide the box behind the shed.", dueMinutes: 60, ...over });
const check = (steps, capabilityKeys = ["push_notification"]) => validatePlan({ steps }, { capabilityKeys, actors });

describe("validatePlan", () => {
	test("a sound plan has no problems", () => {
		expect(check([step(), step({ key: "find", phase: "live", actor: "thomas", after: ["hide"], capability: "push_notification" })])).toEqual([]);
	});

	test("an empty plan can't run", () => {
		expect(validatePlan({ steps: [] })).toHaveLength(1);
		expect(validatePlan(null)).toHaveLength(1);
	});

	test("a plan can only use what the mission lists", () => {
		expect(check([step({ capability: "porch_light" })])[0]).toMatch(/isn't one of this mission's/);
	});

	test("a plan can't add someone from outside the family", () => {
		expect(check([step({ actor: "stranger" })])[0]).toMatch(/isn't in this family/);
	});

	test("a kid can't be part of prep", () => {
		expect(check([step({ actor: "thomas" })])[0]).toMatch(/only adults/);
	});

	test("prep can't wait on live", () => {
		const problems = check([step({ after: ["find"] }), step({ key: "find", phase: "live", actor: "thomas" })]);
		expect(problems.join(" ")).toMatch(/can't wait on a live step/);
	});

	test("steps can't wait on each other in a circle", () => {
		const problems = check([step({ key: "a", after: ["b"] }), step({ key: "b", after: ["a"] })]);
		expect(problems[0]).toMatch(/circle/);
	});

	test("every step needs a deadline, an instruction and a real proof", () => {
		expect(check([step({ dueMinutes: 0 })])[0]).toMatch(/deadline/);
		expect(check([step({ instruction: "go" })])[0]).toMatch(/instruction/);
		expect(check([step({ proof: "vibes" })])[0]).toMatch(/proof/);
	});
});

describe("nextSteps", () => {
	const s = (plan_key, status, after = [], phase = "prep") => ({ plan_key, status, phase, after_keys: JSON.stringify(after) });

	test("a step opens only when what it follows is done", () => {
		const steps = [s("a", "done"), s("b", "pending", ["a"]), s("c", "pending", ["b"])];
		expect(nextSteps(steps, "prep").map((x) => x.plan_key)).toEqual(["b"]);
	});

	test("steps with nothing before them open together", () => {
		expect(nextSteps([s("a", "pending"), s("b", "pending")], "prep")).toHaveLength(2);
	});

	test("live steps stay shut during prep", () => {
		expect(nextSteps([s("a", "pending", [], "live")], "prep")).toEqual([]);
	});

	test("a phase is done when all its steps are", () => {
		expect(phaseDone([s("a", "done"), s("b", "pending", [], "live")], "prep")).toBe(true);
		expect(phaseDone([s("a", "stuck")], "prep")).toBe(false);
	});
});

describe("preflight", () => {
	const ross = { id: 2, kind: "parent", family_id: 1, display_name: "Ross" };
	const thomas = { id: 3, kind: "kid", family_id: 1, display_name: "Thomas" };
	const jenny = { id: 6, kind: "parent", family_id: 2, display_name: "Jenny" };
	const lena = { id: 7, kind: "kid", family_id: 2, display_name: "Lena" };
	const base = () => ({
		mission: { approval_state: "approved", status: "running", family_id: 1 },
		steps: [{ assigned_actor_id: 3 }],
		actors: [ross, thomas],
		agreements: { 2: { allowed: true }, 3: { allowed: true } },
		contacts: { 3: [{ reachable: true }] },
		capabilities: [{ cap_key: "push_notification", name: "Push", enabled: 1, status: "working", house_control: 0 }],
		control: { mode: "running", kill_switch: 0 },
		supervisor: ross,
	});

	test("clear when everything holds", () => {
		expect(preflight(base())).toEqual([]);
	});

	test("someone who hasn't agreed stops Go", () => {
		expect(preflight({ ...base(), agreements: { 2: { allowed: true } } }).join(" ")).toMatch(/Thomas hasn't agreed/);
	});

	test("someone who can't be reached stops Go", () => {
		expect(preflight({ ...base(), contacts: {} }).join(" ")).toMatch(/no way to reach Thomas/);
	});

	test("a pause, a disabled tool or the kill switch stops Go", () => {
		expect(preflight({ ...base(), control: { mode: "paused" } })).toContain("Athena is paused.");
		const off = { ...base(), capabilities: [{ cap_key: "push_notification", name: "Push", enabled: 0 }] };
		expect(preflight(off).join(" ")).toMatch(/switched off/);
		const light = { ...base(), control: { kill_switch: 1 }, capabilities: [...base().capabilities, { cap_key: "porch_light", name: "Porch light", enabled: 1, house_control: 1 }] };
		expect(preflight(light).join(" ")).toMatch(/kill switch/);
	});

	test("the supervisor must be an agreed adult in this family", () => {
		expect(preflight({ ...base(), supervisor: thomas }).join(" ")).toMatch(/adult in this family/);
		expect(preflight({ ...base(), supervisor: jenny }).join(" ")).toMatch(/adult in this family/);
	});

	test("another family's kid stops Go", () => {
		const plan = { ...base(), steps: [{ assigned_actor_id: 7 }], actors: [ross, thomas, lena], agreements: { 2: { allowed: true }, 7: { allowed: true } }, contacts: { 7: [{ reachable: true }] } };
		expect(preflight(plan).join(" ")).toMatch(/another family/);
	});
});

describe("the gate and Go", () => {
	const cap = { id: 1, name: "Push", enabled: 1 };
	const kid = { kind: "kid", display_name: "Thomas" };
	const mission = (phase) => ({ status: "running", approval_state: "approved", capabilityIds: [1], phase });

	test("a kid hears nothing before Go, and only after", () => {
		for (const phase of ["prep", "ready", "debrief", undefined]) {
			expect(mayUse({ control: null, capability: cap, mission: mission(phase), recipient: kid, consent: { allowed: true } }).verdict).toBe("refuse");
		}
		expect(mayUse({ control: null, capability: cap, mission: mission("live"), recipient: kid, consent: { allowed: true } }).verdict).toBe("allow");
	});

	test("an adult can be asked during prep", () => {
		expect(mayUse({ control: null, capability: cap, mission: mission("prep"), recipient: { kind: "parent", display_name: "Ross" }, consent: { allowed: true } }).verdict).toBe("allow");
	});
});
