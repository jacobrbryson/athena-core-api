/**
 * Unit tests for the prompt builder's Guardian-Network onboarding support.
 * Run with the repo's configured test runner: `npm test` (jest).
 *
 * The memory service is mocked so these tests never touch the database — they
 * assert that companion mode layers in the guardian persona and that the
 * scripted opener is supplied to the model as a real `model` turn.
 */
jest.mock("../services/memory", () => ({
	getMemorySummaryForProfileId: jest.fn().mockResolvedValue([]),
}));

const { generatePrompt } = require("./prompt");

const guardianSession = { mode: "companion", age: 5, profile_id: null };

async function build(message, options) {
	return JSON.parse(await generatePrompt(guardianSession, [], message, options));
}

describe("generatePrompt — Guardian onboarding", () => {
	test("companion + guardian injects the Guardian-Network persona and first name", async () => {
		const contents = await build("hi", {
			guardian: { displayName: "Thomas Bryson", adventureKey: "lake_norman_guardians" },
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("Guardian Network");
		expect(system).toContain("Thomas"); // first name only
		expect(system).not.toContain("Bryson");
		expect(system).toContain("Lake Norman Guardians");
	});

	test("onboarding context adds the prior Athena line as a model turn before the user", async () => {
		const opener = "Before we begin… Say hello.";
		const contents = await build("hi", {
			guardian: { displayName: "Thomas", adventureKey: "lake_norman_guardians" },
			onboarding: { priorAthenaLine: opener, firstContact: true },
		});

		const roles = contents.map((c) => c.role);
		expect(roles).toEqual(["system", "model", "user"]);

		const modelTurn = contents.find((c) => c.role === "model");
		expect(modelTurn.parts[0].text).toBe(opener);

		const system = contents.find((c) => c.role === "system").parts[0].text;
		expect(system).toContain("First contact");
	});

	test("returning-guardian onboarding uses the notebook beat, no model turn without a prior line", async () => {
		const contents = await build("yes I did", {
			guardian: { displayName: "Thomas", adventureKey: "rescue_ratatouille" },
			onboarding: { priorAthenaLine: "", firstContact: false },
		});

		expect(contents.map((c) => c.role)).toEqual(["system", "user"]);
		const system = contents.find((c) => c.role === "system").parts[0].text;
		expect(system).toContain("Returning Guardian");
		expect(system).toContain("notebook");
	});

	test("non-guardian companion session has no Guardian-Network persona", async () => {
		const contents = await build("hello", {});
		const system = contents.find((c) => c.role === "system").parts[0].text;
		expect(system).not.toContain("Guardian Network");
		expect(system).toContain("5"); // generic age framing retained
	});
});
