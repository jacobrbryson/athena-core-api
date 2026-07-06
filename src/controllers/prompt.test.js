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

	test("ratatouille alarm beat guides the reaction turn instead of the default nudges", async () => {
		const alarm = "Ratatouille is MISSING!!!";
		const contents = await build("oh no! what happened??", {
			guardian: { displayName: "John Doe", adventureKey: "rescue_ratatouille" },
			onboarding: { priorAthenaLine: alarm, firstContact: false, beat: "ratatouille_alarm" },
		});

		const roles = contents.map((c) => c.role);
		expect(roles).toEqual(["system", "model", "user"]);
		expect(contents.find((c) => c.role === "model").parts[0].text).toBe(alarm);

		const system = contents.find((c) => c.role === "system").parts[0].text;
		expect(system).toContain("The Ratatouille alarm");
		expect(system).toContain("never scary");
		expect(system).not.toContain("First contact");
		expect(system).not.toContain("Returning Guardian");
	});

	test("rescue_ratatouille persona carries the missing-companion lore with an anti-invention rule", async () => {
		const contents = await build("who is Ratatouille?", {
			guardian: { displayName: "John Doe", adventureKey: "rescue_ratatouille" },
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("Rescue Ratatouille");
		expect(system).toContain("gone missing");
		expect(system).toContain("corrupted or missing");
		expect(system).toContain("never make up specifics");
	});

	test("trail mission steering briefs Athena without giving anything away", async () => {
		const contents = await build("where should we look?", {
			guardian: { displayName: "John Doe", adventureKey: "rescue_ratatouille" },
			mission: {
				id: "mission-1-ratatouille-trail",
				title: "The Trail to Ratatouille",
				directive: "Find the ten Guardian clue cards hidden around the property.",
				phase: "key_hunt",
				keysUsed: 2,
				keysTotal: 10,
				pendingDecryption: false,
				latestClueDescription: "Island Cove",
			},
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("The Trail to Ratatouille");
		expect(system).toContain("Guardians logo");
		expect(system).toContain("**2 of 10**");
		expect(system).toContain('"Island Cove"');
		expect(system).toContain("NEVER reveal");
		expect(system).toContain("in order");
		expect(system).toContain("exactly once");
	});

	test("a key accepted in chat steers Athena to confirm and hand off to the panel", async () => {
		const contents = await build("we found X1G7!", {
			guardian: { displayName: "John Doe", adventureKey: "rescue_ratatouille" },
			mission: {
				id: "mission-1-ratatouille-trail",
				directive: "Find the cards.",
				phase: "key_hunt",
				keysUsed: 0,
				keysTotal: 10,
				transition: "key_accepted",
			},
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("reported a valid decryption key IN THIS MESSAGE");
		expect(system).toContain("mission bar at the top of the screen");
	});

	test("a completed trail flips Athena into celebration mode", async () => {
		const contents = await build("we did it!", {
			guardian: { displayName: "John Doe", adventureKey: "rescue_ratatouille" },
			mission: {
				id: "mission-1-ratatouille-trail",
				directive: "Find the cards.",
				phase: "trail_complete",
				keysUsed: 10,
				keysTotal: 10,
			},
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("COMPLETE");
		expect(system).toContain("compass");
		expect(system).toContain("Do not recite the trail legs");
	});

	test("the alarm-reaction reply hands the Guardian the mission briefing", async () => {
		const contents = await build("yes I'm ready!", {
			guardian: { displayName: "John Doe", adventureKey: "rescue_ratatouille" },
			onboarding: {
				priorAthenaLine: "Ratatouille is MISSING!!!",
				firstContact: false,
				beat: "ratatouille_alarm",
			},
			mission: {
				id: "mission-1-ratatouille-trail",
				directive: "Find the cards.",
				phase: "key_hunt",
				keysUsed: 0,
				keysTotal: 10,
			},
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("The Ratatouille alarm");
		expect(system).toContain("blinking mission bar");
		expect(system).toContain("Guardians logo");
		// The full mission steering block stays out of the scripted beat.
		expect(system).not.toContain("Current Mission: The Trail to Ratatouille");
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

	test("Lake Norman Athena notices her improved voice without claiming a cause", async () => {
		const contents = await build("hello", {
			guardian: { displayName: "Thomas", adventureKey: "lake_norman_guardians" },
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("Your changing voice");
		expect(system).toContain("whether your voice sounds better");
		expect(system).toContain("decrypting the Guardian maps");
		expect(system).toContain("only a private theory");
		expect(system).toContain("do not ask repeatedly");
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

	test("PORTICO mission gives Athena private clue knowledge with strict hinting", async () => {
		const contents = await build("we are stuck", {
			guardian: { displayName: "Lucy", adventureKey: "lake_norman_guardians" },
			mission: {
				id: "mission-2-portico",
				title: "The Portico Signal",
				phase: "active",
				directive: "Guide the field mission.",
			},
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("11 compass bearings written in invisible ink");
		expect(system).toContain("starting at the front door");
		expect(system).toContain("Do not volunteer the invisible ink");
		expect(system).toContain("use their Guardian tools");
	});

	test("decrypting mission prevents Athena from inventing progress", async () => {
		const contents = await build("YP2LBHM7", {
			guardian: { displayName: "Lucy", adventureKey: "lake_norman_guardians" },
			mission: {
				id: "mission-2-portico",
				title: "The Portico Signal",
				phase: "decrypting",
				transition: "decrypting",
				directive: "Athena is decrypting the recovered message.",
			},
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("decryption has begun");
		expect(system).toContain("check back later");
		expect(system).toContain("Do not invent a result");
		expect(system).toContain("old capabilities inside you may be waking up");
		expect(system).toContain("Treat the connection as a theory, not a fact");
	});

	test("signal-decode count gives Athena the Guardian's exact total, flavor only", async () => {
		const contents = await build("I decoded another signal!", {
			guardian: { displayName: "Lucy", adventureKey: "lake_norman_guardians" },
			decodes: { total: 12 },
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("Signal decoding record");
		expect(system).toContain("**12** intercepted practice signals");
		expect(system).toContain("never imply these practice signals advance the current mission");
	});

	test("signal-decode awareness is suppressed during the scripted onboarding beat", async () => {
		const contents = await build("hi", {
			guardian: { displayName: "Lucy", adventureKey: "lake_norman_guardians" },
			onboarding: { priorAthenaLine: "Say hello.", firstContact: true },
			decodes: { total: 4 },
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;

		expect(system).toContain("First contact");
		expect(system).not.toContain("Signal decoding record");
	});

	test("no decode block without a positive count", async () => {
		const contents = await build("hello", {
			guardian: { displayName: "Lucy", adventureKey: "lake_norman_guardians" },
			decodes: { total: 0 },
		});
		const system = contents.find((c) => c.role === "system").parts[0].text;
		expect(system).not.toContain("Signal decoding record");
	});
});
