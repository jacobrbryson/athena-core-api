const express = require('express');
const { requireAuthOrDevice } = require('../middleware/auth');
const { requireAdultActor } = require('../helpers/actor');
const attention = require('../services/attention');
const worker = require('../services/attention/worker');

const router = express.Router();
router.use(requireAuthOrDevice);
// No scheduled worker: what a person just asked for is reviewed in their
// request (bounded — leftovers wait in the inbox for the next webhook).
const kick = profileId => worker.runFor({ profileId }).catch(error =>
  console.error('[attention] kick failed', { code: error?.code || null, message: error?.message }));
const handle = fn => async (req, res) => {
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try { await fn(req, res, actor.profileId); }
  catch (error) { res.status(error.status || 503).json({ message: error.status ? error.message : 'Activity reviews are temporarily unavailable', code: error.code }); }
};
router.get('/whoop', handle(async (_req, res, id) => res.json(await attention.status(id))));
router.put('/whoop', handle(async (req, res, id) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ message: 'enabled must be a boolean' });
  await attention.setEnabled(id, req.body.enabled);
  if (req.body.enabled) await kick(id);
  res.json(await attention.status(id));
}));
router.post('/whoop/recheck', handle(async (_req, res, id) => { await attention.recheck(id); await kick(id); res.status(202).json({ queued: true }); }));
router.post('/whoop/reviews/:uuid/feedback', handle(async (req, res, id) => {
  await attention.feedback(id, req.params.uuid, req.body);
  await kick(id);
  res.json({ saved: true });
}));
router.delete('/whoop', handle(async (_req, res, id) => { await attention.forget(id); res.json({ forgotten: true }); }));
module.exports = router;
