jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
const ispy = require("./ispy");
const planning = require("./planning");
const runner = require("./runner");

describe("I Spy", () => {
	test("a guess matches the answer whatever the articles, plurals or case", () => {
		expect(ispy.matches("The red ball", "red ball")).toBe(true);
		expect(ispy.matches("balls", "ball")).toBe(true);
		expect(ispy.matches("a CUP", "cup")).toBe(true);
	});

	test("one of Athena's other names counts, and a different thing doesn't", () => {
		expect(ispy.matches("sofa", "couch", ["sofa", "settee"])).toBe(true);
		expect(ispy.matches("lamp", "couch", ["sofa"])).toBe(false);
		expect(ispy.matches("", "couch")).toBe(false);
	});

	test("turns go round the players in the plan's order", () => {
		const players = ["thomas", "skylar", "athena"];
		expect([1, 2, 3, 4, 12].map((n) => ispy.spyFor(players, n))).toEqual(["thomas", "skylar", "athena", "thomas", "athena"]);
	});

	test("a plan keeps its game only when it names enough players", () => {
		const base = { title: "Teach Athena I Spy", goal: "g", reason: "r", steps: [], safety: {} };
		expect(planning.normalize({ ...base, game: { kind: "ispy", rounds: 12, players: ["thomas", "skylar", "athena"] } }, []).plan.game).toEqual({ kind: "ispy", rounds: 12, players: ["thomas", "skylar", "athena"] });
		expect(planning.normalize({ ...base, game: { kind: "ispy", players: ["thomas"] } }, []).plan.game).toBeNull();
		expect(planning.normalize({ ...base, game: { kind: "chess", players: ["a", "b"] } }, []).plan.game).toBeNull();
	});

	test("a game proves only a kid's live step, in a plan that names its game", () => {
		const actors = { thomas: { kind: "kid" }, ross: { kind: "parent" } };
		const step = (over) => ({ key: "play", phase: "live", actor: "thomas", proof: "game", instruction: "Play I Spy with Athena on your tablet.", dueMinutes: 60, ...over });
		const game = { kind: "ispy", rounds: 12, players: ["thomas", "athena"] };
		const problems = (plan) => runner.validatePlan(plan, { actors }).filter((p) => /game/.test(p));
		expect(problems({ steps: [step()], game })).toEqual([]);
		expect(problems({ steps: [step()] })).toHaveLength(1);
		expect(problems({ steps: [step({ actor: "ross" })], game })).toHaveLength(1);
	});
	test("a parent's practice round grades like the real game and stores nothing", async () => {
		const pool = require("../../helpers/db");
		pool.query.mockClear();
		expect(ispy.demoCheck({ guess: "the sofa", answer: "couch", aliases: ["sofa"] })).toEqual({ right: true });
		expect(ispy.demoCheck({ guess: "lamp", answer: "couch" })).toEqual({ right: false });
		const image = Buffer.alloc(2000, 1).toString("base64");
		const llm = { generateJson: jest.fn()
			.mockResolvedValueOnce({ data: { guess: "blue cup" } })
			.mockResolvedValueOnce({ data: { answer: "lamp", clue: "yellow", aliases: ["light"], hints: ["on the table"] } }) };
		await expect(ispy.demoGuess({ imageBase64: image, contentType: "image/jpeg", clue: "something blue", wrong: ["sky"] }, llm)).resolves.toMatchObject({ guess: "blue cup" });
		expect(llm.generateJson.mock.calls[0][0].contents[0].parts[0].text).toContain("\"sky\"");
		await expect(ispy.demoPick({ imageBase64: image, contentType: "image/jpeg" }, llm)).resolves.toEqual({ clue: "something yellow", answer: "lamp", aliases: ["light"], hints: ["on the table"] });
		await expect(ispy.demoGuess({ imageBase64: image, clue: "x" }, llm)).rejects.toMatchObject({ status: 400 });
		expect(pool.query).not.toHaveBeenCalled();
	});
});
