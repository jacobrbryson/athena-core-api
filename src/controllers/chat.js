const pool = require("../helpers/db");
const { v4: uuidv4 } = require("uuid");

/**
 * Helper: get session by uuid and IP
 */
async function getSessionByUuidAndIp(uuid, ip) {
	const [rows] = await pool.query(
		"SELECT * FROM session WHERE uuid = ? AND ip_address = ?",
		[uuid, ip]
	);
	return rows[0];
}

async function getChatHandler(req, res) {
	try {
		const ip =
			req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
			req.socket.remoteAddress;
		const uuid = req.query.sessionId;

		if (!uuid)
			return res
				.status(400)
				.json({ success: false, error: "Missing session UUID" });

		const session = await getSessionByUuidAndIp(uuid, ip);
		if (!session)
			return res
				.status(404)
				.json({ success: false, error: "Session not found" });

		const [chats] = await pool.query(
			"SELECT uuid, message, created_at, is_human FROM chat WHERE session_id = ? ORDER BY created_at ASC",
			[session.id]
		);

		res.json({ success: true, session: uuid, chats });
	} catch (err) {
		console.error("Error fetching chat:", err);
		res.status(500).json({ success: false, error: "DB error" });
	}
}

async function addChatHandler(req, res, clients) {
	try {
		const ip =
			req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
			req.socket.remoteAddress;
		const { sessionId, message } = req.body;

		if (!sessionId || !message)
			return res
				.status(400)
				.json({ success: false, error: "Missing UUID or message" });

		const session = await getSessionByUuidAndIp(sessionId, ip);
		if (!session)
			return res
				.status(404)
				.json({ success: false, error: "Session not found" });

		const uuid = uuidv4();

		await pool.query(
			"INSERT INTO chat (session_id, uuid, is_human, message) VALUES (?, ?, ?, ?)",
			[session.id, uuid, true, message]
		);

		// ✅ Send JSON response to HTTP caller
		res.json({
			success: true,
			chatId: uuid,
			sessionId: sessionId,
			message,
		});

		// ✅ WebSocket push to the user
		const ws = clients.get(sessionId);

		if (ws && ws.readyState === ws.OPEN) {
			ws.send(
				JSON.stringify({
					type: "human",
					chatId: uuid,
					message,
					timestamp: Date.now(),
				})
			);
		}
	} catch (err) {
		console.error("Error adding chat:", err);
		res.status(500).json({ success: false, error: "DB error" });
	}
}

module.exports = {
	getChatHandler,
	addChatHandler,
};
