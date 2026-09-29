/**
 * /message and the spoken filler: a client that asks for one gets "Let me
 * check your calendar, hmm…" in the acknowledgement, the reply is told it was
 * said, and the guess is made once and handed on — never for a child.
 */
jest.mock("../services/message", () => ({ addMessage: jest.fn().mockResolvedValue("human-uuid") }));
jest.mock("../services/session", () => ({
	getAuthorizedSession: jest.fn(),
	updateSession: jest.fn().mockResolvedValue({}),
}));
jest.mock("../helpers/utils", () => ({ extractIp: () => "1.2.3.4" }));
jest.mock("../helpers/guardianToken", () => ({ decodeGuardianFromRequest: () => null }));
jest.mock("../services/guardianAuth", () => ({}));
jest.mock("../helpers/callerIdentity", () => ({ resolveCallerProfileId: jest.fn().mockResolvedValue(7) }));
jest.mock("../services/audience", () => ({ audienceForProfile: jest.fn() }));
jest.mock("./gemini", () => ({ processAiResponse: jest.fn() }));
jest.mock("../services/mission", () => ({ LAKE_NORMAN_ADVENTURE: "lake-norman", RATATOUILLE_ADVENTURE: "ratatouille" }));
jest.mock("../services/game", () => ({ applyGameMessage: jest.fn().mockResolvedValue(null) }));
jest.mock("../websocket/wsServer", () => ({ broadcastToGuardian: jest.fn(), broadcastToAdventure: jest.fn() }));
jest.mock("../services/toolIntent", () => ({ guess: jest.fn() }));

const sessionService = require("../services/session");
const { audienceForProfile } = require("../services/audience");
const { processAiResponse } = require("./gemini");
const toolIntent = require("../services/toolIntent");
const { addMessage } = require("./message");

const FILLER = { key: "calendar", text: "Let me check your calendar, hmm…" };

function send(companion) {
	const res = { status: jest.fn(() => res), json: jest.fn(), headersSent: false };
	const req = {
		body: { sessionId: "sess-uuid", text: "Do I have anything going on tonight?", companion },
		headers: {},
	};
	return addMessage(req, res, new Map()).then(() => res);
}

beforeEach(() => {
	jest.clearAllMocks();
	sessionService.getAuthorizedSession.mockResolvedValue({
		id: 1,
		uuid: "sess-uuid",
		profile_id: 7,
		mode: "companion",
		session_message_count_24h: 0,
		ip_message_count_24h: 0,
	});
	audienceForProfile.mockResolvedValue("adult");
	toolIntent.guess.mockResolvedValue({ fetch: ["calendar"], announce: ["calendar"], filler: FILLER });
});

it("hands a filler-playing client its line and tells the reply it was said", async () => {
	const res = await send({ device: "android", handsFree: true, filler: true });
	expect(res.json.mock.calls[0][0].filler).toEqual(FILLER);
	const ctx = processAiResponse.mock.calls[0][3];
	expect(ctx.fillerSpoken).toBe(FILLER.text);
	expect(toolIntent.guess).toHaveBeenCalledTimes(1);
});

it("still guesses for grounding, but neither waits nor sends a filler, when the client can't play one", async () => {
	const res = await send({ device: "web" });
	expect(res.json.mock.calls[0][0]).not.toHaveProperty("filler");
	const ctx = processAiResponse.mock.calls[0][3];
	expect(ctx.fillerSpoken).toBeUndefined();
	// The reply reuses this same guess rather than asking Jev again.
	expect(ctx.guessPromise).toBeInstanceOf(Promise);
	expect(toolIntent.guess).toHaveBeenCalledTimes(1);
});

it("never guesses for a child", async () => {
	audienceForProfile.mockResolvedValue("child");
	const res = await send({ device: "android", filler: true });
	expect(toolIntent.guess).not.toHaveBeenCalled();
	expect(res.json.mock.calls[0][0]).not.toHaveProperty("filler");
});

it("sends no filler when the guess had nothing to announce, or failed", async () => {
	toolIntent.guess.mockResolvedValue({ fetch: [], announce: [], filler: null });
	let res = await send({ device: "android", filler: true });
	expect(res.json.mock.calls[0][0]).not.toHaveProperty("filler");

	toolIntent.guess.mockRejectedValue(new Error("Jev down"));
	res = await send({ device: "android", filler: true });
	expect(res.json.mock.calls[0][0]).not.toHaveProperty("filler");
	expect(res.status).not.toHaveBeenCalledWith(500);
});
