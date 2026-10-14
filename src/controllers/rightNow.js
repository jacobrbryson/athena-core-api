/**
 * The "right now" card, and the places list behind it. (House projects moved
 * to controllers/projects.js.)
 *
 * Every route here is behind requireAdultActor, like the rest of the
 * dashboard: places are an adult's own list, and nothing
 * in them is addressed to a child session.
 *
 * Nothing here performs an action. Adding a place is the person doing it in
 * their own app; Athena's route to it is a proposed
 * action a person approves, which lives in services/actions.
 */
const { requireAdultActor } = require('../helpers/actor');
const rightNow = require('../services/rightNow');
const places = require('../services/places');

/** A 400 carries the service's own message; anything else is redacted. */
function fail(res, err, subject) {
  if (err?.status === 400) return res.status(400).json({ success: false, message: err.message });
  console.warn(`[right-now] ${subject} unavailable:`, err?.message || err);
  return res.status(503).json({ success: false, message: `${subject} is unavailable. Check that the right-now migration is installed.` });
}

/** Resolve the adult caller, or end the response. Returns null when it ended. */
async function actorFor(req, res) {
  res.set('Cache-Control', 'no-store');
  return requireAdultActor(req, res);
}

async function suggestion(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  try {
    return res.json(await rightNow.getRightNow(actor.profileId, req.user));
  } catch (err) {
    return fail(res, err, 'Suggestions');
  }
}

// --- Places ---------------------------------------------------------------

async function listPlaces(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  try {
    return res.json({ places: await places.list(actor.profileId), maxPlaces: places.MAX_PLACES });
  } catch (err) {
    return fail(res, err, 'Places');
  }
}

/**
 * Add a place, then read it once straight away.
 *
 * The first read is deliberately synchronous-ish: someone who has just pasted
 * a park's address is looking at the card, and "I'll check it within twelve
 * hours" is not an answer. It is still allowed to fail — the place is saved
 * either way and the scheduled pass will pick it up.
 */
async function addPlace(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  try {
    const place = await places.add(actor.profileId, req.body || {});
    if (place) await places.refresh(place).catch(err => console.warn('[right-now] first read failed:', err.message));
    rightNow.invalidate(actor.profileId).catch(() => {});
    return res.json({ place: place ? await places.byUuid(actor.profileId, place.uuid) : null });
  } catch (err) {
    return fail(res, err, 'Places');
  }
}

async function patchPlace(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  try {
    const place = await places.update(actor.profileId, req.params.uuid, req.body || {});
    if (!place) return res.status(404).json({ success: false, message: 'That place is not on your list.' });
    rightNow.invalidate(actor.profileId).catch(() => {});
    return res.json({ place });
  } catch (err) {
    return fail(res, err, 'Places');
  }
}

async function deletePlace(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  try {
    const removed = await places.remove(actor.profileId, req.params.uuid);
    if (!removed) return res.status(404).json({ success: false, message: 'That place is not on your list.' });
    rightNow.invalidate(actor.profileId).catch(() => {});
    return res.json({ success: true });
  } catch (err) {
    return fail(res, err, 'Places');
  }
}

/** "Look again now", for the moment someone suspects the card is stale. */
async function checkPlace(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  try {
    const result = await places.refreshOne(actor.profileId, req.params.uuid);
    if (!result) return res.status(404).json({ success: false, message: 'That place is not on your list.' });
    rightNow.invalidate(actor.profileId).catch(() => {});
    return res.json({ result, place: await places.byUuid(actor.profileId, req.params.uuid) });
  } catch (err) {
    return fail(res, err, 'Places');
  }
}

module.exports = {
  suggestion,
  listPlaces, addPlace, patchPlace, deletePlace, checkPlace,
};
