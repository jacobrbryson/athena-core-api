const { v4: uuidv4 } = require("uuid");
const pool = require("../helpers/db");

async function addMessage(sessionId, isHuman, message) {
	const uuid = uuidv4();

	await pool.query(
		"INSERT INTO message (session_id, uuid, is_human, text) VALUES (?, ?, ?, ?)",
		[sessionId, uuid, isHuman, message]
	);

	return uuid;
}

async function getMessages(sessionId) {
	const [messages] = await pool.query(
		"SELECT uuid, text, created_at, is_human FROM message WHERE session_id = ? ORDER BY created_at ASC LIMIT 100;",
		[sessionId]
	);

	return messages;
}

module.exports = {
	addMessage,
	getMessages,
};
