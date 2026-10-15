const express = require("express");
const {
	getStatus,
	listPending,
	listRecent,
	confirm,
	decline,
	grantAuthority,
	revokeAuthority,
	perform,
} = require("../controllers/actions");
const { requireAuthOrDevice } = require("../middleware/auth");

const router = express.Router();

/**
 * Approving what Athena does. Open to the account owner in the browser and to
 * their paired phone or car, which is the point of the feature — the
 * controller refuses child tokens, and every query is scoped to the caller's
 * own profile.
 */
router.use(requireAuthOrDevice);

// What she can propose, what is standing-approved, what is waiting.
router.get("/", getStatus);
router.get("/pending", listPending);
router.get("/history", listRecent);

// Standing approvals. Declared BEFORE the /:uuid/* routes: an action id is a
// registry name, and the day someone adds an action called "confirm" the
// ordering would otherwise decide which handler wins.
router.post("/authority/:actionId", express.json(), grantAuthority);
router.delete("/authority/:actionId", revokeAuthority);

// A click in the app that is itself the approval (a chore's checkbox, its
// Undo). Only registry actions marked `direct` are accepted. Declared before
// the /:uuid/* routes for the same reason as /authority.
router.post("/direct/:actionId", express.json(), perform);

// The two buttons on a proposal card.
router.post("/:uuid/confirm", express.json(), confirm);
router.post("/:uuid/decline", express.json(), decline);

module.exports = router;
