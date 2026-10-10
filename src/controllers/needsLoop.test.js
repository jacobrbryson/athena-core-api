/**
 * She asks for what she needs before she answers (2026-10-10).
 *
 * "What's the weather looking like for the games today?" read no calendar and
 * sent the raw sentence to Google, which answered about Cleveland. Now a draft
 * may fill `needs`; it isn't sent, the reads happen, and the reply is written
 * again — calendar, then the weather at that event.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn().mockResolvedValue([[]]) }));
jest.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }));

const mockGenerate = jest.fn();
const mockGeneratePrompt = jest.fn().mockResolvedValue([]);
const mockFetch = jest.fn();
const mockBuildWeb = jest.fn();
const mockReflect = jest.fn();
const mockAudience = jest.fn();

jest.mock("../services/message", () => ({ addMessage: jest.fn().mockResolvedValue("ai-uuid"), getMessages: jest.fn().mockResolvedValue([]) }));
jest.mock("../services/session", () => ({ updateSession: jest.fn().mockResolvedValue({}) }));
jest.mock("../services/sessionTopic", () => ({ getSessionTopics: jest.fn().mockResolvedValue([]) }));
jest.mock("../services/integration", () => ({ messageNeedsFamilyChores: () => false }));
jest.mock("../services/mission", () => ({}));
jest.mock("../services/toolIntent", () => ({
	guess: jest.fn().mockResolvedValue({ fetch: ["web"] }),
	extraGrounding: () => ({ providers: [], daysByProvider: {}, heartRate: false, web: true }),
}));
jest.mock("../services/perception", () => ({ getPromptBlock: () => null }));
jest.mock("../services/codeAgents", () => ({ REPOS: {}, promptBlock: async () => null }));
jest.mock("../services/monologue", () => ({ reflect: (...a) => mockReflect(...a) }));
jest.mock("../services/audience", () => ({ audienceForSession: (...a) => mockAudience(...a) }));
jest.mock("../services/webSearch", () => ({ matches: (m) => /look (it|that) up/i.test(m), buildContext: (...a) => mockBuildWeb(...a) }));
jest.mock("../services/memoryStore", () => ({
	buildMemoryContext: jest.fn().mockResolvedValue({ audience: "adult", memoryEnabled: true, promptBlock: null }),
	afterTurn: jest.fn(),
}));
jest.mock("../services/needs", () => {
	const real = jest.requireActual("../services/needs");
	return {
		...real,
		available: async () => ["calendar", "weather", "web"],
		fetch: (...a) => mockFetch(...a),
	};
});
jest.mock("./prompt", () => ({ generatePrompt: mockGeneratePrompt, RESPONSE_SCHEMA: { type: "object" } }));
jest.mock("../services/llm", () => ({ generate: mockGenerate }));

const memoryStore = require("../services/memoryStore");
const { processAiResponse } = require("./gemini");

const session = { id: 1, uuid: "s1", mode: "companion", profile_id: 42 };
const base = { action: "NO_CHANGE", topic_name: "", new_proficiency: -1, is_factually_true: true };
const ASKED = "What's the weather looking like for the games today?";
const ANSWER = "Your 5:30 game at Clague Park: 58° with showers likely after 6 — bring jackets.";
const CALENDAR = "# Calendar\n- Today 5:30 pm U10 soccer @ Clague Park, Westlake OH";
const WEATHER = "# Weather\nAt Clague Park: 5 pm 58°F, Chance Rain Showers, 40%";

function replies(...list) {
	let i = 0;
	mockGenerate.mockImplementation(async ({ validate }) => {
		const text = JSON.stringify({ ...base, ...list[Math.min(i++, list.length - 1)] });
		validate(text);
		return { text, endpointId: "gemini", tier: "frontier" };
	});
}

function socket() {
	const sent = [];
	const clients = new Map([["s1", new Set([{ readyState: 1, OPEN: 1, send: (p) => sent.push(JSON.parse(p)) }])]]);
	return { sent, clients, text: () => sent.find((m) => m.rpc === "addMessage")?.message };
}

beforeEach(() => {
	jest.clearAllMocks();
	mockAudience.mockResolvedValue("adult");
	mockReflect.mockImplementation(async ({ draft }) => ({ reply: draft, web: null }));
	mockFetch.mockImplementation(async (_p, wanted) => {
		const src = wanted[0].source;
		return { blocks: [src === "calendar" ? CALENDAR : WEATHER], sources: [], read: wanted.map((n) => n.source) };
	});
	jest.spyOn(console, "info").mockImplementation(() => {});
	jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test("the games: calendar, then the weather at that event, then the answer", async () => {
	replies(
		{ response: "Let me check.", needs: [{ source: "calendar", range: "today" }] },
		{ response: "Let me check.", needs: [{ source: "weather", place: "Clague Park, Westlake OH", when: "2026-10-10T17:30:00-04:00" }] },
		{ response: ANSWER }
	);
	const s = socket();
	await processAiResponse(session, ASKED, s.clients, { companion: { timezone: "America/New_York" } });

	// No raw-sentence search went out up front, even though Jev guessed "web".
	expect(mockBuildWeb).not.toHaveBeenCalled();
	expect(mockFetch.mock.calls[0][1]).toEqual([{ source: "calendar", range: "today" }]);
	expect(mockFetch.mock.calls[1][1][0]).toMatchObject({ source: "weather", place: "Clague Park, Westlake OH" });
	expect(mockFetch.mock.calls[1][2]).toMatchObject({ audience: "adult", timeZone: "America/New_York" });

	// Each rewrite sees everything read so far; the last is told to answer.
	expect(mockGeneratePrompt.mock.calls[2][3].integrationContext).toContain(CALENDAR);
	expect(mockGeneratePrompt.mock.calls[2][3].integrationContext).toContain(WEATHER);
	expect(mockGeneratePrompt.mock.calls[0][3].needsBlock).toMatch(/Looking things up/);
	expect(mockGeneratePrompt.mock.calls[2][3].needsBlock).toMatch(/No more lookups/);

	expect(s.text().text).toBe(ANSWER);
	// One "let me check" filler, before the answer.
	const fillers = s.sent.filter((m) => m.rpc === "filler");
	expect(fillers).toHaveLength(1);
	expect(fillers[0].filler.key).toBe("checking");
	// The monologue sees the reads too.
	expect(mockReflect.mock.calls[0][0].context).toContain(CALENDAR);
});

test("a reply that needs nothing costs nothing extra", async () => {
	replies({ response: "Morning! What's up?" });
	const s = socket();
	await processAiResponse(session, "good morning", s.clients, {});
	expect(mockGenerate).toHaveBeenCalledTimes(1);
	expect(mockFetch).not.toHaveBeenCalled();
	expect(s.sent.find((m) => m.rpc === "filler")).toBeUndefined();
});

test("it stops after two rounds even if she keeps asking", async () => {
	replies(
		{ response: "Let me check.", needs: [{ source: "calendar", range: "today" }] },
		{ response: "Let me check.", needs: [{ source: "web", query: "a" }] },
		{ response: "Here's what I found.", needs: [{ source: "web", query: "b" }] }
	);
	const s = socket();
	await processAiResponse(session, ASKED, s.clients, {});
	expect(mockFetch).toHaveBeenCalledTimes(2);
	expect(mockGenerate).toHaveBeenCalledTimes(3);
	expect(s.text().text).toBe("Here's what I found.");
});

test("no extra filler when one was already spoken this turn", async () => {
	replies({ response: "Let me check.", needs: [{ source: "calendar", range: "today" }] }, { response: ANSWER });
	const s = socket();
	await processAiResponse(session, ASKED, s.clients, { fillerSpoken: "Let me check your calendar, hmm…" });
	expect(s.sent.find((m) => m.rpc === "filler")).toBeUndefined();
});

test("her own web search puts its links under the reply and tells the monologue", async () => {
	replies({ response: "Let me check.", needs: [{ source: "web", query: "Westlake fall festival hours" }] }, { response: "It runs 10 to 6." });
	mockFetch.mockResolvedValue({ blocks: ["# From the web\n10-6"], sources: [{ title: "westlake.gov", url: "u" }], read: ["web"] });
	const s = socket();
	await processAiResponse(session, "when's the fall festival open?", s.clients, {});
	expect(s.text().sources).toEqual([{ title: "westlake.gov", url: "u" }]);
	expect(mockReflect.mock.calls[0][0].searched).toBe(true);
	expect(mockGenerate.mock.calls[1][0].prefer).toBe("frontier");
});

test("a child is never offered lookups, and her needs are ignored", async () => {
	mockAudience.mockResolvedValue("child");
	memoryStore.buildMemoryContext.mockResolvedValueOnce({ audience: "child", memoryEnabled: true, promptBlock: null });
	replies({ response: "Hi there!", needs: [{ source: "web", query: "x" }] });
	await processAiResponse(session, "what's the weather", new Map(), {});
	expect(mockFetch).not.toHaveBeenCalled();
	expect(mockGeneratePrompt.mock.calls[0][3].needsBlock).toBeNull();
});

test("an explicit \"look it up\" still searches up front", async () => {
	replies({ response: "The Braves won." });
	mockBuildWeb.mockResolvedValue({ block: "# From the web", sources: [] });
	await processAiResponse(session, "look it up: who won the Braves game", new Map(), {});
	expect(mockBuildWeb).toHaveBeenCalled();
});
