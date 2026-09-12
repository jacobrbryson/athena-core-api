/**
 * A conversation must never dead-end on the person's own message.
 *
 * The first nightly review counted a dropped reply: with a single tier in
 * production, one malformed reply meant NoModelAvailableError and nothing was
 * saved or broadcast — the person just watched "Athena is thinking" forever.
 * Now the turn is retried, and if that still fails she says something honest.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn().mockResolvedValue([[]]) }));
jest.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }));

const mockAddMessage = jest.fn().mockResolvedValue("ai-uuid");
const mockAfterTurn = jest.fn();
const mockGenerate = jest.fn();

jest.mock("../services/message", () => ({ addMessage: mockAddMessage, getMessages: jest.fn().mockResolvedValue([]) }));
jest.mock("../services/session", () => ({ updateSession: jest.fn().mockResolvedValue({}) }));
jest.mock("../services/sessionTopic", () => ({ getSessionTopics: jest.fn().mockResolvedValue([]) }));
jest.mock("../services/integration", () => ({ messageNeedsFamilyChores: () => false }));
jest.mock("../services/mission", () => ({}));
jest.mock("../services/perception", () => ({ getPromptBlock: () => null }));
jest.mock("../services/memoryStore", () => ({
	buildMemoryContext: jest.fn().mockResolvedValue({ audience: "adult", memoryEnabled: true, promptBlock: null }),
	afterTurn: mockAfterTurn,
}));
jest.mock("./prompt", () => ({ generatePrompt: jest.fn().mockResolvedValue([]), RESPONSE_SCHEMA: { type: "object" } }));
jest.mock("../services/llm", () => ({ generate: mockGenerate }));

const { processAiResponse } = require("./gemini");

const session = { id: 1, uuid: "s1", mode: "companion", profile_id: 42 };
const valid = JSON.stringify({
	response: "Hey there.",
	action: "NO_CHANGE",
	topic_name: "",
	new_proficiency: -1,
	is_factually_true: true,
});

/** Drives the router's validate() exactly as the real router does. */
const serving = (replies) => {
	const queue = [...replies];
	return jest.fn(async ({ validate }) => {
		const text = queue.shift();
		if (text === undefined) throw new Error("no model available");
		const problem = validate(text);
		if (problem) throw new Error(problem);
		return { text, endpointId: "gemini", tier: "frontier" };
	});
};

beforeEach(() => {
	mockAddMessage.mockClear();
	mockAfterTurn.mockClear();
	mockGenerate.mockReset();
});

test("a malformed first reply is retried and the good one is saved", async () => {
	mockGenerate.mockImplementation(serving(['{\\"response\\": \\"oops\\"}', valid]));
	await processAiResponse(session, "hello", new Map(), {});
	expect(mockGenerate).toHaveBeenCalledTimes(2);
	expect(mockAddMessage).toHaveBeenCalledWith(1, false, "Hey there.", "companion");
	expect(mockAfterTurn).toHaveBeenCalled();
});

test("when every attempt fails, Athena still answers honestly", async () => {
	mockGenerate.mockImplementation(serving([]));
	const broadcast = [];
	const clients = new Map([["s1", new Set([{ readyState: 1, OPEN: 1, send: (p) => broadcast.push(JSON.parse(p)) }])]]);

	await processAiResponse(session, "hello", clients, {});

	const saved = mockAddMessage.mock.calls[0];
	expect(saved[1]).toBe(false);
	expect(saved[2]).toMatch(/something glitched|say it again/i);
	// The client must be told, so the UI stops waiting.
	const added = broadcast.find((b) => b.rpc === "addMessage");
	expect(added.message.text).toMatch(/something glitched|say it again/i);
	expect(added.session.is_busy).toBe(false);
	// Nothing to remember from an apology.
	expect(mockAfterTurn).not.toHaveBeenCalled();
});

test("the salvage parser recovers the production escaped-quote failure without a retry", async () => {
	const escaped =
		'{\\"response\\": \\"Recovered.\\", \\"action\\": \\"NO_CHANGE\\", \\"topic_name\\": \\"\\", \\"new_proficiency\\": -1, \\"is_factually_true\\": true}';
	mockGenerate.mockImplementation(serving([escaped]));
	await processAiResponse(session, "hello", new Map(), {});
	expect(mockGenerate).toHaveBeenCalledTimes(1);
	expect(mockAddMessage).toHaveBeenCalledWith(1, false, "Recovered.", "companion");
});
