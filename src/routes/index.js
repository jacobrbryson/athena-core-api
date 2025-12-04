const express = require("express");

const getOrCreateSession = require("../controllers/session");
const { getMessage, addMessage } = require("../controllers/message");
const { getTopics } = require("../controllers/sessionTopic");
const {
	getLearningMoments,
} = require("../controllers/sessionLearningMoment");
const profileRouter = require("./profile");
const parentRouter = require("./parent");

/**
 * Router factory
 * @param {Map<string, WebSocket>} clients - map of sessionId -> WebSocket
 * @returns {Router}
 */
module.exports = (clients) => {
	const router = express.Router();

	router.get("/session", getOrCreateSession);
	router.get("/session/:sessionId/topic", getTopics);
	router.get("/session/:sessionId/learning-moment", getLearningMoments);
	router.get("/message", getMessage);
	router.post("/message", (req, res) => addMessage(req, res, clients));
	router.use("/profile", profileRouter);
	router.use("/parent", parentRouter);

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
