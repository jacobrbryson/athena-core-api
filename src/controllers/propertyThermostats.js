const { requireAdultActor } = require('../helpers/actor');
const credentials = require('../services/credentials');
const nest = require('../services/connectors/nest');

// Thermostats on the Property page (docs/capabilities/nest.md): read-only,
// adult-only, profile-scoped. The rows are kept fresh by Google's Pub/Sub push,
// so a page load re-reads Google only when they are five minutes old — opening
// the page twice must not cost two API calls. Stored rows are never shown
// without an active link, the same rule the chat path keeps.
const FRESH_MS = 5 * 60_000;

async function list(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    const link = await credentials.status(actor.profileId, nest.PROVIDER);
    if (!link) return res.json({ status: 'not_connected', devices: [] });
    if (link.status !== 'active') return res.json({ status: 'needs_reauth', devices: [] });
    let stale = false;
    try {
      await nest.refreshIfStale(actor.profileId, { maxAgeMs: FRESH_MS });
    } catch (err) {
      if (err?.code === 'not_connected') return res.json({ status: 'needs_reauth', devices: [] });
      // Google unreachable: show what was last recorded, and say so.
      stale = true;
    }
    return res.json({ status: 'ready', stale, devices: await nest.storedDevices(actor.profileId) });
  } catch (err) {
    console.error('[thermostats] list failed', { code: err?.code || null, message: err?.message });
    return res.status(503).json({ message: 'Thermostats are unavailable right now. Please try again.' });
  }
}

module.exports = { list, FRESH_MS };
