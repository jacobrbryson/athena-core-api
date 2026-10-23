const express = require('express');
const { requireAuthOrDevice } = require('../middleware/auth');
const { requireAdultActor } = require('../helpers/actor');
const credentials = require('../services/credentials');
const webull = require('../services/connectors/webull');

// Family → Finance (docs/capabilities/webull.md): the signed-in adult's own
// Webull accounts, read-only. Nothing here can trade. A refresh is allowed at
// most once a minute so a held-down button can't spend Webull's 2-per-2s quota.
const router = express.Router();
router.use(requireAuthOrDevice);

const lastFresh = new Map(); // profileId -> ms

router.get('/brokerage', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    const link = await credentials.status(actor.profileId, webull.PROVIDER);
    if (!link) return res.json({ status: 'not_connected', accounts: [] });
    if (link.status !== 'active') return res.json({ status: 'needs_reauth', accounts: [] });
    const wantsFresh = req.query.fresh === '1' && Date.now() - (lastFresh.get(actor.profileId) || 0) > 60_000;
    if (wantsFresh) lastFresh.set(actor.profileId, Date.now());
    return res.json({ status: 'ready', ...(await webull.snapshot(actor.profileId, { fresh: wantsFresh })) });
  } catch (err) {
    if (err?.code === 'not_connected') return res.json({ status: 'needs_reauth', accounts: [] });
    console.error('[finance] brokerage read failed', { code: err?.code || null, status: err?.providerStatus || null, message: err?.message });
    const detail = err?.code === 'rate_limited' ? 'Webull asked us to slow down. Try again in a minute.' : 'Webull is unavailable right now. Please try again.';
    return res.status(503).json({ message: detail });
  }
});

module.exports = router;
