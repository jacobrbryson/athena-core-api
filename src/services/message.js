const { v4: uuidv4 } = require("uuid");
const pool = require("../helpers/db");

async function addMessage(sessionId, isHuman, message, mode = null) {
	const uuid = uuidv4();

	await pool.query(
		"INSERT INTO message (session_id, uuid, is_human, text, mode) VALUES (?, ?, ?, ?, ?)",
		[sessionId, uuid, isHuman, message, mode]
	);

	return uuid;
}

/**
 * The most recent 100 messages, oldest -> newest. Selecting the newest page
 * and re-sorting matters: a plain `ASC LIMIT 100` returns a long session's
 * FIRST 100 messages, so replies stopped appearing after message 100.
 */
async function getMessages(sessionId) {
	const [messages] = await pool.query(
		`SELECT uuid, text, created_at, is_human, mode FROM (
       SELECT uuid, text, created_at, is_human, mode FROM message
       WHERE session_id = ? ORDER BY created_at DESC LIMIT 100
     ) recent ORDER BY created_at ASC;`,
		[sessionId]
	);

	return messages;
}

/** Messages strictly newer than `since` (a DATETIME), oldest -> newest. */
async function getMessagesSince(sessionId, since, limit = 40) {
	const [messages] = await pool.query(
		`SELECT uuid, text, created_at, is_human FROM message
     WHERE session_id = ?${since ? " AND created_at > ?" : ""}
     ORDER BY created_at ASC LIMIT ?;`,
		since ? [sessionId, since, limit] : [sessionId, limit]
	);
	return messages;
}

module.exports = {
	addMessage,
	getMessages,
	getMessagesSince,
};
