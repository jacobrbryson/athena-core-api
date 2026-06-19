const express = require("express");
const {
	getFamilyChoresStatus,
	disconnectFamilyChores,
	disconnectFamilyChoresByPartner,
	connectFamilyChores,
	suggestChores,
	suggestGhostChores,
	rememberFamilyChores,
	listAthenaChildren,
	connectAthenaChild,
	disconnectAthenaChild,
} = require("../controllers/integration");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// -------------------------------------------------------------------
// PUBLIC: partner-initiated (Family Chores backend → Athena). Authorized by
// the shared partner secret in the X-Partner-Key header, NOT by an Athena
// user JWT. Declared before requireAuth so they stay unauthenticated for
// Athena users.
// -------------------------------------------------------------------
router.post("/family-chores/connect", express.json(), connectFamilyChores);
router.post(
	"/family-chores/disconnect",
	express.json(),
	disconnectFamilyChoresByPartner
);
router.post("/family-chores/suggest-chores", express.json(), suggestChores);
router.post(
	"/family-chores/suggest-ghost-chores",
	express.json(),
	suggestGhostChores
);
router.post("/family-chores/remember", express.json(), rememberFamilyChores);
router.post("/family-chores/children", express.json(), listAthenaChildren);
router.post("/family-chores/connect-child", express.json(), connectAthenaChild);
router.post(
	"/family-chores/disconnect-child",
	express.json(),
	disconnectAthenaChild
);

// -------------------------------------------------------------------
// Everything below requires an authenticated Athena user.
// -------------------------------------------------------------------
router.use(requireAuth);

router.get("/family-chores", getFamilyChoresStatus);
router.delete("/family-chores", disconnectFamilyChores);

module.exports = router;
