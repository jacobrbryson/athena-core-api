const { requireAdultActor } = require('../helpers/actor');
const watch = require('../services/pulsepoint/watch');
const geocode = require('../services/pulsepoint/geocode');

/**
 * Look again right away when the places change, so a newly added home with
 * something already happening near it is told now rather than at the next
 * scheduled pass. Fire-and-forget: saving a place never waits on PulsePoint.
 */
function recheck(profileId) {
  watch.checkProfile(profileId).catch((err) => console.warn('[nearby-incidents] recheck failed:', err.message));
}

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
    const places = await watch.savePlace(actor.profileId, req.body || {});
    recheck(actor.profileId);
    return res.json({ places });
  } catch (err) {
    return fail(res, err);
  }
}

async function removePlace(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    const places = await watch.removePlace(actor.profileId, req.params.uuid);
    recheck(actor.profileId);
    return res.json({ places });
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

/**
 * The in-app banner: the stored situation (model-assessed, rules-floored) and
 * whether the feed behind it is alive. Cheap — two indexed reads, no fetch and
 * no model — because the companion polls it every minute.
 */
async function alert(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json(await watch.alertFor(actor.profileId));
  } catch (err) {
    return fail(res, err);
  }
}

/** A person pausing in the address box is a few lookups, not a flood. */
const LOOKUPS_PER_MINUTE = 20;
const lookups = new Map(); // profileId -> recent timestamps

/** Address -> candidate points, for the places panel. */
async function lookupAddress(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  const now = Date.now();
  const recent = (lookups.get(actor.profileId) || []).filter((t) => now - t < 60_000);
  if (recent.length >= LOOKUPS_PER_MINUTE) {
    return res.status(429).json({ success: false, message: 'Give it a moment and try that address again.' });
  }
  lookups.set(actor.profileId, [...recent, now]);
  try {
    return res.json({ matches: await geocode.lookup(req.query.q) });
  } catch (err) {
    if (err?.status === 400) return res.status(400).json({ success: false, message: err.message });
    console.warn('[nearby-incidents] address lookup failed:', err?.message || err);
    return res.status(503).json({ success: false, message: "I couldn't look that address up just now. Try again, or use your current location." });
  }
}

module.exports = { listPlaces, savePlace, removePlace, nearby, alert, lookupAddress };
