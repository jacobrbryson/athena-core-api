const { v4: uuidv4 } = require("uuid");
const pool = require("../helpers/db");
const { buildUpdateClauses } = require("../helpers/query");

/**
 * Creates a new session record in the database.
 * @param {string} ipAddress The IP address of the user.
 * @returns {Promise<string>} The UUID of the new session.
 */
async function addSession(ipAddress) {
	const sessionId = uuidv4();
	await pool.query(
		"INSERT INTO session (uuid, ip_address) VALUES (?, ?)",
		[sessionId, ipAddress]
	);

	return sessionId;
}

/**
 * Retrieves a session record by its UUID and IP address.
 * @param {string} uuid The session UUID.
 * @param {string} ip The IP address.
 * @returns {Promise<object | undefined>} The session record or undefined.
 */
async function getSessionByUuidAndIp(uuid, ip) {
	const [rows] = await pool.query(
		`SELECT 
    s.id,
    s.ip_address,
		s.uuid,
		s.created_at,
		s.age,
		s.is_busy,
		s.wisdom_points,
    (
      SELECT COUNT(*) 
      FROM message m2 
      WHERE m2.session_id = s.id
        AND m2.created_at >= NOW() - INTERVAL 24 HOUR
    ) AS session_message_count_24h,
    -- Count of messages for all sessions with this IP in past 24h
    (
      SELECT COUNT(*) 
      FROM message m3
      JOIN session s2 ON s2.id = m3.session_id
      WHERE s2.ip_address = s.ip_address
        AND m3.created_at >= NOW() - INTERVAL 24 HOUR
    ) AS ip_message_count_24h
FROM session s
WHERE s.uuid = ?
  AND s.ip_address = ? LIMIT 1;`,
		[uuid, ip]
	);

	return rows[0];
}

/**
 * Safely updates specific fields in a session record.
 * Only 'age' (number) and 'is_busy' (boolean) are allowed for update.
 * @param {string} uuid The session UUID to update.
 * @param {object} updates Object containing keys to update (e.g., {age: 30, is_busy: true}).
 * @returns {Promise<object>} The result object from the database query.
 */
async function updateSession(sessionId, updates) {
	const allowedUpdates = {
		age: "number",
		is_busy: "boolean",
		wisdom_points: "number",
	};

	try {
		const { setClauses, values } = buildUpdateClauses(
			updates,
			allowedUpdates
		);
		const queryValues = [...values, sessionId];
		const sql = `UPDATE session SET ${setClauses} WHERE id = ?`;

		const [result] = await pool.query(sql, queryValues);
		return result;
	} catch (error) {
		console.error(
			`[Session Service] Failed to update session ${sessionId}:`,
			error.message
		);
		return { message: error.message };
	}
}

module.exports = {
	addSession,
	getSessionByUuidAndIp,
	updateSession,
};
