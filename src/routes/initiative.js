const express = require("express");
const {
	getStatus,
	getDiagnostics,
	getWebPushKey,
	registerWebPush,
	forgetWebPush,
	startSms,
	confirmSms,
	forgetSms,
	testNotification,
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
// Why she is quiet. Above /:uuid/* like the mutes, and a GET because it only
// ever reports — ?evaluate=1 runs the real triggers without writing anything.
router.get("/diagnostics", getDiagnostics);
// This browser's own subscription. Session-authenticated rather than
// device-authenticated: a browser has nowhere safe to keep a device token.
router.get("/web-push", getWebPushKey);
router.put("/web-push", express.json(), registerWebPush);
router.delete("/web-push", forgetWebPush);
// A phone number, which has to prove it is theirs before she will text it.
router.post("/sms", express.json(), startSms);
router.put("/sms", express.json(), confirmSms);
router.delete("/sms", forgetSms);
// Proves the path to this person's own devices. A person asking to be
// notified is not an interruption, so it skips the budget and writes no nudge.
router.post("/test-notification", express.json(), testNotification);
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
