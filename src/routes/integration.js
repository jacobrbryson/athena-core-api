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
const {
	requireKnownProvider,
	listConnectors,
	getConnector,
	startConnect,
	handleCallback,
	disconnectConnector,
} = require("../controllers/connectors");
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
// PUBLIC: OAuth callback. The provider redirects a BROWSER here, so there is
// no Athena JWT to check (and the session JWT is IP-pinned, so it could not
// be relied on regardless). Identity comes from the single-use `state`
// recorded when the flow started — see services/connectors/oauth.js.
// Declared before requireAuth on purpose.
// -------------------------------------------------------------------
router.get("/:provider/callback", requireKnownProvider, handleCallback);

// -------------------------------------------------------------------
// Everything below requires an authenticated Athena user.
// -------------------------------------------------------------------
router.use(requireAuth);

// Family Chores keeps its own routes; declared before the generic
// /:provider ones so the more specific path wins.
router.get("/family-chores", getFamilyChoresStatus);
router.delete("/family-chores", disconnectFamilyChores);

// Generic OAuth connectors (Google Calendar, Strava, Whoop). Each acts only
// on the caller's own profile — never a profile id taken from the request.
router.get("/", listConnectors);
router.post(
	"/:provider/connect",
	requireKnownProvider,
	express.json(),
	startConnect
);
router.get("/:provider", requireKnownProvider, getConnector);
router.delete("/:provider", requireKnownProvider, disconnectConnector);

module.exports = router;
