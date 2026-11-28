jest.mock("../llm/adapters/gemini", () => ({ liveToken: jest.fn() }));
jest.mock("../needs", () => {
	const actual = jest.requireActual("../needsSchema");
	return {
		SOURCES: actual.SOURCE_IDS.map((id) => ({ id, doc: `doc for ${id}` })),
		available: jest.fn(),
		clean: jest.fn(),
		fetch: jest.fn(),
	};
});
jest.mock("../message", () => ({ getMessages: jest.fn(), addMessage: jest.fn() }));
jest.mock("../memoryStore", () => ({ afterTurn: jest.fn() }));
jest.mock("../memory", () => ({ getMemorySummaryForProfileId: jest.fn() }));
jest.mock("../audience", () => ({ audienceForSession: jest.fn(), memoryEnabledForProfile: jest.fn() }));
jest.mock("../selfKnowledge", () => ({ buildCapabilityBlock: jest.fn(() => "# What I can actually do\n- things") }));
jest.mock("../actions", () => ({ availableFor: jest.fn(), attempt: jest.fn(), confirmVerbal: jest.fn() }));
jest.mock("../../helpers/db", () => ({ query: jest.fn(async () => [[{ full_name: "Sam Rivers" }]]) }));

const gemini = require("../llm/adapters/gemini");
const needs = require("../needs");
const messageService = require("../message");
const memoryStore = require("../memoryStore");
const { getMemorySummaryForProfileId } = require("../memory");
const audience = require("../audience");
const { CORE_MISSION } = require("../../security/mission");
const actions = require("../actions");
const live = require(".");

const SESSION = { id: 11, uuid: "s-1", profile_id: 7, mode: "companion" };

beforeEach(() => {
	jest.clearAllMocks();
	audience.audienceForSession.mockResolvedValue("adult");
	audience.memoryEnabledForProfile.mockResolvedValue(true);
	needs.available.mockResolvedValue(["calendar", "weather", "web"]);
	getMemorySummaryForProfileId.mockResolvedValue([{ category: "family", key: "dog", value: "Wynter" }]);
	messageService.getMessages.mockResolvedValue([
		{ is_human: 1, text: "Morning" },
		{ is_human: 0, text: "Morning, Sam." },
	]);
	actions.availableFor.mockResolvedValue([{ id: "add_calendar_event", describe: "Add an event.", params: { title: "the title" } }]);
	gemini.liveToken.mockResolvedValue({ token: "auth_tokens/abc", expiresAt: "2026-11-28T12:30:00Z" });
});

describe("start", () => {
	test("locks her instructions, voice and tool into the token", async () => {
		const out = await live.start(SESSION, 7, { timeZone: "America/New_York" });
		expect(out).toMatchObject({ token: "auth_tokens/abc", model: live.MODEL, sources: ["calendar", "weather", "web"] });

		const { model, config } = gemini.liveToken.mock.calls[0][0];
		expect(model).toBe(live.MODEL);
		expect(config.responseModalities).toEqual(["AUDIO"]);
		expect(config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Aoede");
		expect(config.inputAudioTranscription).toEqual({});
		expect(config.outputAudioTranscription).toEqual({});

		const text = config.systemInstruction.parts[0].text;
		expect(text.startsWith(CORE_MISSION)).toBe(true);
		expect(text).toContain("to Sam");
		expect(text).toContain("dog: Wynter");
		expect(text).toContain("You: Morning, Sam.");
		expect(text).toContain("doc for calendar");
		expect(text).not.toContain("doc for email"); // not connected

		const decls = config.tools[0].functionDeclarations;
		expect(decls.map((d) => d.name)).toEqual(["look_up", "act", "end_conversation"]);
		const decl = decls[0];
		expect(decl.name).toBe("look_up");
		expect(decl.behavior).toBe("NON_BLOCKING");
		expect(decls[1].parameters.properties.action.enum).toEqual(["add_calendar_event"]);
		expect(text).toContain("## add_calendar_event");
		expect(text).toContain("IS their approval");
		expect(text).not.toMatch(/one to three sentences/);
		expect(decl.parameters.properties.needs.items.properties.source.enum).toEqual(["calendar", "weather", "web"]);
	});

	test("children never get a Live session, and no token is minted", async () => {
		audience.audienceForSession.mockResolvedValue("child");
		await expect(live.start(SESSION, 7)).rejects.toMatchObject({ status: 403 });
		expect(gemini.liveToken).not.toHaveBeenCalled();
	});

	test("no profile, no session", async () => {
		await expect(live.start(SESSION, null)).rejects.toMatchObject({ status: 403 });
		expect(gemini.liveToken).not.toHaveBeenCalled();
	});

	test("nothing connected: no tool is offered", async () => {
		needs.available.mockResolvedValue([]);
		await live.start(SESSION, 7);
		const { config } = gemini.liveToken.mock.calls[0][0];
		expect(config.tools[0].functionDeclarations.map((d) => d.name)).toEqual(["act", "end_conversation"]);
		expect(config.systemInstruction.parts[0].text).toContain("Nothing of theirs is connected");
	});

	test("an access refusal at the adapter is passed through", async () => {
		gemini.liveToken.mockRejectedValue(Object.assign(new Error("Guardian access or owner approval required"), { status: 403 }));
		await expect(live.start(SESSION, 7)).rejects.toMatchObject({ status: 403 });
	});
});

describe("lookUp", () => {
	test("model output goes through needs.clean against this person's sources", async () => {
		needs.clean.mockReturnValue([{ source: "calendar", range: "today" }]);
		needs.fetch.mockResolvedValue({ blocks: ["# Calendar\nSoccer 5:30"], sources: [] });
		const out = await live.lookUp(7, { needs: [{ source: "calendar", range: "today" }, { source: "email" }] });
		expect(needs.clean).toHaveBeenCalledWith(
			[{ source: "calendar", range: "today" }, { source: "email" }],
			["calendar", "weather", "web"],
			expect.any(Set),
			{ max: live.MAX_LOOKUPS }
		);
		expect(needs.fetch).toHaveBeenCalledWith(7, [{ source: "calendar", range: "today" }], expect.objectContaining({ audience: "adult" }));
		expect(out.result).toContain("Soccer 5:30");
	});

	test("nothing readable: nothing is fetched", async () => {
		needs.clean.mockReturnValue([]);
		const out = await live.lookUp(7, { needs: "garbage" });
		expect(needs.fetch).not.toHaveBeenCalled();
		expect(out.result).toMatch(/can be read/);
	});
});

describe("saveTurn", () => {
	test("writes both sides and runs memory extraction on what they said", async () => {
		messageService.addMessage.mockResolvedValueOnce("u-1").mockResolvedValueOnce("u-2");
		const out = await live.saveTurn(SESSION, 7, { heard: "  what's on tonight ", said: "Soccer at five thirty." });
		expect(out.saved).toEqual(["u-1", "u-2"]);
		expect(messageService.addMessage).toHaveBeenNthCalledWith(1, 11, true, "what's on tonight", "companion", 7);
		expect(messageService.addMessage).toHaveBeenNthCalledWith(2, 11, false, "Soccer at five thirty.", "companion", null);
		expect(memoryStore.afterTurn).toHaveBeenCalledWith(SESSION, "what's on tonight", { audience: "adult", memoryEnabled: true });
	});

	test("a cut-off reply is marked as cut off", async () => {
		await live.saveTurn(SESSION, 7, { heard: "stop", said: "So the thing about", interrupted: true });
		expect(messageService.addMessage).toHaveBeenLastCalledWith(11, false, "So the thing about —", "companion", null);
	});

	test("an empty exchange writes nothing", async () => {
		const out = await live.saveTurn(SESSION, 7, { heard: " ", said: "" });
		expect(out.saved).toEqual([]);
		expect(messageService.addMessage).not.toHaveBeenCalled();
	});
});
