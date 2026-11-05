/**
 * GET /message/reply: hands-free holds one request for her reply instead of
 * polling the transcript, and gets it the moment it is saved — through the
 * same session check and viewer boundary as GET /message.
 */
jest.mock("../services/message", () => ({ getReplyAfter: jest.fn() }));
jest.mock("../services/session", () => ({ getAuthorizedSession: jest.fn() }));
jest.mock("../helpers/utils", () => ({ extractIp: () => "1.2.3.4" }));
jest.mock("../helpers/guardianToken", () => ({ decodeGuardianFromRequest: () => null }));
jest.mock("../services/guardianAuth", () => ({}));
jest.mock("../helpers/callerIdentity", () => ({ resolveCallerProfileId: jest.fn().mockResolvedValue(7) }));
jest.mock("../services/audience", () => ({ audienceForProfile: jest.fn() }));
jest.mock("./gemini", () => ({ processAiResponse: jest.fn() }));
jest.mock("../services/mission", () => ({ LAKE_NORMAN_ADVENTURE: "lake-norman", RATATOUILLE_ADVENTURE: "ratatouille" }));
jest.mock("../services/game", () => ({ applyGameMessage: jest.fn() }));
jest.mock("../websocket/wsServer", () => ({ broadcastToGuardian: jest.fn(), broadcastToAdventure: jest.fn() }));
jest.mock("../services/toolIntent", () => ({ guess: jest.fn() }));

const sessionService = require("../services/session");
const messageService = require("../services/message");
const { waitForReply } = require("./message");

const MINE = "0b7f6c1e-1f2a-4c3d-9e8f-123456789abc";

function ask(query) {
	const res = { status: jest.fn(() => res), json: jest.fn() };
	return waitForReply({ headers: {}, query: { sessionId: "sess-uuid", after: MINE, ...query }, once: jest.fn() }, res).then(() => res);
}

beforeEach(() => {
	jest.clearAllMocks();
	sessionService.getAuthorizedSession.mockResolvedValue({ id: 5, uuid: "sess-uuid", profile_id: 7 });
});

test("answers as soon as her reply is saved, for the caller's own view", async () => {
	const reply = { uuid: "r", text: "You have dinner at seven.", is_human: 0 };
	messageService.getReplyAfter.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(reply);
	const res = await ask({ waitMs: "5000" });
	expect(res.json).toHaveBeenCalledWith({ reply });
	expect(messageService.getReplyAfter).toHaveBeenCalledTimes(3);
	expect(messageService.getReplyAfter).toHaveBeenCalledWith(5, MINE, 7);
});

test("answers { reply: null } when the wait runs out, so the phone asks again", async () => {
	messageService.getReplyAfter.mockResolvedValue(null);
	const res = await ask({ waitMs: "300" });
	expect(res.json).toHaveBeenCalledWith({ reply: null });
});

test("a session the caller can't see, or a malformed message id, gets nothing", async () => {
	sessionService.getAuthorizedSession.mockResolvedValue(null);
	expect((await ask({})).status).toHaveBeenCalledWith(404);
	expect((await ask({ after: "1 OR 1=1" })).status).toHaveBeenCalledWith(400);
	expect(messageService.getReplyAfter).not.toHaveBeenCalled();
});
