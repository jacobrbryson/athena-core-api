/**
 * A turned-down proposal is not the end of the turn (2026-10-10).
 *
 * On 2026-10-09 "remind me when we get home from soccer" was rejected because
 * "home" wasn't one of the person's points of interest; the reply ended on
 * "scratch that" and the conversation died. Now she gets one second pass with
 * the reason in front of her — to fix it, offer something else, or ask — and
 * whatever she proposes there is checked exactly like the first.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn().mockResolvedValue([[]]) }));
jest.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }));

const mockGenerate = jest.fn();
const mockGeneratePrompt = jest.fn().mockResolvedValue([]);
const mockAttempt = jest.fn();
const mockRecordGap = jest.fn();

jest.mock("../services/message", () => ({ addMessage: jest.fn().mockResolvedValue("ai-uuid"), getMessages: jest.fn().mockResolvedValue([]) }));
jest.mock("../services/session", () => ({ updateSession: jest.fn().mockResolvedValue({}) }));
jest.mock("../services/sessionTopic", () => ({ getSessionTopics: jest.fn().mockResolvedValue([]) }));
jest.mock("../services/integration", () => ({ messageNeedsFamilyChores: () => false }));
jest.mock("../services/mission", () => ({}));
jest.mock("../services/toolIntent", () => ({ guess: jest.fn().mockResolvedValue(null), extraGrounding: () => null }));
jest.mock("../services/perception", () => ({ getPromptBlock: () => null }));
jest.mock("../services/codeAgents", () => ({ REPOS: {}, promptBlock: async () => null }));
jest.mock("../services/monologue", () => ({ reflect: async ({ draft }) => ({ reply: draft, web: null }) }));
jest.mock("../services/audience", () => ({ audienceForSession: async () => "adult" }));
jest.mock("../services/webSearch", () => ({ matches: () => false, buildContext: jest.fn() }));
jest.mock("../services/memoryStore", () => ({
	buildMemoryContext: jest.fn().mockResolvedValue({ audience: "adult", memoryEnabled: true, promptBlock: null }),
	afterTurn: jest.fn(),
}));
jest.mock("../services/actions", () => ({
	availableFor: async () => [{ id: "remind_at_place" }],
	listPending: async () => [],
	promptBlock: () => "# Things you can DO",
	pendingBlock: () => null,
	attempt: (...a) => mockAttempt(...a),
}));
jest.mock("../services/capabilityGaps", () => ({ record: (...a) => mockRecordGap(...a) }));
jest.mock("./prompt", () => ({ generatePrompt: mockGeneratePrompt, RESPONSE_SCHEMA: { type: "object" } }));
jest.mock("../services/llm", () => ({ generate: mockGenerate }));

const { processAiResponse } = require("./gemini");

const session = { id: 1, uuid: "s1", mode: "companion", profile_id: 42 };
const ASKED = "remind me to tell Ashlyn to text her brother after we get home from soccer tomorrow";
const base = { action: "NO_CHANGE", topic_name: "", new_proficiency: -1, is_factually_true: true };
const toHome = { id: "remind_at_place", params: { place: "home", reminder: "Tell Ashlyn to text her brother" } };
const toCalendar = { id: "create_calendar_event", params: { title: "Tell Ashlyn to text her brother", start: "2026-10-11T19:00:00-04:00", end: "2026-10-11T19:15:00-04:00" } };
const HOME_REJECTED = { stage: "params", reason: '"home" is not one of their points of interest; give its street address', actionId: "remind_at_place" };
const CARD = { uuid: "card-1", action_id: "create_calendar_event", status: "pending" };

/** Queue the replies the model gives, in order. */
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
	return { sent, clients, text: () => sent.find((m) => m.rpc === "addMessage")?.message.text, card: () => sent.find((m) => m.rpc === "actionProposed")?.action };
}

beforeEach(() => {
	jest.clearAllMocks();
	jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test("a proposal that goes through is not second-guessed", async () => {
	replies({ response: "Want me to put that on your calendar?", proposed_action: toCalendar });
	mockAttempt.mockResolvedValue({ proposal: CARD, rejected: null });
	const s = socket();
	await processAiResponse(session, ASKED, s.clients, {});
	expect(mockGenerate).toHaveBeenCalledTimes(1);
	expect(s.card()).toEqual(CARD);
	expect(mockRecordGap).not.toHaveBeenCalled();
});

test("turned down, she offers something else instead of ending on \"scratch that\"", async () => {
	const offer = "I don't have an address for home yet. I can put a 7pm alert on your calendar, or remind you when you pull in — which?";
	replies({ response: "I'll remind you when you get home.", proposed_action: toHome }, { response: offer });
	mockAttempt.mockResolvedValueOnce({ proposal: null, rejected: HOME_REJECTED });
	const s = socket();
	await processAiResponse(session, ASKED, s.clients, {});

	// The second pass saw exactly why.
	const repairContext = mockGeneratePrompt.mock.calls[1][3].integrationContext;
	expect(repairContext).toContain(HOME_REJECTED.reason);
	expect(repairContext).toContain("remind_at_place");
	expect(s.text()).toBe(offer);
	expect(s.text()).not.toMatch(/scratch that/i);
	expect(s.card()).toBeUndefined();
	expect(mockRecordGap).toHaveBeenCalledWith(expect.objectContaining({ profileId: 42, actionId: "remind_at_place", stage: "params", outcome: "offered", message: ASKED }));
});

test("turned down, she can fix it — and the fix is checked like any proposal", async () => {
	replies(
		{ response: "I'll remind you when you get home.", proposed_action: toHome },
		{ response: "Here's a 7pm alert on your calendar instead.", proposed_action: toCalendar }
	);
	mockAttempt.mockResolvedValueOnce({ proposal: null, rejected: HOME_REJECTED }).mockResolvedValueOnce({ proposal: CARD, rejected: null });
	const s = socket();
	await processAiResponse(session, ASKED, s.clients, {});

	expect(mockAttempt).toHaveBeenCalledTimes(2);
	expect(mockAttempt.mock.calls[1][2]).toMatchObject({ id: "create_calendar_event" });
	expect(s.card()).toEqual(CARD);
	expect(s.text()).toBe("Here's a 7pm alert on your calendar instead.");
	expect(mockRecordGap).toHaveBeenCalledWith(expect.objectContaining({ outcome: "repaired" }));
});

test("turned down twice, she says what was missing and asks for more", async () => {
	replies(
		{ response: "I'll remind you when you get home.", proposed_action: toHome },
		{ response: "Okay, setting it for home.", proposed_action: toHome }
	);
	mockAttempt.mockResolvedValue({ proposal: null, rejected: HOME_REJECTED });
	const s = socket();
	await processAiResponse(session, ASKED, s.clients, {});

	expect(mockAttempt).toHaveBeenCalledTimes(2);
	expect(s.text()).toMatch(/couldn't set that up — "home" is not one of your points of interest/);
	expect(s.text()).toMatch(/Tell me a little more/);
	expect(s.card()).toBeUndefined();
	expect(mockRecordGap).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
});

test("a standing execution that failed still shows its card, and she offers what's next", async () => {
	const failed = { ...CARD, status: "failed", error: "Calendar said no" };
	replies({ response: "Done — it's on your calendar.", proposed_action: toCalendar }, { response: "The calendar wouldn't take it. Want me to try a reminder on your phone instead?" });
	mockAttempt.mockResolvedValueOnce({ proposal: failed, rejected: { stage: "execute", reason: "Calendar said no", actionId: "create_calendar_event" } });
	const s = socket();
	await processAiResponse(session, ASKED, s.clients, {});

	expect(s.card()).toEqual(failed);
	expect(s.text()).toMatch(/Want me to try/);
});

test("a corrected card carries what it replaced to the client", async () => {
	replies({ response: "Moved it to 2:00.", proposed_action: { ...toCalendar, supersedes: "card-0" } });
	mockAttempt.mockResolvedValue({ proposal: { ...CARD, supersedes: "card-0" }, rejected: null });
	const s = socket();
	await processAiResponse(session, "a calendar event works but make it 2:00", s.clients, {});

	expect(mockAttempt.mock.calls[0][2].supersedes).toBe("card-0");
	expect(s.card().supersedes).toBe("card-0");
});
