jest.mock("./llm", () => ({ decide: jest.fn(), generateJson: jest.fn() }));
jest.mock("./llm/adapters/jev", () => ({ configured: jest.fn(async () => true) }));

const llm = require("./llm");
const jev = require("./llm/adapters/jev");
const monologue = require("./monologue");

const PROFILE = 7;
const draft = { response: "The Braves beat the Mets 7-2 last night.", action: "NO_CHANGE" };
const better = { response: "The Braves won 5-3 last night.", action: "NO_CHANGE" };
const WEB = { block: "# From the web\nBraves 5, Mets 3.", sources: [{ title: "mlb.com", url: "https://x" }] };

function screened(p) {
	llm.decide.mockResolvedValue({ answers: { factual: { type: "noul", noul: p } } });
}
function verdict(v) {
	llm.generateJson.mockResolvedValue({ data: v, endpointId: "openai", model: "critic-1" });
}

let rewrite, search, onSearch;
function args(over = {}) {
	return {
		profileId: PROFILE,
		audience: "adult",
		message: "who won last night?",
		draft,
		draftEndpointId: "gemini",
		context: null,
		rewrite,
		search,
		onSearch,
		...over,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	monologue._clear();
	rewrite = jest.fn().mockResolvedValue(better);
	search = jest.fn().mockResolvedValue(WEB);
	onSearch = jest.fn();
});

test("a reply with nothing checkable goes out untouched, after only the screen", async () => {
	screened(0.1);
	const out = await monologue.reflect(args());
	expect(out).toEqual({ reply: draft, web: null });
	expect(llm.generateJson).not.toHaveBeenCalled();
	expect(rewrite).not.toHaveBeenCalled();
	// Still recorded, so the Brain panel shows the turns that passed.
	expect(monologue.recent(PROFILE)[0]).toMatchObject({ screen: 0.1, verdict: null, changed: false });
});

test("a draft the critic finds sound goes out untouched", async () => {
	screened(0.9);
	verdict({ verdict: "ok", problems: [], query: "" });
	const out = await monologue.reflect(args());
	expect(out.reply).toBe(draft);
	expect(rewrite).not.toHaveBeenCalled();
	expect(monologue.recent(PROFILE)[0].verdict).toBe("ok");
});

test("the critic is asked to avoid the model that wrote the draft", async () => {
	screened(0.9);
	verdict({ verdict: "ok", problems: [], query: "" });
	await monologue.reflect(args());
	expect(llm.generateJson.mock.calls[0][0]).toMatchObject({ task: "critique", avoid: "gemini", audience: "adult" });
});

test("an unsupported current claim is searched, announced, and rewritten on the frontier", async () => {
	screened(0.9);
	verdict({ verdict: "search", problems: ["The score is a guess"], query: "braves mets score last night" });
	const out = await monologue.reflect(args());

	expect(onSearch).toHaveBeenCalled();
	expect(search).toHaveBeenCalledWith("braves mets score last night");
	expect(rewrite).toHaveBeenCalledWith({ extraContext: expect.stringContaining("Braves 5, Mets 3."), prefer: "frontier" });
	expect(rewrite.mock.calls[0][0].extraContext).toContain("The score is a guess");
	expect(out).toEqual({ reply: better, web: WEB });
	expect(monologue.recent(PROFILE)[0]).toMatchObject({
		verdict: "search",
		query: "braves mets score last night",
		sources: ["mlb.com"],
		draft: draft.response,
		final: better.response,
		changed: true,
	});
});

test("a turn that already searched revises instead of searching again", async () => {
	screened(0.9);
	verdict({ verdict: "search", problems: ["Goes beyond the results"], query: "x" });
	await monologue.reflect(args({ searched: true }));
	expect(search).not.toHaveBeenCalled();
	expect(rewrite).toHaveBeenCalled();
	expect(monologue.recent(PROFILE)[0].verdict).toBe("revise");
	expect(llm.generateJson.mock.calls[0][0].contents).toMatch(/"search" is not available/);
});

test("a revise rewrites without searching, carrying the problems", async () => {
	screened(0.9);
	verdict({ verdict: "revise", problems: ["She doesn't know their gym's hours"], query: "" });
	await monologue.reflect(args());
	expect(search).not.toHaveBeenCalled();
	expect(rewrite.mock.calls[0][0].extraContext).toContain("She doesn't know their gym's hours");
});

test("a failed search still rewrites, without the web block", async () => {
	screened(0.9);
	verdict({ verdict: "search", problems: ["Guess"], query: "q" });
	search.mockResolvedValue(null);
	const out = await monologue.reflect(args());
	expect(rewrite.mock.calls[0][0].extraContext).not.toContain("# From the web");
	expect(out).toEqual({ reply: better, web: null });
});

test("any failure keeps the draft", async () => {
	const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
	screened(0.9);
	llm.generateJson.mockRejectedValue(new Error("no model"));
	expect((await monologue.reflect(args())).reply).toBe(draft);

	verdict({ verdict: "revise", problems: ["x"], query: "" });
	rewrite.mockResolvedValue(null);
	expect((await monologue.reflect(args())).reply).toBe(draft);

	llm.decide.mockRejectedValue(new Error("Jev down"));
	expect((await monologue.reflect(args())).reply).toBe(draft);
	warn.mockRestore();
});

test("a rewrite that proposes an action is discarded", async () => {
	screened(0.9);
	verdict({ verdict: "revise", problems: ["x"], query: "" });
	rewrite.mockResolvedValue({ ...better, proposed_action: { type: "send_email" } });
	expect((await monologue.reflect(args())).reply).toBe(draft);
});

test("never reflects on a child's turn, an action proposal, or a song", async () => {
	screened(0.9);
	await monologue.reflect(args({ audience: "child" }));
	await monologue.reflect(args({ draft: { ...draft, proposed_action: { type: "x" } } }));
	await monologue.reflect(args({ draft: { ...draft, lyrics: "la la" } }));
	expect(llm.decide).not.toHaveBeenCalled();
	expect(monologue.recent(PROFILE)).toEqual([]);
});

test("without Jev there is no screen, no critique and no record", async () => {
	jev.configured.mockResolvedValueOnce(false);
	const out = await monologue.reflect(args());
	expect(out.reply).toBe(draft);
	expect(llm.generateJson).not.toHaveBeenCalled();
	expect(monologue.recent(PROFILE)).toEqual([]);
});

test("keeps only the most recent turns per person, newest first", async () => {
	screened(0.1);
	for (let i = 0; i < 30; i++) await monologue.reflect(args({ message: `m${i}` }));
	const list = monologue.recent(PROFILE);
	expect(list).toHaveLength(25);
	expect(list[0].message).toBe("m29");
	expect(monologue.recent(999)).toEqual([]);
});
