const express = require('express');
const g = require('../controllers/guardianMissions');
const { requireAuth, requireAuthOrDevice } = require('../middleware/auth');

/**
 * Companion → Guardians: capabilities, missions and the household's controls
 * (controllers/guardianMissions.js). Parent-only, except the two routes a
 * phone calls with its device token (a notification button's reply and a
 * scouting photo) and a kid's own agreement from the Guardians app. server.js
 * gives the photo route an 8 MB parser.
 */
const router = express.Router();
const json = express.json({ limit: '8kb' });

router.get('/', requireAuth, g.overview);
router.get('/consent', requireAuth, g.consentOverview);
router.post('/consent/:uuid/agree', requireAuth, json, g.agree);
router.post('/consent/:uuid/withdraw', requireAuth, json, g.withdraw);
// A kid's own agreement. These verify the Guardians session token themselves.
router.get('/my-consent', g.myConsent);
router.post('/my-consent/agree', json, g.myAgree);
router.post('/my-consent/withdraw', json, g.myWithdraw);
router.get('/my-steps', g.mySteps);
router.post('/my-steps/:uuid/code', json, g.myCode);
router.post('/my-steps/:uuid/done', json, g.myDone);
router.post('/my-steps/:uuid/photo', g.myPhoto);
router.post('/my-go/:uuid', json, g.myGo);
router.post('/voice/print', requireAuthOrDevice, json, g.saveVoice);
router.post('/voice/who', requireAuthOrDevice, json, g.whoSpoke);
router.post('/planning/:uuid/invite', requireAuth, json, g.invite);
router.get('/invitations', requireAuth, g.invitations);
router.post('/invitations/:uuid', requireAuth, json, g.answerInvite);
router.post('/invitations/:uuid/leave', requireAuth, json, g.leaveMission);
router.put('/switches/:key', requireAuth, json, g.setSwitch);
router.put('/control', requireAuth, json, g.saveControl);
router.patch('/capabilities/:uuid', requireAuth, json, g.saveCapability);
router.patch('/recipients/:uuid', requireAuth, json, g.saveRecipient);
router.put('/guardians/:uuid/skills', requireAuth, json, g.saveSkill);
router.post('/missions/:uuid/approve', requireAuth, json, g.approve);
router.get('/planning', requireAuth, g.planningOverview);
router.post('/planning/draft', requireAuth, json, g.draft);
router.post('/planning/:uuid/revise', requireAuth, json, g.revise);
router.post('/wishes/:uuid', requireAuth, json, g.decideWish);
router.post('/planning/:uuid/start', requireAuth, json, g.startTemplated);
router.get('/handoff', requireAuth, g.handoff);
router.post('/zones', requireAuth, json, g.addZone);
router.post('/zones/:uuid/retire', requireAuth, json, g.retireZone);
router.post('/templates', requireAuth, json, g.addTemplate);
router.post('/templates/:uuid/retire', requireAuth, json, g.retireTemplate);
router.post('/missions/:uuid/go', requireAuth, json, g.go);
router.post('/missions/:uuid/finish', requireAuth, json, g.finish);
router.post('/steps/:uuid/secret', requireAuth, json, g.setCode);
router.post('/steps/:uuid/code', requireAuthOrDevice, json, g.submitCode);
router.post('/missions/:uuid/decline', requireAuth, json, g.decline);
router.post('/missions/:uuid/stop', requireAuth, json, g.stop);
router.post('/missions/:uuid/pause', requireAuth, json, g.pause);
router.post('/stop-everything', requireAuth, json, g.stopEverything);
router.get('/cameras', requireAuth, g.cameras);
router.post('/capabilities/:uuid/test', requireAuth, json, g.testCapability);
router.post('/scout', requireAuth, json, g.requestScout);
router.post('/steps/:uuid/send', requireAuth, json, g.send);
router.post('/steps/:uuid/verify', requireAuth, json, g.verify);
router.post('/steps/:uuid/reply', requireAuthOrDevice, json, g.reply);
router.post('/steps/:uuid/photos', requireAuthOrDevice, g.photo);

module.exports = router;
