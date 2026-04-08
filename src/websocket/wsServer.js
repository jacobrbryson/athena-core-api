const { WebSocketServer } = require("ws");
const url = require("url");
const { decodeUserToken } = require("../middleware/auth");
const { extractIp } = require("../helpers/utils");

const clients = new Map(); // sessionId => Set<ws>

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

		const requestIp = extractIp(req);
		const decoded = decodeUserToken(token, requestIp);
		if (!decoded) {
			console.warn("WS refused: invalid or mismatched token/IP");
			ws.close();
			return;
		}

		const sessionClients = clients.get(sessionId) || new Set();
		sessionClients.add(ws);
		clients.set(sessionId, sessionClients);

		console.log(
			`WS connected for session ${sessionId}. clients=${sessionClients.size}`
		);

		ws.send(
			JSON.stringify({
				type: "system",
				text: "Welcome to the chat WebSocket",
			})
		);

		ws.on("close", () => {
			const currentClients = clients.get(sessionId);
			if (currentClients) {
				currentClients.delete(ws);
				if (currentClients.size === 0) {
					clients.delete(sessionId);
				}
			}
			console.log(
				`WS disconnected: ${sessionId}. clients=${
					clients.get(sessionId)?.size || 0
				}`
			);
		});
	});

	return clients;
}

module.exports = { startWebSocketServer };
