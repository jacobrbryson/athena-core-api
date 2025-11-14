const sessionService = require("../services/session");
const { extractIp } = require("../helpers/utils");

async function getOrCreateSession(req, res) {
	try {
		const ipAddress = extractIp(req);

		const sessionId = req.query.sessionId;

		if (sessionId) {
			const session = await sessionService.getSessionByUuidAndIp(
				sessionId,
				ipAddress
			);

			if (session) {
				res.json({
					success: true,
					session: {
						uuid: session.uuid,
						wisdom_points: session.wisdom_points,
						age: session.age,
					},
				});

				return;
			}
		}

		const newSessionId = await sessionService.addSession(ipAddress);

		res.json({
			success: true,
			session: {
				uuid: newSessionId,
				wisdom_points: 0,
				age: 5,
			},
		});
	} catch (error) {
		console.error("Error creating/getting session:", error);
		res.status(500).json({ success: false, error: "DB query failed" });
	}
}

module.exports = getOrCreateSession;
