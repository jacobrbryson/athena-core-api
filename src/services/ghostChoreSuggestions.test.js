/**
 * Unit tests for the Athena ghost-chore suggestion service.
 * Run with the repo's configured test runner: `npm test` (jest).
 *
 * `./gemini` is mocked so these tests never call the real model — they assert
 * our prompt construction, defensive normalization, and child-safety invariants.
 */
jest.mock("./gemini");
const geminiService = require("./gemini");
const {
	generateGhostChoreSuggestions,
	buildSafeContext,
	normalizeSuggestion,
	parseModelJson,
} = require("./ghostChoreSuggestions");

function modelReturns(obj) {
	geminiService.generateResponse.mockResolvedValue(JSON.stringify(obj));
}

const VALID = {
	title: "Wipe the bathroom sink",
	description: "Clear the counter and wipe the sink after brushing teeth.",
	difficulty: "easy",
	estimatedMinutes: 5,
	suggestedCoins: 5,
	category: "Self Care",
	pillar: "Home Care",
	suggestionType: "next_step",
	reason: "Builds on their brushing-teeth chore.",
	confidence: 0.86,
	requiresParentReview: true,
	safetyNotes: null,
};

beforeEach(() => {
	jest.clearAllMocks();
});

describe("buildSafeContext", () => {
	it("never forwards unexpected fields and clamps types", () => {
		const ctx = buildSafeContext({
			user: { displayName: "Sam", role: "hacker", age: "9" },
			secretToken: "should-not-survive",
			activeChores: [{ title: "Make bed", coinValue: 5, evil: 1 }],
			categories: ["Self Care", { name: "Home" }],
		});
		expect(ctx.user.role).toBe("player"); // unknown role downgraded
		expect(ctx.user.age).toBe(9);
		expect(ctx).not.toHaveProperty("secretToken");
		expect(ctx.activeChores[0]).toEqual({ title: "Make bed", coinValue: 5 });
		expect(ctx.categories).toEqual(["Self Care", "Home"]);
	});
});

describe("normalizeSuggestion", () => {
	it("clamps confidence and coerces invalid enums to safe defaults", () => {
		const out = normalizeSuggestion(
			{ ...VALID, difficulty: "extreme", suggestionType: "bogus", confidence: 5 },
			{ forceParentReview: false }
		);
		expect(out.difficulty).toBe("easy");
		expect(out.suggestionType).toBe("novelty");
		expect(out.confidence).toBe(1);
	});

	it("forces parent review for child accounts even if the model says false", () => {
		const out = normalizeSuggestion(
			{ ...VALID, requiresParentReview: false },
			{ forceParentReview: true }
		);
		expect(out.requiresParentReview).toBe(true);
	});

	it("returns null for entries without a title", () => {
		expect(normalizeSuggestion({ description: "x" }, {})).toBeNull();
	});
});

describe("parseModelJson", () => {
	it("parses plain JSON", () => {
		expect(parseModelJson('{"suggestions":[]}')).toEqual({ suggestions: [] });
	});
	it("strips ```json markdown fences", () => {
		expect(parseModelJson('```json\n{"suggestions":[]}\n```')).toEqual({ suggestions: [] });
	});
	it("extracts the outermost object from surrounding prose", () => {
		expect(parseModelJson('Sure! Here you go:\n{"suggestions":[]}\nHope that helps')).toEqual({
			suggestions: [],
		});
	});
	it("returns null for empty or junk", () => {
		expect(parseModelJson("")).toBeNull();
		expect(parseModelJson("not json at all")).toBeNull();
	});
});

describe("generateGhostChoreSuggestions", () => {
	it("recovers from a fenced JSON response", async () => {
		geminiService.generateResponse.mockResolvedValue("```json\n" + JSON.stringify({ suggestions: [VALID] }) + "\n```");
		const result = await generateGhostChoreSuggestions({ count: 3 });
		expect(result.suggestions).toHaveLength(1);
	});

	it("returns normalized suggestions plus athena meta", async () => {
		modelReturns({ suggestions: [VALID] });
		const result = await generateGhostChoreSuggestions({
			user: { displayName: "Sam", role: "player", age: 9 },
			count: 3,
		});
		expect(result.suggestions).toHaveLength(1);
		expect(result.meta.source).toBe("athena");
		expect(result.meta.modelVersion).toMatch(/gemini/);
		// child account => parent review forced on regardless of model output
		expect(result.suggestions[0].requiresParentReview).toBe(true);
	});

	it("throws a 502 when the model returns non-JSON", async () => {
		geminiService.generateResponse.mockResolvedValue("not json");
		await expect(generateGhostChoreSuggestions({})).rejects.toMatchObject({
			status: 502,
		});
	});

	it("throws a 502 when the model call fails", async () => {
		geminiService.generateResponse.mockRejectedValue(new Error("boom"));
		await expect(generateGhostChoreSuggestions({})).rejects.toMatchObject({
			status: 502,
		});
	});

	it("yields an empty list (not an error) when the model returns no suggestions", async () => {
		modelReturns({ suggestions: [] });
		const result = await generateGhostChoreSuggestions({});
		expect(result.suggestions).toEqual([]);
		expect(result.meta.source).toBe("athena");
	});
});
