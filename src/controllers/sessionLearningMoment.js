const sessionLearningMomentService = require("../services/sessionLearningMoment");
const sessionService = require("../services/session");
const { extractIp } = require("../helpers/utils");
const { publicLearningMoment } = require("../helpers/serialize");

async function getLearningMoments(req, res) {
	try {
		const ip = extractIp(req);
		const uuid = req.params.sessionId;

		if (!uuid)
			return res
				.status(400)
				.json({ success: false, message: "Missing session UUID" });

		const session = await sessionService.getSessionByUuidAndIp(uuid, ip);
		if (!session)
			return res
				.status(404)
				.json({ success: false, message: "Session not found" });

		const topics =
			await sessionLearningMomentService.getSessionLearningMoments(
				session.id
			);

		const sanitizedMoments = topics.map(publicLearningMoment);

		res.json(sanitizedMoments);
	} catch (err) {
		console.error("Error fetching topics:", err);
		res.status(500).json({ success: false, message: "DB error" });
	}
}

module.exports = { getLearningMoments };
