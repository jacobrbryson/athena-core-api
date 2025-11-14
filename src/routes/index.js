const express = require("express");

const getOrCreateSession = require("../controllers/session");
const { getMessage, addMessage } = require("../controllers/message");
const { getTopics } = require("../controllers/sessionTopic");
const {
	getLearningMoments,
} = require("../controllers/sessionLearningMoment");

/**
 * Router factory
 * @param {Map<string, WebSocket>} clients - map of sessionId -> WebSocket
 * @returns {Router}
 */
module.exports = (clients) => {
	const router = express.Router();

	router.get("/public/session", getOrCreateSession);
	router.get("/public/session/:sessionId/topic", getTopics);
	router.get(
		"/public/session/:sessionId/learning-moment",
		getLearningMoments
	);
	router.get("/public/message", getMessage);
	router.post("/public/message", (req, res) =>
		addMessage(req, res, clients)
	);

	// Optional catch-all
	router.use((req, res) => {
		console.log(`API Service: Received request for ${req.url}`);
		res.status(200).json({
			message: "Data successfully fetched from the main API service.",
			timestamp: new Date().toISOString(),
		});
	});

	return router;
};
