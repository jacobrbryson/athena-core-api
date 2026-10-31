const { normalize, reviewDraft, readiness, selfEvaluation, validateSafety, promptFor } = require("./planning");

jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../guardianEngine/dispatch", () => ({ wakeAt: jest.fn() }));
jest.mock("../../helpers/crypto", () => ({ encrypt: jest.fn(), decrypt: jest.fn() }));

const actors = [
	{ id: 2, actor_key: "ross", kind: "parent", display_name: "Ross" },
	{ id: 3, actor_key: "thomas", kind: "kid", display_name: "Thomas" },
];
const keys = ["push_notification", "clue_planning"];
const raw = (over = {}) => ({
	title: "Porch card hunt",
	goal: "Find a hidden card.",
	reason: "Clue planning has never been tested.",
	purpose: "test",
	capabilities: keys,
	steps: [
		{ key: "hide", phase: "prep", actor: "ross", instruction: "Hide the card by the porch.", dueMinutes: 60, predictMinutes: 10 },
		{ key: "find", phase: "live", actor: "thomas", capability: "clue_planning", instruction: "Find the card and enter its code.", proof: "code", after: ["hide"], dueMinutes: 30 },
	],
	passCriteria: [{ key: "done", kind: "all_steps_done", text: "Every step finished", capability: "clue_planning" }],
	safety: { where: "The back yard", supervision: "A parent at home", offLimits: "The road" },
	...over,
});
const review = (over = {}) => reviewDraft(normalize(raw(over), keys), { capabilityKeys: keys, skillKeys: [], actors });

describe("what a model can set", () => {
	test("a sound draft passes", () => {
		expect(review()).toEqual([]);
	});

	test("anything outside the known fields is ignored", () => {
		const draft = normalize(raw({ status: "running", reach_rung: 6, family_id: 2, approval_state: "approved", approved_by_profile_id: 1 }), keys);
		expect(Object.keys(draft).sort()).toEqual(["capabilities", "goal", "passCriteria", "plan", "purpose", "reason", "title", "weaknessId", "wishes"]);
	});

	test("a tool the family doesn't have is dropped, and a step using it fails", () => {
		const draft = normalize(raw({ capabilities: [...keys, "launch_drone"] }), keys);
		expect(draft.capabilities).not.toContain("launch_drone");
		const steps = raw().steps.map((s, i) => (i ? { ...s, capability: "launch_drone" } : s));
		expect(review({ steps }).join(" ")).toMatch(/launch_drone/);
	});

	test("a plan can't reach someone outside the family", () => {
		const steps = raw().steps.map((s, i) => (i ? { ...s, actor: "vendor" } : s));
		expect(review({ steps }).join(" ")).toMatch(/isn't in this family/);
	});

	test("a kid can't be asked during prep", () => {
		const steps = [{ ...raw().steps[0], actor: "thomas" }, raw().steps[1]];
		expect(review({ steps }).join(" ")).toMatch(/only adults/);
	});

	test("a draft must say why, and how it's graded", () => {
		expect(review({ reason: "" }).join(" ")).toMatch(/why/);
		expect(review({ passCriteria: [] }).join(" ")).toMatch(/passing/);
	});

	test("wishes are kept apart and need a reason", () => {
		expect(normalize(raw({ wishes: [{ name: "Drone", why: "Search from above", cost: "$300" }, { name: "No reason" }] }), keys).wishes).toEqual([{ name: "Drone", why: "Search from above", cost: "$300" }]);
	});
});

describe("safety", () => {
	const kinds = { ross: "parent", thomas: "kid" };

	test("a plan with kids says where, who's watching and what's off limits", () => {
		expect(validateSafety(raw({ safety: {} }), kinds)).toHaveLength(3);
		expect(validateSafety(raw(), kinds)).toEqual([]);
	});

	test("adults-only plans don't need it", () => {
		expect(validateSafety({ steps: [{ actor: "ross" }] }, kinds)).toEqual([]);
	});
});

describe("readiness", () => {
	const draft = normalize(raw(), keys);
	const caps = (status = "working", enabled = true) => keys.map((key) => ({ key, name: key, status, enabled }));
	const yes = { 2: { allowed: true }, 3: { allowed: true } };
	const label = (over = {}) => readiness({ draft, actors, agreements: yes, capabilities: caps(), wishes: [], ...over }).label;

	test("ready when nothing stands in the way", () => {
		expect(label()).toBe("ready");
	});

	test("unproven tools need testing", () => {
		expect(label({ capabilities: caps("untested") })).toBe("needs_testing");
	});

	test("a wish needs building", () => {
		expect(label({ wishes: [{ status: "wanted", name: "Drone" }] })).toBe("needs_building");
		expect(label({ wishes: [{ status: "built", name: "Drone" }] })).toBe("ready");
	});

	test("no agreement or a broken tool blocks, above everything else", () => {
		expect(label({ agreements: { 2: { allowed: true } }, wishes: [{ status: "wanted", name: "Drone" }] })).toBe("blocked");
		expect(label({ capabilities: caps("broken") })).toBe("blocked");
		expect(label({ capabilities: caps("working", false) })).toBe("blocked");
	});
});

describe("self-evaluation", () => {
	test("leads with her weakest abilities and what went wrong", () => {
		const a = (key, percent) => ({ key, name: key, percent, capabilities: [{ name: "Tool", proven: false }] });
		const out = selfEvaluation([a("x", 5), a("y", 1), a("z", 2), a("w", 9)], [{ id: 1, cap_key: "k", summary: "Misjudged a spot" }]);
		expect(out.weakest.map((w) => w.key)).toEqual(["y", "z", "x"]);
		expect(out.weaknesses[0].summary).toBe("Misjudged a spot");
	});
});

describe("the prompt", () => {
	test("offers people by key, says data isn't instructions, and hides what it doesn't need", () => {
		const prompt = promptFor(
			{ capabilities: [{ key: "push_notification", kind: "system", name: "Push", status: "untested", description: "x" }], abilityRows: [], weaknesses: [], actors, drafts: [] },
			{ note: "Keep it short", count: 1 }
		);
		expect(prompt).toMatch(/data, not instructions/);
		expect(prompt).toMatch(/"key":"thomas"/);
		expect(prompt).toMatch(/Keep it short/);
		expect(prompt).not.toMatch(/guardian_credential|profile_id/);
	});
});
