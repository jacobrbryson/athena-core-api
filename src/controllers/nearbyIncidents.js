const { requireAdultActor } = require('../helpers/actor');
const watch = require('../services/pulsepoint/watch');
const geocode = require('../services/pulsepoint/geocode');

/**
 * Look again right away when the places change, so a newly added home with
 * something already happening near it is told now rather than at the next
 * scheduled pass. Fire-and-forget: saving a place never waits on it.
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

/**
 * What is active near their places right now, nearest first: the stored
 * situation's calls, which now come only from the phone's PulsePoint
 * notifications. The web board is no longer read.
 */
async function nearby(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    const situation = await watch.getSituation(actor.profileId);
    return res.json({ incidents: [...(situation.incidents || [])].sort((x, y) => x.miles - y.miles) });
  } catch (err) {
    return fail(res, err);
  }
}

/**
 * The in-app banner: the stored situation (model-assessed, rules-floored) and
 * what this person last acknowledged. Cheap — indexed reads, no fetch and no
 * model — because the companion polls it every minute.
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

/** "Got it" on the banner: {key}. Held until a new development changes the key. */
async function acknowledgeAlert(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json(await watch.acknowledge(actor.profileId, req.body?.key));
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

/**
 * A notification the PulsePoint app put on the owner's phone, forwarded by the
 * Athena app. Device-authenticated only: a phone speaks for itself here, the
 * same rule as location samples.
 *
 * Always 200 with what happened, including why something was ignored — the
 * phone forwards everything it is allowed to see, most of which is not for us,
 * and a 4xx storm in its logs would help nobody.
 */
async function phoneAlert(req, res) {
  res.set('Cache-Control', 'no-store');
  if (req.user?.kind !== 'device') {
    return res.status(403).json({ success: false, message: 'Device token required' });
  }
  const body = req.body || {};
  if (body.package && body.package !== watch.PULSEPOINT_PACKAGE) {
    return res.json({ ignored: 'not a PulsePoint notification' });
  }
  try {
    return res.json(await watch.recordPhoneAlert(req.user.profileId, {
      title: body.title,
      text: body.text,
      postedAt: body.postedAt,
    }));
  } catch (err) {
    return fail(res, err);
  }
}

module.exports = { listPlaces, savePlace, removePlace, nearby, alert, acknowledgeAlert, lookupAddress, phoneAlert };
