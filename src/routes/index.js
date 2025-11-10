const express = require("express");

const getOrCreateSession = require("../controllers/session");
const { getChatHandler, addChatHandler } = require("../controllers/chat");

/**
 * Router factory
 * @param {Map<string, WebSocket>} clients - map of sessionId -> WebSocket
 * @returns {Router}
 */
module.exports = (clients) => {
	const router = express.Router();

	router.get("/public/session", getOrCreateSession);
	router.get("/public/chat", getChatHandler);

	// Pass clients into addChatHandler
	router.post("/public/chat", (req, res) =>
		addChatHandler(req, res, clients)
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
