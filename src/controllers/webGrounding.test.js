/**
 * Web search in a chat turn: the result reaches the prompt, the reply goes to
 * the frontier first, and the sources ride the live reply as links. A child's
 * turn never searches.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn().mockResolvedValue([[]]) }));
jest.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }));

const mockGenerate = jest.fn();
const mockGeneratePrompt = jest.fn().mockResolvedValue([]);
const mockAudience = jest.fn();
const mockBuildWeb = jest.fn();

jest.mock("../services/message", () => ({ addMessage: jest.fn().mockResolvedValue("ai-uuid"), getMessages: jest.fn().mockResolvedValue([]) }));
jest.mock("../services/session", () => ({ updateSession: jest.fn().mockResolvedValue({}) }));
jest.mock("../services/sessionTopic", () => ({ getSessionTopics: jest.fn().mockResolvedValue([]) }));
jest.mock("../services/integration", () => ({ messageNeedsFamilyChores: () => false }));
jest.mock("../services/mission", () => ({}));
jest.mock("../services/toolIntent", () => ({ guess: jest.fn().mockResolvedValue(null), extraGrounding: () => null }));
jest.mock("../services/perception", () => ({ getPromptBlock: () => null }));
const mockReflect = jest.fn();
jest.mock("../services/monologue", () => ({ reflect: (...a) => mockReflect(...a) }));
jest.mock("../services/audience", () => ({ audienceForSession: (...a) => mockAudience(...a) }));
jest.mock("../services/webSearch", () => ({
	matches: (m) => /look (it|that) up/i.test(m),
	buildContext: (...a) => mockBuildWeb(...a),
}));
jest.mock("../services/memoryStore", () => ({
	buildMemoryContext: jest.fn().mockResolvedValue({ audience: "adult", memoryEnabled: true, promptBlock: null }),
	afterTurn: jest.fn(),
}));
jest.mock("./prompt", () => ({ generatePrompt: mockGeneratePrompt, RESPONSE_SCHEMA: { type: "object" } }));
jest.mock("../services/llm", () => ({ generate: mockGenerate }));

const { processAiResponse } = require("./gemini");

const session = { id: 1, uuid: "s1", mode: "companion", profile_id: 42 };
const reply = JSON.stringify({
	response: "The Braves won 5-3.",
	action: "NO_CHANGE",
	topic_name: "",
	new_proficiency: -1,
	is_factually_true: true,
});
const SOURCES = [{ title: "mlb.com", url: "https://example.com/a" }];

function socket() {
	const sent = [];
	const clients = new Map([["s1", new Set([{ readyState: 1, OPEN: 1, send: (p) => sent.push(JSON.parse(p)) }])]]);
	return { sent, clients };
}

beforeEach(() => {
	jest.clearAllMocks();
	mockAudience.mockResolvedValue("adult");
	mockReflect.mockImplementation(async ({ draft }) => ({ reply: draft, web: null }));
	mockBuildWeb.mockResolvedValue({ block: "# From the web\nBraves 5, Mets 3.", sources: SOURCES });
	mockGenerate.mockImplementation(async ({ validate }) => {
		validate(reply);
		return { text: reply, endpointId: "gemini", tier: "frontier" };
	});
});

test("an explicit ask searches, grounds the prompt, prefers the frontier and sends the links", async () => {
	const { sent, clients } = socket();
	await processAiResponse(session, "can you look it up? who won the Braves game", clients, {});

	expect(mockBuildWeb).toHaveBeenCalledWith("can you look it up? who won the Braves game", { audience: "adult" });
	expect(mockGeneratePrompt.mock.calls[0][3].integrationContext).toContain("Braves 5, Mets 3.");
	expect(mockGenerate.mock.calls[0][0].prefer).toBe("frontier");
	const added = sent.find((m) => m.rpc === "addMessage");
	expect(added.message.sources).toEqual(SOURCES);
});

test("an ordinary message neither searches nor changes the routing", async () => {
	const { sent, clients } = socket();
	await processAiResponse(session, "tell me a story", clients, {});

	expect(mockBuildWeb).not.toHaveBeenCalled();
	expect(mockGenerate.mock.calls[0][0].prefer).toBeUndefined();
	expect(sent.find((m) => m.rpc === "addMessage").message.sources).toBeUndefined();
});

test("a child's turn never searches", async () => {
	mockAudience.mockResolvedValue("child");
	await processAiResponse(session, "can you look it up?", new Map(), {});
	expect(mockBuildWeb).not.toHaveBeenCalled();
});

test("a failed search leaves the turn unharmed", async () => {
	mockBuildWeb.mockResolvedValue(null);
	const { sent, clients } = socket();
	await processAiResponse(session, "look it up please", clients, {});
	expect(mockGenerate.mock.calls[0][0].prefer).toBeUndefined();
	expect(sent.find((m) => m.rpc === "addMessage").message.text).toBe("The Braves won 5-3.");
});

describe("inner monologue", () => {
	const revised = { response: "I'm not sure who won — want me to check?", action: "NO_CHANGE", topic_name: "", new_proficiency: -1, is_factually_true: true };

	test("gets the draft, the context and a rewrite that can add context and prefer the frontier", async () => {
		const { sent, clients } = socket();
		mockReflect.mockImplementation(async ({ draft, rewrite, draftEndpointId, searched }) => {
			expect(draft.response).toBe("The Braves won 5-3.");
			expect(draftEndpointId).toBe("gemini");
			expect(searched).toBe(false);
			const again = await rewrite({ extraContext: "# Before you answer", prefer: "frontier" });
			return { reply: { ...again, response: revised.response }, web: null };
		});
		await processAiResponse(session, "tell me about last night", clients, {});

		const second = mockGenerate.mock.calls[1][0];
		expect(second.prefer).toBe("frontier");
		expect(mockGeneratePrompt.mock.calls[1][3].integrationContext).toContain("# Before you answer");
		expect(sent.find((m) => m.rpc === "addMessage").message.text).toBe(revised.response);
	});

	test("a search it runs announces itself and puts its links under the reply", async () => {
		const { sent, clients } = socket();
		mockReflect.mockImplementation(async ({ draft, onSearch, search }) => {
			onSearch();
			const web = await search("braves score last night");
			return { reply: draft, web };
		});
		await processAiResponse(session, "tell me about last night", clients, {});

		expect(mockBuildWeb).toHaveBeenCalledWith("braves score last night", { audience: "adult" });
		const filler = sent.find((m) => m.rpc === "filler");
		expect(filler.filler.key).toBe("double-check");
		expect(sent.indexOf(filler)).toBeLessThan(sent.findIndex((m) => m.rpc === "addMessage"));
		expect(sent.find((m) => m.rpc === "addMessage").message.sources).toEqual(SOURCES);
	});

	test("is told when the turn already searched", async () => {
		await processAiResponse(session, "look it up: who won", new Map(), {});
		expect(mockReflect.mock.calls[0][0].searched).toBe(true);
	});

	test("never runs for a child", async () => {
		mockAudience.mockResolvedValue("child");
		const memoryStore = require("../services/memoryStore");
		memoryStore.buildMemoryContext.mockResolvedValueOnce({ audience: "child", memoryEnabled: true, promptBlock: null });
		await processAiResponse(session, "tell me about last night", new Map(), {});
		expect(mockReflect).not.toHaveBeenCalled();
	});
});
