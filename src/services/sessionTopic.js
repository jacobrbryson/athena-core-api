// sessionTopic.js
const pool = require("../helpers/db"); // Assuming this path to your DB connection pool

/**
 * Adds a new topic entry to the session_topic table.
 * @param {number} sessionId The ID of the session the topic belongs to.
 * @param {string} topicName The name of the topic.
 * @param {number | null} proficiency The proficiency score (DECIMAL(5,2)). Can be null.
 * @returns {number} The ID of the newly inserted topic.
 */
async function addSessionTopic(sessionId, topicName, proficiency = 0) {
	const [result] = await pool.query(
		"INSERT INTO session_topic (session_id, topic_name, proficiency) VALUES (?, ?, ?)",
		[sessionId, topicName, proficiency]
	);

	// The insertId is available on the result object for MySQL INSERT queries
	return result.insertId;
}

/**
 * Retrieves all topics associated with a given session ID.
 * @param {number} sessionId The ID of the session.
 * @returns {Array<Object>} A list of session topic objects.
 */
async function getSessionTopics(sessionId) {
	const [topics] = await pool.query(
		"SELECT id, topic_name, proficiency, created_at FROM session_topic WHERE session_id = ? AND proficiency < 100 ORDER BY proficiency DESC LIMIT 100;",
		[sessionId]
	);

	return topics;
}

async function updateSessionTopic(sessionId, topicName, proficiency) {
	const [result] = await pool.query(
		"UPDATE session_topic SET proficiency = ? WHERE session_id = ? AND topic_name = ?",
		[proficiency, sessionId, topicName]
	);
}

module.exports = {
	addSessionTopic,
	getSessionTopics,
	updateSessionTopic,
};
