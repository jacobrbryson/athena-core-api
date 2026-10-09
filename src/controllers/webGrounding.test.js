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
