jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./llm", () => ({ decide: jest.fn() }));

const pool = require("../helpers/db");
const llm = require("./llm");
const personUpdate = require("./personUpdate");

const row = (uuid, category, memory_key, memory_value) => ({ uuid, category, memory_key, memory_value });
const FAMILY = [
	row("u1", "family", "mother", "Cindy Bryson; alive but somewhat estranged"),
	row("u2", "person", "sister", "Emma Bryson, lives in Denver"),
	row("u3", "person", "Emma", "college friend, nurse"),
	row("u4", "pet", "dog's name", "Biscuit — golden retriever, 4"),
	row("u5", "person", "aunt missy", "Lives in Charlotte; my dad's sister"),
];
const update = { personUpdate: 0.9 };

beforeEach(() => {
	jest.clearAllMocks();
	pool.query.mockResolvedValue([FAMILY]);
});

describe("search", () => {
	const everyone = FAMILY.map(personUpdate.personOf);
	const names = (message) => personUpdate.search(message, everyone).map((m) => m.p.key);

	it("finds someone by the name in their memory, not just their key", () => {
		expect(names("It's been a while since I updated you about Cindy Bryson")).toEqual(["mother"]);
	});
	it("finds someone by what the person calls them", () => {
		expect(names("Mom is finally selling the Jeep")).toEqual(["mother"]);
		expect(names("my auntie called today")).toEqual(["aunt missy"]);
	});
	it("finds a name in the key", () => {
		expect(names("Missy got a new job")).toEqual(["aunt missy"]);
	});
	it("returns everyone a shared name fits", () => {
		expect(names("Emma started her new job").sort()).toEqual(["Emma", "sister"]);
	});
});

describe("resolve", () => {
	it("does nothing unless the guess says it is news about someone", async () => {
		expect(await personUpdate.resolve("Cindy is selling her Jeep", { profileId: 1, guessed: { personUpdate: 0.2 } })).toBeNull();
		expect(pool.query).not.toHaveBeenCalled();
	});

	it("takes the one person the message names, without asking Jev", async () => {
		const r = await personUpdate.resolve("It's been a while since I updated you about Cindy Bryson. She's doing well.", { profileId: 1, guessed: update });
		expect(r).toMatchObject({ how: "named", person: { key: "mother", name: "Cindy Bryson", relation: "mother" } });
		expect(llm.decide).not.toHaveBeenCalled();
	});

	it("asks Jev to pick between two Emmas, with the conversation as context", async () => {
		llm.decide.mockResolvedValue({ answers: { who: { choice: "p1", probabilities: { p0: 0.1, p1: 0.85, none: 0.05 } } } });
		const recent = [{ is_human: 0, text: "How's your sister doing out in Denver?" }];
		const r = await personUpdate.resolve("Emma started a new job!", { profileId: 1, guessed: update, recent });
		const call = llm.decide.mock.calls[0][0];
		expect(call.state).toContain("Athena: How's your sister doing out in Denver?");
		expect(Object.keys(call.questions.who.criteria)).toEqual(["p0", "p1", "none"]);
		const picked = personUpdate.search("Emma", FAMILY.map(personUpdate.personOf))[1].p.key;
		expect(r).toMatchObject({ how: "chosen", person: { key: picked } });
	});

	it("leaves it to Athena to ask when Jev isn't sure", async () => {
		llm.decide.mockResolvedValue({ answers: { who: { choice: "p0", probabilities: { p0: 0.45, p1: 0.4, none: 0.15 } } } });
		const r = await personUpdate.resolve("Emma started a new job!", { profileId: 1, guessed: update });
		expect(r.ambiguous.map((p) => p.key).sort()).toEqual(["Emma", "sister"]);
		expect(personUpdate.promptBlock(r)).toMatch(/Ask briefly which one/);
	});

	it("asks Jev across everyone when nobody is named, using the context", async () => {
		llm.decide.mockResolvedValue({ answers: { who: { choice: "p0", probabilities: { p0: 0.8 } } } });
		const r = await personUpdate.resolve("She's doing a lot better since the surgery", {
			profileId: 1,
			guessed: update,
			recent: [{ is_human: 1, text: "Let me tell you about my mother" }],
		});
		expect(Object.keys(llm.decide.mock.calls[0][0].questions.who.criteria)).toHaveLength(FAMILY.length + 1);
		expect(r.how).toBe("chosen");
	});

	it("a Jev failure is no answer, never an error", async () => {
		llm.decide.mockRejectedValue(new Error("timed out"));
		expect(await personUpdate.resolve("She's doing better", { profileId: 1, guessed: update })).toBeNull();
	});
});

describe("prompt and focus", () => {
	it("tells the reply it is being saved, and aims extraction at the person's key", async () => {
		const r = await personUpdate.resolve("Quick update on Cindy: she sold the Jeep", { profileId: 1, guessed: update });
		expect(personUpdate.promptBlock(r)).toMatch(/bringing you up to date on Cindy Bryson \(their mother\)/);
		expect(personUpdate.focusOf(r)).toEqual({ key: "mother", category: "family", name: "Cindy Bryson", value: "Cindy Bryson; alive but somewhat estranged" });
	});
});
