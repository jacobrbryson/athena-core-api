const { v4: uuidv4 } = require("uuid");
const pool = require("../helpers/db");
const { buildUpdateClauses } = require("../helpers/query");

/**
 * Creates a new session record in the database.
 * @param {string} ipAddress The IP address of the user.
 * @returns {Promise<string>} The UUID of the new session.
 */
async function addSession(ipAddress, options = {}) {
	const sessionId = uuidv4();
	const mode =
		typeof options.mode === "string" && options.mode.trim()
			? options.mode.trim()
			: "teach";
	const profileId = Number.isFinite(Number(options.profileId))
		? Number(options.profileId)
		: null;
	const familyId = Number.isFinite(Number(options.familyId))
		? Number(options.familyId)
		: null;

	await pool.query(
		"INSERT INTO session (uuid, ip_address, mode, profile_id, family_id) VALUES (?, ?, ?, ?, ?)",
		[sessionId, ipAddress, mode, profileId, familyId]
	);

	return sessionId;
}

/** Resolve a profile.id (and its family) from a profile uuid, or null. */
async function resolveProfileBinding(profileUuid) {
	if (typeof profileUuid !== "string" || !profileUuid.trim()) return {};
	const [rows] = await pool.query(
		`SELECT p.id AS profile_id, cp.family_id
     FROM profile p
     LEFT JOIN child_profiles cp ON cp.profile_id = p.id
     WHERE p.uuid = ? LIMIT 1;`,
		[profileUuid.trim()]
	);
	if (!rows.length) return {};
	return { profileId: rows[0].profile_id, familyId: rows[0].family_id || null };
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
		s.mode,
		s.profile_id,
		s.family_id,
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
		mode: "string",
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

/**
 * Bind a previously-unbound session to a profile (and its family). Used to
 * upgrade an anonymous/IP-bound session once we know the acting profile (e.g.
 * a logged-in parent whose first session was created before their profile was
 * resolved). The `profile_id IS NULL` guard means an already-bound session is
 * never silently reassigned.
 */
async function bindSessionProfile(sessionId, profileId, familyId = null) {
	if (!Number.isFinite(Number(profileId))) return { affectedRows: 0 };
	const [result] = await pool.query(
		`UPDATE session SET profile_id = ?, family_id = ?
		 WHERE id = ? AND profile_id IS NULL`,
		[Number(profileId), Number.isFinite(Number(familyId)) ? Number(familyId) : null, sessionId]
	);
	return result;
}

module.exports = {
	addSession,
	getSessionByUuidAndIp,
	updateSession,
	resolveProfileBinding,
	bindSessionProfile,
};
