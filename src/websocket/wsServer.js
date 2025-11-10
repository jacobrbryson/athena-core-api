const { WebSocketServer } = require("ws");
const url = require("url");

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

		// ✅ Track client
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
