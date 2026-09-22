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
router.get('/system/twilio-billing', requireAuth, require('../controllers/system').twilioBillingStatus);
// News: the watch list is the person's, the interval is Athena's. There is no
// route for setting an interval by hand, by design — see services/news.
router.get('/dashboard/news', requireAuth, require('../controllers/dashboard').newsFeed);
router.get('/dashboard/news/sources', requireAuth, require('../controllers/dashboard').newsSources);
router.put('/dashboard/news/sources', requireAuth, express.json({ limit: '20kb' }), require('../controllers/dashboard').newsSources);
router.patch('/dashboard/news/sources/:uuid', requireAuth, express.json({ limit: '4kb' }), require('../controllers/dashboard').patchNewsSource);
router.delete('/dashboard/news/sources/:uuid', requireAuth, require('../controllers/dashboard').deleteNewsSource);
router.post('/dashboard/news/check', requireAuth, require('../controllers/dashboard').checkNews);

// Nearby emergencies: the places watched for 911 calls (home, family homes),
// and what is active near them. Delivery is the athena-incidents job.
router.get('/dashboard/incidents', requireAuth, require('../controllers/nearbyIncidents').nearby);
router.get('/dashboard/alert', requireAuth, require('../controllers/nearbyIncidents').alert);
router.get('/dashboard/incidents/places', requireAuth, require('../controllers/nearbyIncidents').listPlaces);
router.put('/dashboard/incidents/places', requireAuth, express.json({ limit: '4kb' }), require('../controllers/nearbyIncidents').savePlace);
router.delete('/dashboard/incidents/places/:uuid', requireAuth, require('../controllers/nearbyIncidents').removePlace);
router.get('/dashboard/incidents/geocode', requireAuth, require('../controllers/nearbyIncidents').lookupAddress);
// The phone forwarding PulsePoint's own notifications — device-authenticated,
// because a handset speaks for itself (same rule as location samples).
router.post('/dashboard/incidents/phone-alert', requireAuthOrDevice, express.json({ limit: '8kb' }), require('../controllers/nearbyIncidents').phoneAlert);

// "Right now": one suggestion for the gap in front of them, and the two lists
// it is drawn from. The suggestion route reads; it never acts. Places are read
// on Athena's rhythm like news pages, so there is no route for setting one.
router.get('/dashboard/right-now', requireAuth, require('../controllers/rightNow').suggestion);
router.get('/dashboard/places', requireAuth, require('../controllers/rightNow').listPlaces);
router.post('/dashboard/places', requireAuth, express.json({ limit: '4kb' }), require('../controllers/rightNow').addPlace);
router.patch('/dashboard/places/:uuid', requireAuth, express.json({ limit: '4kb' }), require('../controllers/rightNow').patchPlace);
router.delete('/dashboard/places/:uuid', requireAuth, require('../controllers/rightNow').deletePlace);
router.post('/dashboard/places/:uuid/check', requireAuth, require('../controllers/rightNow').checkPlace);
router.get('/dashboard/projects', requireAuth, require('../controllers/rightNow').listProjects);
router.post('/dashboard/projects', requireAuth, express.json({ limit: '16kb' }), require('../controllers/rightNow').addProject);
router.patch('/dashboard/projects/:uuid', requireAuth, express.json({ limit: '16kb' }), require('../controllers/rightNow').patchProject);
router.delete('/dashboard/projects/:uuid', requireAuth, require('../controllers/rightNow').deleteProject);
// The one-time move out of a spreadsheet. 512kb is a few hundred rows of CSV.
router.post('/dashboard/projects/import', requireAuth, express.json({ limit: '600kb' }), require('../controllers/rightNow').importProjects);

// Mail: on-demand Gmail triage. Scanning and proposing are POSTs that call out
// (to the model / to Gmail via the action layer) so they get their own json
// limit rather than the bare express.json() used for small bodies elsewhere.
router.get('/dashboard/email', requireAuth, require('../controllers/email').list);
router.get('/dashboard/email/:uuid', requireAuth, require('../controllers/email').detail);
router.post('/dashboard/email/scan', requireAuth, express.json({ limit: '4kb' }), require('../controllers/email').scan);
router.post('/dashboard/email/group/propose', requireAuth, express.json({ limit: '16kb' }), require('../controllers/email').proposeGroup);
router.post('/dashboard/email/:uuid/propose', requireAuth, express.json({ limit: '8kb' }), require('../controllers/email').propose);
router.post('/dashboard/email/:uuid/dismiss', requireAuth, express.json({ limit: '1kb' }), require('../controllers/email').dismiss);

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
