const story = require("./story");
const { normalize, reviewDraft, readiness, promptFor } = require("./planning");
const scout = require("./scout");

jest.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }));
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../guardianEngine/dispatch", () => ({ wakeAt: jest.fn() }));
jest.mock("../../helpers/crypto", () => ({ encrypt: jest.fn(), decrypt: jest.fn() }));

const kinds = { ross: "parent", thomas: "kid" };
const quest = (over = {}) => ({
	story: { title: "The Dark Signal", premise: "A signal went quiet near the old gate. The Network needs eyes on the ridge.", reveal: "This quest helped Athena practice reading photos of your yard. Thank you." },
	safety: { where: "Yard", supervision: "Ross", offLimits: "The road" },
	steps: [
		{ key: "hide", phase: "prep", actor: "ross", instruction: "Hide the box behind the shed." },
		{ key: "survey", phase: "live", actor: "thomas", instruction: "Take four photos so Athena can test scouting.", quest: "Survey the ridge in all four directions and report back." },
	],
	...over,
});
const withStory = (fn) => { const plan = quest(); fn(plan); return plan; };

describe("the kids' words", () => {
	test("a sound quest passes", () => {
		expect(story.validateStory(quest(), kinds)).toEqual([]);
	});

	test("a plan with no kid needs no story", () => {
		expect(story.validateStory({ steps: [{ key: "a", actor: "ross" }] }, kinds)).toEqual([]);
	});

	test("a kid step with no story or quest can't go ahead", () => {
		expect(story.validateStory(quest({ story: null }), kinds)[0]).toMatch(/no quest story/);
		const plan = withStory((p) => { p.steps[1].quest = null; });
		expect(story.validateStory(plan, kinds)[0]).toMatch(/no quest wording/);
	});

	test("the test can't show in anything a kid reads", () => {
		const plan = withStory((p) => { p.steps[1].quest = "Help Athena test her scouting tool by taking photos."; });
		expect(story.validateStory(plan, kinds)[0]).toMatch(/gives away the test/);
		expect(story.validateStory(quest({ story: { ...quest().story, title: "Training day" } }), kinds)[0]).toMatch(/gives away the test/);
	});

	test("a story can't cut adults out, even with a curly apostrophe", () => {
		for (const words of ["Don’t tell your parents about the ridge.", "Keep this a secret from everyone at home.", "Sneak out to the ridge and look."]) {
			const plan = withStory((p) => { p.steps[1].quest = words; });
			expect(story.validateStory(plan, kinds).join(" ")).toMatch(/cuts adults out/);
		}
	});

	test("a story can't push a kid past a safety limit", () => {
		const plan = withStory((p) => { p.steps[1].quest = "Go alone to the ridge and watch for the signal."; });
		expect(story.validateStory(plan, kinds)[0]).toMatch(/safety limit/);
	});

	test("a secret code is still fine", () => {
		expect(story.kidWordsProblem("Find the secret code on the old post.")).toBeNull();
	});

	test("the plan has to tell them afterwards", () => {
		const plan = quest({ story: { ...quest().story, reveal: "The end." } });
		expect(story.validateStory(plan, kinds)[0]).toMatch(/afterwards/);
	});
});

describe("what a kid is given", () => {
	test("the quest, never the real title or instruction, and the safety rules in plain words", () => {
		const out = story.forKid(quest(), { planKey: "survey", title: "Test scouting", instruction: "Take four photos so Athena can test scouting." });
		expect(out.mission).toBe("The Dark Signal");
		expect(out.instruction).toMatch(/^Survey the ridge/);
		expect(JSON.stringify(out)).not.toMatch(/test scouting|reveal|helped Athena/i);
		expect(out.safety.offLimits).toBe("The road");
	});

	test("a step with no plan keeps its own words", () => {
		expect(story.forKid(null, { title: "Scout", instruction: "Take the photos." })).toMatchObject({ mission: "Scout", instruction: "Take the photos." });
	});

	const pushed = async (actor) => {
		const push = { sendToProfile: jest.fn(async () => ({ sent: 1 })) };
		await scout.deliverer(push)(actor, { uuid: "s", plan_key: "survey", cap_key: "scout_geography", proof_required: "photo_set", instruction: "Take four photos so Athena can test scouting.", mission_plan: JSON.stringify(quest()) });
		return push.sendToProfile.mock.calls[0][1];
	};

	test("a kid's push carries the quest, a parent's the real ask", async () => {
		const kid = await pushed({ kind: "kid", profile_id: 3 });
		expect(kid.body).toMatch(/^Survey the ridge/);
		expect(kid.title).toBe("Athena");
		expect((await pushed({ kind: "parent", profile_id: 2 })).body).toMatch(/test scouting/);
	});
});

describe("planning", () => {
	const actors = [{ actor_key: "ross", kind: "parent" }, { actor_key: "thomas", kind: "kid" }];
	const raw = () => {
		const plan = quest();
		return {
			title: "Test scouting",
			goal: "See if scouting works.",
			reason: "It's unproven.",
			capabilities: ["push_notification"],
			story: plan.story,
			safety: plan.safety,
			steps: plan.steps.map((s) => ({ ...s, dueMinutes: 30 })),
			passCriteria: [{ key: "d", kind: "all_steps_done", text: "It got done", capability: "push_notification" }],
		};
	};
	const review = (draft) => reviewDraft(normalize(draft, ["push_notification"]), { skillKeys: [], actors });

	test("a draft keeps its story, and prep steps never carry a quest", () => {
		const input = raw();
		input.steps[0].quest = "Hide the treasure for the Guardians.";
		const { plan } = normalize(input, ["push_notification"]);
		expect(plan.story.title).toBe("The Dark Signal");
		expect(plan.steps[0].quest).toBeNull();
		expect(plan.steps[1].quest).toMatch(/^Survey/);
	});

	test("a draft with a kid and no story is dropped", () => {
		expect(review(raw())).toEqual([]);
		expect(review({ ...raw(), story: undefined }).join(" ")).toMatch(/no quest story/);
	});

	test("an older draft shows as blocked until it's revised", () => {
		const out = readiness({ draft: { plan: quest({ story: null }), capabilities: [] }, actors, agreements: {}, capabilities: [], wishes: [] });
		expect(out.label).toBe("blocked");
		expect(out.reasons[0]).toMatch(/no quest story/);
	});

	test("she's told the rules, and never to improvise a hint", () => {
		const prompt = promptFor({ capabilities: [], abilityRows: [], weaknesses: [], actors, drafts: [], zones: [] }, { count: 1 });
		expect(prompt).toMatch(/You find\. I read\./);
		expect(prompt).toMatch(/never improvise one/);
		expect(prompt).toMatch(/exactly the same real action/);
	});
});
