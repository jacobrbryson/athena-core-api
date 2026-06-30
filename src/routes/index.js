const express = require("express");

const getOrCreateSession = require("../controllers/session");
const { getMessage, addMessage } = require("../controllers/message");
const { getTopics } = require("../controllers/sessionTopic");
const {
	getLearningMoments,
} = require("../controllers/sessionLearningMoment");
const { validateCode } = require("../controllers/childAuth");
const { validateGuardian, redeemGuardianToken } = require("../controllers/guardianAuth");
const {
	getMissionFamilies,
	getMissionState,
	postMissionContribute,
} = require("../controllers/mission");
const { listModes } = require("../services/conversationMode");
const profileRouter = require("./profile");
const parentRouter = require("./parent");
const catalogRouter = require("./catalog");
const familyRouter = require("./family");
const consentRouter = require("./consent");
const memoryRouter = require("./memory");
const integrationRouter = require("./integration");

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

	// Guardian "Current Mission" panel: per-family onboarding status, scoped to
	// the caller's adventure (derived from the forwarded Guardian session JWT).
	router.get("/mission/families", getMissionFamilies);

	// Cooperative missions (Mission 2 "Convergence"): the caller's own piece +
	// live progress, and reporting a family's contribution. Adventure + family
	// are derived from the Guardian session JWT, so the piece can't be spoofed.
	router.get("/mission/state", getMissionState);
	router.post("/mission/contribute", postMissionContribute);

	// Public: conversation mode catalog (used by the chat mode switcher).
	router.get("/modes", async (req, res) => {
		try {
			res.json(await listModes());
		} catch (err) {
			console.error("[modes]", err.message);
			res.status(500).json({ success: false, message: "Failed to load modes" });
		}
	});

	// Public: child login-code redeem (proxy mints the JWT after this passes).
	router.post("/auth/child/validate", express.json(), validateCode);

	// Public: Guardian credential validation (proxy mints the JWT after this
	// passes). Returns a generic error on failure — never reveals which part
	// of the credential was wrong.
	router.post("/auth/guardian/validate", express.json(), validateGuardian);

	// Public: redeem a single-use QR login token (proxy mints the JWT after this
	// passes). Same generic-error contract as /validate.
	router.post("/auth/guardian/redeem-token", express.json(), redeemGuardianToken);

	router.use("/profile", profileRouter);
	router.use("/parent", parentRouter);
	router.use("/catalog", catalogRouter);
	router.use("/family", familyRouter);
	router.use("/consent", consentRouter);
	router.use("/memory", memoryRouter);
	router.use("/integrations", integrationRouter);

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
