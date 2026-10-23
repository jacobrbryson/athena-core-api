const { requireAdultActor } = require('../helpers/actor');
const credentials = require('../services/credentials');
const smartcar = require('../services/connectors/smartcar');

// Cars read through Smartcar, on Property → Vehicles (docs/capabilities/
// smartcar.md). Adult-only, profile-scoped, read-only toward the car. A page
// load re-reads the cars only when the stored readings are an hour old, so
// opening the tab twice doesn't wake a car twice. Stored readings are never
// shown without an active link.
const FRESH_MS = 60 * 60_000;

function handler(fn) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const actor = await requireAdultActor(req, res);
    if (!actor) return;
    try {
      const link = await credentials.status(actor.profileId, smartcar.PROVIDER);
      if (!link) return res.json({ status: 'not_connected', cars: [] });
      if (link.status !== 'active') return res.json({ status: 'needs_reauth', cars: [] });
      return res.json(await fn(actor.profileId, req));
    } catch (err) {
      if (err?.status === 400 || err?.status === 404) return res.status(err.status).json({ message: err.message });
      if (err?.code === 'not_connected') return res.json({ status: 'needs_reauth', cars: [] });
      console.error('[smartcar] request failed', { code: err?.code || null, message: err?.message });
      return res.status(503).json({ message: 'Cars are unavailable right now. Please try again.' });
    }
  };
}

const list = handler(async profileId => {
  let stale = false;
  try {
    await smartcar.refreshIfStale(profileId, { maxAgeMs: FRESH_MS });
  } catch (err) {
    if (err?.code === 'not_connected') throw err;
    stale = true;
  }
  return { status: 'ready', stale, cars: await smartcar.stored(profileId) };
});

const update = handler(async (profileId, req) => {
  const body = req.body || {};
  const cars = await smartcar.setLink(profileId, String(req.params.id || ''), {
    vehicleUuid: body.vehicleUuid === undefined ? undefined : body.vehicleUuid,
    locationEnabled: body.locationEnabled,
  });
  return { status: 'ready', cars };
});

module.exports = { list, update, FRESH_MS };
