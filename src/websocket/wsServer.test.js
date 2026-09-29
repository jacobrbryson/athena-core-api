/**
 * A socket hears every live message in the session it joins, so joining must
 * pass the same check as reading the transcript: a valid token for someone
 * with Athena access is not enough on its own.
 */
let onConnection;
jest.mock("ws", () => ({
	WebSocketServer: jest.fn(() => ({ on: (event, fn) => { if (event === "connection") onConnection = fn; } })),
}));
jest.mock("../middleware/auth", () => ({ decodeUserToken: jest.fn(() => ({ google_id: "g-1" })) }));
jest.mock("../helpers/utils", () => ({ extractIp: () => "1.2.3.4" }));
jest.mock("../security/access", () => ({ allowed: jest.fn().mockResolvedValue(true) }));
jest.mock("../helpers/callerIdentity", () => ({ resolveCallerProfileId: jest.fn().mockResolvedValue(7) }));
jest.mock("../services/session", () => ({ getAuthorizedSession: jest.fn() }));

const sessionService = require("../services/session");
const { startWebSocketServer } = require("./wsServer");

function socket() {
	const handlers = {};
	return {
		OPEN: 1,
		readyState: 1,
		send: jest.fn(),
		close: jest.fn(),
		on: (event, fn) => (handlers[event] = fn),
		handlers,
	};
}

function connect(sessionId) {
	const ws = socket();
	const req = { url: `/ws?sessionId=${sessionId}`, headers: { authorization: "Bearer t" } };
	return onConnection(ws, req).then(() => ws);
}

let clients;
beforeEach(() => {
	jest.clearAllMocks();
	jest.spyOn(console, "log").mockImplementation(() => {});
	jest.spyOn(console, "warn").mockImplementation(() => {});
	clients = startWebSocketServer({});
});

it("refuses a session the caller may not read, and never registers the socket", async () => {
	sessionService.getAuthorizedSession.mockResolvedValue(null);
	const ws = await connect("someone-elses-session");
	expect(sessionService.getAuthorizedSession).toHaveBeenCalledWith("someone-elses-session", {
		ip: "1.2.3.4",
		callerProfileId: 7,
	});
	expect(ws.close).toHaveBeenCalledWith(1008, "Not your conversation");
	expect(clients.has("someone-elses-session")).toBe(false);
});

it("joins the caller's own session, keyed by its stored uuid", async () => {
	sessionService.getAuthorizedSession.mockResolvedValue({ id: 1, uuid: "my-session" });
	const ws = await connect("my-session");
	expect(ws.close).not.toHaveBeenCalled();
	expect(clients.get("my-session").has(ws)).toBe(true);
	ws.handlers.close();
	expect(clients.has("my-session")).toBe(false);
});

it("fails closed when the session check itself fails", async () => {
	sessionService.getAuthorizedSession.mockRejectedValue(new Error("db down"));
	const ws = await connect("my-session");
	expect(ws.close).toHaveBeenCalledWith(1011, "Session verification unavailable");
	expect(clients.size).toBe(0);
});

it("answers with the plain protocol a browser offered, and none otherwise", () => {
	const { WebSocketServer } = require("ws");
	const { handleProtocols } = WebSocketServer.mock.calls[0][0];
	expect(handleProtocols(new Set(["athena.v1"]))).toBe("athena.v1");
	expect(handleProtocols(new Set(["something-else"]))).toBe(false);
});
