const { WebSocketServer } = require("ws");
const url = require("url");
const { decodeUserToken } = require("../middleware/auth");
const { normalizeIp } = require("../helpers/utils");

const clients = new Map(); // sessionId => ws

function startWebSocketServer(server) {
	const wss = new WebSocketServer({ server });

	wss.on("connection", (ws, req) => {
		const { query } = url.parse(req.url, true);
		const sessionId = query.sessionId;

		if (!sessionId) {
			ws.close();
			return;
		}

		const authHeader =
			req.headers["x-user-authorization"] || req.headers.authorization;
		const token =
			authHeader && authHeader.startsWith("Bearer ")
				? authHeader.slice("Bearer ".length)
				: null;

		const requestIp = normalizeIp(req.socket.remoteAddress);
		const decoded = decodeUserToken(token, requestIp);
		if (!decoded) {
			console.warn("WS refused: invalid or mismatched token/IP");
			ws.close();
			return;
		}

		clients.set(sessionId, ws);

		console.log(`WS connected for session ${sessionId}`);

		ws.send(
			JSON.stringify({
				type: "system",
				text: "Welcome to the chat WebSocket",
			})
		);

		ws.on("close", () => {
			clients.delete(sessionId);
			console.log(`WS disconnected: ${sessionId}`);
		});
	});

	return clients;
}

module.exports = { startWebSocketServer };
