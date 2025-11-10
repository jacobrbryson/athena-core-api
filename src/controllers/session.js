const pool = require("../helpers/db");
const { v4: uuidv4 } = require("uuid");

async function getOrCreateSession(req, res) {
	try {
		// Get IP address
		const ipAddress =
			req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
			req.socket.remoteAddress;

		// Check if a sessionId was provided in query params
		const sessionId = req.query.sessionId;

		if (sessionId) {
			// Check if session exists with this ID and IP
			const [rows] = await pool.query(
				"SELECT * FROM session WHERE uuid = ? AND ip_address = ?",
				[sessionId, ipAddress]
			);

			if (rows.length > 0) {
				// Session exists, return it
				return res.json({
					success: true,
					sessionId,
					ip: ipAddress,
					existing: true,
				});
			}
			// Optional: could also allow same sessionId from different IP?
		}

		// If no session or not found, create a new one
		const newSessionId = uuidv4();
		await pool.query(
			"INSERT INTO session (uuid, ip_address) VALUES (?, ?)",
			[newSessionId, ipAddress]
		);

		res.json({
			success: true,
			sessionId: newSessionId,
			ip: ipAddress,
			existing: false,
		});
	} catch (error) {
		console.error("Error creating/getting session:", error);
		res.status(500).json({ success: false, error: "DB query failed" });
	}
}

module.exports = getOrCreateSession;
