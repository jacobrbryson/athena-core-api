jest.mock("./llm", () => ({ search: jest.fn() }));

const llm = require("./llm");
const webSearch = require("./webSearch");

const RESULT = {
	text: "The Braves beat the Mets 5-3 on October 8.",
	sources: [
		{ title: "mlb.com", url: "https://example.com/a" },
		{ title: "espn.com", url: "https://example.com/b" },
	],
	queries: ["braves game october 8"],
	model: "gemini-3.5-flash-lite",
};

beforeEach(() => {
	jest.clearAllMocks();
	webSearch._clearCache();
	llm.search.mockResolvedValue(RESULT);
});

describe("matches", () => {
	it.each([
		"can you look that up?",
		"look up the hours for Home Depot",
		"google it",
		"search the web for cheap flights to Denver",
		"who won the game last night?",
		"what's the latest news on the hurricane?",
		"what's the current price of bitcoin?",
		"is it true that octopuses have three hearts?",
	])("hears an explicit ask: %s", (message) => {
		expect(webSearch.matches(message)).toBe(true);
	});

	it.each([
		"search my email for the invoice from Bob",
		"are you online?",
		"how did I sleep?",
		"tell me a story",
		"",
	])("leaves ordinary messages alone: %s", (message) => {
		expect(webSearch.matches(message)).toBe(false);
	});
});

describe("buildContext", () => {
	it("returns a prompt block and the sources for an adult", async () => {
		const out = await webSearch.buildContext("who won last night?", { audience: "adult" });
		expect(llm.search).toHaveBeenCalledWith("who won last night?", { audience: "adult" });
		expect(out.sources).toEqual(RESULT.sources);
		expect(out.block).toContain("# From the web");
		expect(out.block).toContain(RESULT.text);
		expect(out.block).toContain("1. mlb.com");
		// URLs are for the screen, never her voice.
		expect(out.block).not.toContain("https://");
	});

	it("never searches for a child", async () => {
		expect(await webSearch.buildContext("who won last night?", { audience: "child" })).toBeNull();
		expect(llm.search).not.toHaveBeenCalled();
	});

	it("reuses a recent identical search", async () => {
		await webSearch.buildContext("Who won last night?", { audience: "adult" });
		await webSearch.buildContext("who won last night?", { audience: "adult" });
		expect(llm.search).toHaveBeenCalledTimes(1);
	});

	it("returns null instead of throwing when the search fails", async () => {
		llm.search.mockRejectedValue(new Error("quota"));
		const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
		await expect(webSearch.buildContext("who won?", { audience: "adult" })).resolves.toBeNull();
		warn.mockRestore();
	});

	it("returns null for an empty result", async () => {
		llm.search.mockResolvedValue({ text: "", sources: [] });
		expect(await webSearch.buildContext("who won?", { audience: "adult" })).toBeNull();
	});

	it("keeps at most five sources", async () => {
		const many = Array.from({ length: 8 }, (_, i) => ({ title: `s${i}`, url: `https://example.com/${i}` }));
		llm.search.mockResolvedValue({ text: "x", sources: many });
		const out = await webSearch.buildContext("anything", { audience: "adult" });
		expect(out.sources).toHaveLength(5);
	});
});
