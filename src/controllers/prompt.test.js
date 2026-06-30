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

	test("Lake Norman guardian persona includes the field kit knowledge", async () => {
		const contents = await build("what's in my box?", {
			guardian: { displayName: "Thomas", adventureKey: "lake_norman_guardians" },
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("field kit");
		expect(system).toContain("blacklight");
		expect(system).toContain("two coins");
		expect(system).toContain("compass");
	});

	test("adventures without a defined kit get no field-kit block", async () => {
		const contents = await build("hi", {
			guardian: { displayName: "Erika", adventureKey: "rescue_ratatouille" },
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("Guardian Network"); // persona still applied
		expect(system).not.toContain("field kit");
	});

	test("mission context layers in Current Mission steering with pending families", async () => {
		const contents = await build("what should I do?", {
			guardian: { displayName: "Thomas", adventureKey: "lake_norman_guardians" },
			mission: {
				title: "Gather the Guardians",
				directive: "Encourage this Guardian to reach out to other Guardians.",
				pendingFamilies: ["The Morgan Family (Charlotte)", "The Abassi Family (Mooresville)"],
			},
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("Current Mission: Gather the Guardians");
		expect(system).toContain("reach out to other Guardians");
		expect(system).toContain("The Morgan Family (Charlotte)");
		expect(system).toContain("The Abassi Family (Mooresville)");
	});

	test("convergence mission steering includes the family's piece and progress", async () => {
		const contents = await build("what's my piece?", {
			guardian: { displayName: "Lucy", adventureKey: "lake_norman_guardians" },
			mission: {
				title: "Convergence",
				directive: "Gather every family's piece of the path.",
				fragment: "35",
				reporting: { reported: 2, total: 4, pending: ["The Morgan Family"] },
				complete: false,
			},
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("Current Mission: Convergence");
		expect(system).toContain('"35"');
		expect(system).toContain("2 of 4 families");
		expect(system).toContain("The Morgan Family");
	});

	test("convergence steering reveals the destination only when complete", async () => {
		const contents = await build("are we there yet?", {
			guardian: { displayName: "Lucy", adventureKey: "lake_norman_guardians" },
			mission: {
				title: "Convergence",
				directive: "Gather every family's piece of the path.",
				complete: true,
				destination: "35.544604, -80.937160",
			},
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("35.544604, -80.937160");
		expect(system).toContain("compass");
	});

	test("mission steering is suppressed during the scripted onboarding beat", async () => {
		const contents = await build("hi", {
			guardian: { displayName: "Thomas", adventureKey: "lake_norman_guardians" },
			onboarding: { priorAthenaLine: "Say hello.", firstContact: true },
			mission: { directive: "Encourage reaching out.", pendingFamilies: [] },
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("First contact");
		expect(system).not.toContain("Current Mission");
	});

	test("decryption mission is introduced only after the welcome beat", async () => {
		const contents = await build("hello", {
			guardian: { displayName: "Thomas", adventureKey: "lake_norman_guardians" },
			onboarding: { priorAthenaLine: "Say hello.", firstContact: true },
			mission: {
				id: "mission-2-convergence",
				title: "Decryption",
				directive: "Help decrypt the intercepted message.",
				decrypted: false,
			},
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("First contact");
		expect(system).toContain("First follow the onboarding instructions above completely");
		expect(system).toContain("intercepted an encrypted message");
		expect(system).toContain('"Decrypt Message for Athena"');
		expect(system).toContain("Do not mention a map");
	});

	test("pre-decryption mission steering hides the map and family progress", async () => {
		const contents = await build("what should I do?", {
			guardian: { displayName: "Lucy", adventureKey: "lake_norman_guardians" },
			mission: {
				id: "mission-2-convergence",
				title: "Decryption",
				directive: "Help decrypt the intercepted message.",
				fragment: "35",
				reporting: { reported: 0, total: 4, pending: ["The Morgan Family"] },
				decrypted: false,
				complete: false,
			},
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain('"Decrypt Message for Athena"');
		expect(system).not.toContain('family holds one piece of the path: "35"');
		expect(system).not.toContain("0 of 4 families");
		expect(system).not.toContain("Still waiting on");
	});

	test("history is replayed as user/model turns before the current message", async () => {
		const contents = await build("and what about Tuesday?", {
			guardian: { displayName: "Thomas", adventureKey: "lake_norman_guardians" },
			history: [
				{ is_human: true, text: "what day is the meetup?" },
				{ is_human: false, text: "It is this weekend." },
			],
		});

		const roles = contents.map((c) => c.role);
		expect(roles).toEqual(["system", "user", "model", "user"]);
		expect(contents[1].parts[0].text).toBe("what day is the meetup?");
		expect(contents[2].parts[0].text).toBe("It is this weekend.");
		expect(contents[3].parts[0].text).toContain("and what about Tuesday?");
	});

	test("convergence steering tells Athena how to record an in-chat report", async () => {
		const contents = await build("my piece is in", {
			guardian: { displayName: "Lucy", adventureKey: "lake_norman_guardians" },
			mission: {
				title: "Convergence",
				directive: "Gather every family's piece.",
				fragment: "35",
				complete: false,
			},
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;
		expect(system).toContain("mission_report");
	});

	test("non-guardian companion session has no Guardian-Network persona", async () => {
		const contents = await build("hello", {});
		const system = contents.find((c) => c.role === "system").parts[0].text;
		expect(system).not.toContain("Guardian Network");
		expect(system).toContain("5"); // generic age framing retained
	});
});
