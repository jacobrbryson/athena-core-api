// sessionLearningMoment.js
const pool = require("../helpers/db"); // Assuming this path to your DB connection pool

/**
 * Adds a new learning moment entry to the session_learning_moment table.
 * @param {number} sessionId The ID of the session the moment belongs to.
 * @param {number} topicId The ID of the associated topic.
 * @param {number} wisdomPoints The wisdom points earned (default 0).
 * @param {string} title The title of the learning moment.
 * @param {string} details The detailed description of the moment.
 * @returns {number} The ID of the newly inserted learning moment.
 */
async function addSessionLearningMoment(
	sessionId,
	topicId,
	wisdomPoints,
	title,
	details
) {
	const [result] = await pool.query(
		"INSERT INTO session_learning_moment (session_id, topic_id, wisdom_points, title, details) VALUES (?, ?, ?, ?, ?)",
		[sessionId, topicId, wisdomPoints, title, details]
	);

	// The insertId is available on the result object for MySQL INSERT queries
	return result.insertId;
}

/**
 * Retrieves all learning moments associated with a given session ID.
 * @param {number} sessionId The ID of the session.
 * @returns {Array<Object>} A list of session learning moment objects.
 */
async function getSessionLearningMoments(sessionId) {
	const [moments] = await pool.query(
		"SELECT id, topic_id, wisdom_points, title, details, created_at FROM session_learning_moment WHERE session_id = ? ORDER BY created_at DESC LIMIT 100;",
		[sessionId]
	);

	return moments;
}

module.exports = {
	addSessionLearningMoment,
	getSessionLearningMoments,
};
