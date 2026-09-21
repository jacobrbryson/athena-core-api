const { requireAdultActor } = require('../helpers/actor');
const watch = require('../services/pulsepoint/watch');

/**
 * Nearby emergencies: the places a person wants watched, and what is active
 * near them now. Places are the person's own; nothing here accepts a
 * caller-supplied profile. See docs/capabilities/nearby-incidents.md.
 */
function fail(res, err) {
  if (err?.status === 400) return res.status(400).json({ success: false, message: err.message });
  console.warn('[nearby-incidents] unavailable:', err?.message || err);
  return res.status(503).json({ success: false, message: 'Nearby emergencies are unavailable right now.' });
}

async function listPlaces(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json({ places: await watch.listPlaces(actor.profileId) });
  } catch (err) {
    return fail(res, err);
  }
}

/** Add or update by name: {name, latitude, longitude, radiusMiles?, address?, enabled?}. */
async function savePlace(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json({ places: await watch.savePlace(actor.profileId, req.body || {}) });
  } catch (err) {
    return fail(res, err);
  }
}

async function removePlace(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json({ places: await watch.removePlace(actor.profileId, req.params.uuid) });
  } catch (err) {
    return fail(res, err);
  }
}

/** What is active near their places right now, nearest first. */
async function nearby(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    const hits = await watch.nearbyFor(actor.profileId);
    return res.json({
      incidents: hits.map(({ incident, nearest }) => ({
        id: incident.id,
        code: incident.code,
        what: incident.what,
        category: incident.category,
        address: incident.address,
        units: incident.units,
        receivedAt: incident.receivedAt,
        serious: incident.alertable,
        miles: Math.round(nearest.miles * 10) / 10,
        place: nearest.place.live ? 'you' : nearest.place.name,
      })),
    });
  } catch (err) {
    return fail(res, err);
  }
}

module.exports = { listPlaces, savePlace, removePlace, nearby };
