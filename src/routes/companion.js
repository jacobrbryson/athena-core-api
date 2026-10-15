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
// Hands-free: the phone's timing of each turn, stage by stage. Logged, not
// stored, and never the person's words (controllers/handsFree.js).
router.post('/handsfree/turn', requireAuth, express.json({ limit: '4kb' }), require('../controllers/handsFree').recordTurn);
router.get('/dashboard/priority', requireAuth, require('../controllers/dashboard').priority);
router.get('/system/twilio-billing', requireAuth, require('../controllers/system').twilioBillingStatus);
router.get('/system/openai-billing', requireAuth, require('../controllers/system').openaiBillingStatus);
router.get('/system/gcp-billing', requireAuth, require('../controllers/system').gcpBillingStatus);
router.get('/system/health', requireAuth, require('../controllers/system').healthStatus);
router.get('/system/time-saved', requireAuth, require('../controllers/system').timeSavedStatus);
// The Dreams log: what Athena did in her own database overnight, told plainly
// and as a dream. Read-only; statements leave redacted (services/dreams/redact).
router.get('/dreams', requireAuth, require('../controllers/dreams').list);
router.get('/dreams/latest', requireAuth, require('../controllers/dreams').latest);
router.get('/dreams/questions', requireAuth, require('../controllers/dreams').questions);
router.post('/dreams/questions/:uuid/dismiss', requireAuth, require('../controllers/dreams').dismissQuestion);
router.get('/dreams/:uuid', requireAuth, require('../controllers/dreams').night);
router.get('/dreams/:uuid/image', requireAuth, require('../controllers/dreams').picture);
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
router.post('/dashboard/alert/ack', requireAuth, express.json({ limit: '2kb' }), require('../controllers/nearbyIncidents').acknowledgeAlert);
// "Acknowledge" on a phone notification — the Android app, with its device token.
router.post('/dashboard/notifications/:uuid/ack', requireAuthOrDevice, express.json({ limit: '1kb' }), require('../controllers/nearbyIncidents').acknowledgePush);
router.get('/dashboard/incidents/places', requireAuth, require('../controllers/nearbyIncidents').listPlaces);
router.put('/dashboard/incidents/places', requireAuth, express.json({ limit: '4kb' }), require('../controllers/nearbyIncidents').savePlace);
router.delete('/dashboard/incidents/places/:uuid', requireAuth, require('../controllers/nearbyIncidents').removePlace);
router.get('/dashboard/incidents/geocode', requireAuth, require('../controllers/nearbyIncidents').lookupAddress);
// Test PulsePoint / weather alert: a made-up call at their own place, pushed.
router.post('/dashboard/incidents/test', requireAuth, express.json({ limit: '1kb' }), require('../controllers/nearbyIncidents').testAlert);
// The phone forwarding PulsePoint's own notifications — device-authenticated,
// because a handset speaks for itself (same rule as location samples).
router.post('/dashboard/incidents/phone-alert', requireAuthOrDevice, express.json({ limit: '8kb' }), require('../controllers/nearbyIncidents').phoneAlert);

// Websites: the sites the person manages and their Search Console / Analytics
// numbers (read-only). Shown on the Projects page.
router.get('/dashboard/websites', requireAuth, require('../controllers/websites').list);
router.get('/dashboard/websites/discover', requireAuth, require('../controllers/websites').discover);
router.post('/dashboard/websites', requireAuth, express.json({ limit: '2kb' }), require('../controllers/websites').save);
router.post('/dashboard/websites/refresh', requireAuth, require('../controllers/websites').refresh);
router.patch('/dashboard/websites/:uuid', requireAuth, express.json({ limit: '2kb' }), require('../controllers/websites').update);
router.post('/dashboard/websites/:uuid/refresh', requireAuth, require('../controllers/websites').refresh);
router.delete('/dashboard/websites/:uuid', requireAuth, require('../controllers/websites').remove);

// Workplaces: where the person works, their role there, and the connections
// and email addresses that belong to each. Shown on Work.
router.get('/dashboard/workplaces', requireAuth, require('../controllers/workplaces').list);
router.post('/dashboard/workplaces', requireAuth, express.json({ limit: '2kb' }), require('../controllers/workplaces').save);
router.patch('/dashboard/workplaces/:uuid', requireAuth, express.json({ limit: '2kb' }), require('../controllers/workplaces').update);
router.delete('/dashboard/workplaces/:uuid', requireAuth, require('../controllers/workplaces').remove);
router.post('/dashboard/workplaces/:uuid/links', requireAuth, express.json({ limit: '1kb' }), require('../controllers/workplaces').link);
router.delete('/dashboard/workplaces/:uuid/links/:linkUuid', requireAuth, require('../controllers/workplaces').unlink);

// Community: points of interest (the places above, with what they are),
// neighbours and local events — typed by the person, read into chat.
router.get('/dashboard/community', requireAuth, require('../controllers/community').overview);
router.get('/dashboard/community/calendar', requireAuth, require('../controllers/community').calendar);
router.get('/dashboard/community/contacts', requireAuth, require('../controllers/community').searchContacts);
router.get('/dashboard/community/contacts/at', requireAuth, require('../controllers/community').contactsAtAddress);
router.post('/dashboard/community/neighbors', requireAuth, express.json({ limit: '4kb' }), require('../controllers/community').saveNeighbor);
router.patch('/dashboard/community/neighbors/:uuid', requireAuth, express.json({ limit: '4kb' }), require('../controllers/community').updateNeighbor);
router.delete('/dashboard/community/neighbors/:uuid', requireAuth, require('../controllers/community').removeNeighbor);
// Door-to-door street checks: a street listed ahead of time, then each house marked.
router.get('/dashboard/community/door-rounds', requireAuth, require('../controllers/doorToDoor').list);
router.post('/dashboard/community/door-rounds', requireAuth, express.json({ limit: '1kb' }), require('../controllers/doorToDoor').start);
router.get('/dashboard/community/door-rounds/:uuid', requireAuth, require('../controllers/doorToDoor').get);
router.post('/dashboard/community/door-rounds/:uuid/doors', requireAuth, express.json({ limit: '1kb' }), require('../controllers/doorToDoor').addDoor);
router.post('/dashboard/community/door-rounds/:uuid/sync', requireAuth, express.json({ limit: '256kb' }), require('../controllers/doorToDoor').sync);
router.post('/dashboard/community/door-rounds/:uuid/close', requireAuth, express.json({ limit: '1kb' }), require('../controllers/doorToDoor').close);
router.delete('/dashboard/community/door-rounds/:uuid', requireAuth, require('../controllers/doorToDoor').remove);
router.post('/dashboard/community/events', requireAuth, express.json({ limit: '4kb' }), require('../controllers/community').saveEvent);
router.patch('/dashboard/community/events/:uuid', requireAuth, express.json({ limit: '4kb' }), require('../controllers/community').updateEvent);
router.delete('/dashboard/community/events/:uuid', requireAuth, require('../controllers/community').removeEvent);

// "Right now": one suggestion for the gap in front of them, and the places
// list it draws on (projects live under /projects). The suggestion route reads; it never acts. Places are read
// on Athena's rhythm like news pages, so there is no route for setting one.
router.get('/dashboard/right-now', requireAuth, require('../controllers/rightNow').suggestion);
router.get('/dashboard/places', requireAuth, require('../controllers/rightNow').listPlaces);
router.post('/dashboard/places', requireAuth, express.json({ limit: '4kb' }), require('../controllers/rightNow').addPlace);
router.patch('/dashboard/places/:uuid', requireAuth, express.json({ limit: '4kb' }), require('../controllers/rightNow').patchPlace);
router.delete('/dashboard/places/:uuid', requireAuth, require('../controllers/rightNow').deletePlace);
router.post('/dashboard/places/:uuid/check', requireAuth, require('../controllers/rightNow').checkPlace);

// Mail: on-demand Gmail triage. Scanning and proposing are POSTs that call out
// (to the model / to Gmail via the action layer) so they get their own json
// limit rather than the bare express.json() used for small bodies elsewhere.
router.get('/dashboard/email', requireAuth, require('../controllers/email').list);
router.get('/dashboard/email/:uuid', requireAuth, require('../controllers/email').detail);
router.post('/dashboard/email/scan', requireAuth, express.json({ limit: '4kb' }), require('../controllers/email').scan);
router.post('/dashboard/email/group/propose', requireAuth, express.json({ limit: '16kb' }), require('../controllers/email').proposeGroup);
router.post('/dashboard/email/delete', requireAuth, express.json({ limit: '4kb' }), require('../controllers/email').deleteEmails);
router.post('/dashboard/email/unsubscribe', requireAuth, express.json({ limit: '4kb' }), require('../controllers/email').proposeUnsubscribe);
router.post('/dashboard/email/events', requireAuth, express.json({ limit: '8kb' }), require('../controllers/email').proposeEvents);
router.post('/dashboard/email/archive', requireAuth, express.json({ limit: '8kb' }), require('../controllers/email').proposeArchive);
router.post('/dashboard/email/:uuid/propose', requireAuth, express.json({ limit: '8kb' }), require('../controllers/email').propose);
router.post('/dashboard/email/:uuid/reply/suggest', requireAuth, express.json({ limit: '1kb' }), require('../controllers/email').suggestReply);
router.post('/dashboard/email/:uuid/reply/propose', requireAuth, express.json({ limit: '16kb' }), require('../controllers/email').proposeDraft);
router.post('/dashboard/email/:uuid/dismiss', requireAuth, express.json({ limit: '1kb' }), require('../controllers/email').dismiss);

// Family health watch: who's under the weather right now. Read lives on the
// dashboard summary's `familyHealth` source; these two are the only writes.
router.post('/dashboard/health/family', requireAuth, express.json({ limit: '4kb' }), require('../controllers/familyHealth').report);
router.patch('/dashboard/health/family/:uuid/resolve', requireAuth, express.json({ limit: '1kb' }), require('../controllers/familyHealth').resolve);

// Body calibration: lab references (DEXA, InBody, a measured height) that
// correct the scale. Read on the dashboard summary's `body` source.
router.post('/dashboard/health/body/calibration', requireAuth, express.json({ limit: '2kb' }), require('../controllers/bodyCalibration').add);
router.delete('/dashboard/health/body/calibration/:uuid', requireAuth, require('../controllers/bodyCalibration').remove);

// Training program + nutrition (migration 0073): what the person means to do
// and what they ate — the two things no connected device can see.
const healthPlan = require('../controllers/healthPlan');
router.get('/dashboard/health/plan', requireAuth, healthPlan.overview);
router.put('/dashboard/health/program', requireAuth, express.json({ limit: '16kb' }), healthPlan.saveProgram);
router.delete('/dashboard/health/program', requireAuth, healthPlan.endProgram);
router.put('/dashboard/health/program/sessions/:uuid/mark', requireAuth, express.json({ limit: '1kb' }), healthPlan.markSession);
router.put('/dashboard/health/targets', requireAuth, express.json({ limit: '2kb' }), healthPlan.saveTargets);
router.post('/dashboard/health/nutrition', requireAuth, express.json({ limit: '2kb' }), healthPlan.addEntry);
router.delete('/dashboard/health/nutrition/:uuid', requireAuth, healthPlan.removeEntry);
// Food by camera and favorites (migration 0074). The scan's photo arrives as
// base64 JSON; server.js gives this path an 8 MB parser, as for memory photos.
router.post('/dashboard/health/nutrition/scan', requireAuth, express.json({ limit: '8mb' }), healthPlan.scan);
router.patch('/dashboard/health/nutrition/:uuid', requireAuth, express.json({ limit: '2kb' }), healthPlan.updateEntry);
router.post('/dashboard/health/favorites', requireAuth, express.json({ limit: '2kb' }), healthPlan.saveFavorite);
router.delete('/dashboard/health/favorites/:uuid', requireAuth, healthPlan.removeFavorite);
router.post('/dashboard/health/favorites/:uuid/log', requireAuth, express.json({ limit: '1kb' }), healthPlan.logFavorite);

// Family card: children's birthdays from the family profiles, and the Google
// Contact (if any) linked to each remembered family member. Contact search is
// the community one — same address book, same endpoint.
router.get('/dashboard/family/people', requireAuth, require('../controllers/familyPeople').overview);
router.put('/dashboard/family/people/:factUuid/contact', requireAuth, express.json({ limit: '1kb' }), require('../controllers/familyPeople').link);
router.delete('/dashboard/family/people/:factUuid/contact', requireAuth, require('../controllers/familyPeople').unlink);
router.delete('/dashboard/family/people/:factUuid', requireAuth, require('../controllers/familyPeople').remove);
router.post('/dashboard/family/people/:factUuid/merge', requireAuth, express.json({ limit: '1kb' }), require('../controllers/familyPeople').merge);

// Public: the on-device model manifest carries no secrets, and devices poll it
// before (and after) pairing.
router.get("/llm/manifest", companion.llmManifest);
// Public: redeem a pairing code — the short-lived code is the credential.
router.post("/devices/pair", express.json(), companion.redeemPairingCode);

router.get("/llm/status", requireAuthOrDevice, companion.llmStatus);
// The Brain panel's "what I almost said": the caller's own turns only.
router.get("/llm/monologue", requireAuth, companion.llmMonologue);
router.post("/llm/device-report", requireAuthOrDevice, companion.deviceReport);

// Where to reach a handset. Device-authenticated: only the device knows its
// own registration, and revoking the device revokes this with it.
router.post("/devices/push-token", requireAuthOrDevice, express.json(), companion.registerPushToken);
router.delete("/devices/push-token", requireAuthOrDevice, companion.forgetPushToken);

// Device management happens from the signed-in Companion app, never a device.
router.post("/devices/pairing-code", requireAuth, companion.createPairingCode);
router.get("/devices", requireAuth, companion.listDevices);
router.delete("/devices/:uuid", requireAuth, companion.revokeDevice);

// The Android app itself: signed-in download (a short-lived signed link, the
// APK is too big for Cloud Run to serve) and the installed app's update check.
router.get("/android/release", requireAuthOrDevice, companion.androidRelease);
router.post("/android/release/link", requireAuthOrDevice, companion.androidDownloadLink);

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
