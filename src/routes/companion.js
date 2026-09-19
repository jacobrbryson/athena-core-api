const express = require("express");
const companion = require("../controllers/companion");
const { requireAuth, requireAuthOrDevice } = require("../middleware/auth");

/**
 * Companion platform routes: model router status + device manifest, paired
 * devices, and camera perception. Memory v2 lives under /memory.
 */
const router = express.Router();

// Inherits the global access boundary, then authenticates and resolves the
// adult caller. No caller-supplied profile or provider URL is accepted.
router.get('/dashboard', requireAuth, require('../controllers/dashboard').summary);
router.get('/dashboard/priority', requireAuth, require('../controllers/dashboard').priority);
// News: the watch list is the person's, the interval is Athena's. There is no
// route for setting an interval by hand, by design — see services/news.
router.get('/dashboard/news', requireAuth, require('../controllers/dashboard').newsFeed);
router.get('/dashboard/news/sources', requireAuth, require('../controllers/dashboard').newsSources);
router.put('/dashboard/news/sources', requireAuth, express.json({ limit: '20kb' }), require('../controllers/dashboard').newsSources);
router.patch('/dashboard/news/sources/:uuid', requireAuth, express.json({ limit: '4kb' }), require('../controllers/dashboard').patchNewsSource);
router.delete('/dashboard/news/sources/:uuid', requireAuth, require('../controllers/dashboard').deleteNewsSource);
router.post('/dashboard/news/check', requireAuth, require('../controllers/dashboard').checkNews);

// Public: the on-device model manifest carries no secrets, and devices poll it
// before (and after) pairing.
router.get("/llm/manifest", companion.llmManifest);
// Public: redeem a pairing code — the short-lived code is the credential.
router.post("/devices/pair", express.json(), companion.redeemPairingCode);

router.get("/llm/status", requireAuthOrDevice, companion.llmStatus);
router.post("/llm/device-report", requireAuthOrDevice, companion.deviceReport);

// Where to reach a handset. Device-authenticated: only the device knows its
// own registration, and revoking the device revokes this with it.
router.post("/devices/push-token", requireAuthOrDevice, express.json(), companion.registerPushToken);
router.delete("/devices/push-token", requireAuthOrDevice, companion.forgetPushToken);

// Device management happens from the signed-in Companion app, never a device.
router.post("/devices/pairing-code", requireAuth, companion.createPairingCode);
router.get("/devices", requireAuth, companion.listDevices);
router.delete("/devices/:uuid", requireAuth, companion.revokeDevice);

router.post("/vision/observe", requireAuthOrDevice, companion.observe);
router.post("/vision/describe", requireAuthOrDevice, companion.describeScene);

// What Athena has asked to see. Read by whichever client is open; a request is
// something a client may honour, never something it must (services/lookRequests).
router.get("/vision/look-requests", requireAuthOrDevice, companion.listLookRequests);
router.post(
	"/vision/look-requests/:uuid/decline",
	requireAuthOrDevice,
	express.json(),
	companion.declineLookRequest
);

module.exports = router;
