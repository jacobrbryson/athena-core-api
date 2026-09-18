const express = require("express");
const {
	getStatus,
	getPending,
	updatePref,
	react,
	mute,
	unmute,
	resumeTrigger,
} = require("../controllers/initiative");
const { requireAuthOrDevice } = require("../middleware/auth");

const router = express.Router();

/**
 * Athena speaking first. Open to the account owner and their paired phone or
 * car — the car is arguably where an unprompted "your 2pm is in fifteen
 * minutes" is worth the most. The controller refuses child tokens and scopes
 * every query to the caller's own profile.
 */
router.use(requireAuthOrDevice);

router.get("/", getStatus);
// Fetching marks them delivered — see the controller.
router.get("/pending", getPending);
router.put("/pref", express.json(), updatePref);

// Mutes before /:uuid/* so a trigger id can never be read as a nudge uuid.
router.post("/mute/:triggerId", express.json(), mute);
router.delete("/mute/:triggerId", unmute);

// Undo a suppression Athena applied to herself. Same shape as a mute, and
// declared alongside it so both live above the /:uuid/* routes.
router.post("/resume/:triggerId", express.json(), resumeTrigger);

router.post("/:uuid/react", express.json(), react);

module.exports = router;
