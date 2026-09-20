/**
 * The "right now" card, and the two lists behind it.
 *
 * Every route here is behind requireAdultActor, like the rest of the
 * dashboard: places and house projects are an adult's own lists, and nothing
 * in them is addressed to a child session.
 *
 * Nothing here performs an action. Adding a place or ticking a project off is
 * the person doing it in their own app; Athena's route to either is a proposed
 * action a person approves, which lives in services/actions.
 */
const { requireAdultActor } = require('../helpers/actor');
const rightNow = require('../services/rightNow');
const places = require('../services/places');
const homeProjects = require('../services/homeProjects');
const homeProjectsImport = require('../services/homeProjectsImport');

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

// --- House projects -------------------------------------------------------

async function listProjects(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  try {
    const [projects, counts] = await Promise.all([
      homeProjects.list(actor.profileId, { includeDone: req.query.include === 'done' }),
      homeProjects.counts(actor.profileId),
    ]);
    return res.json({ projects, counts, maxProjects: homeProjects.MAX_PROJECTS });
  } catch (err) {
    return fail(res, err, 'Projects');
  }
}

async function addProject(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  try {
    const project = await homeProjects.create(actor.profileId, req.body || {});
    rightNow.invalidate(actor.profileId).catch(() => {});
    return res.json({ project });
  } catch (err) {
    return fail(res, err, 'Projects');
  }
}

async function patchProject(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  try {
    const project = await homeProjects.update(actor.profileId, req.params.uuid, req.body || {});
    if (!project) return res.status(404).json({ success: false, message: 'That project is not on your list.' });
    rightNow.invalidate(actor.profileId).catch(() => {});
    return res.json({ project });
  } catch (err) {
    return fail(res, err, 'Projects');
  }
}

async function deleteProject(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  try {
    const removed = await homeProjects.remove(actor.profileId, req.params.uuid);
    if (!removed) return res.status(404).json({ success: false, message: 'That project is not on your list.' });
    rightNow.invalidate(actor.profileId).catch(() => {});
    return res.json({ success: true });
  } catch (err) {
    return fail(res, err, 'Projects');
  }
}

/**
 * Import a pasted spreadsheet. `dryRun` returns exactly what a real import
 * would create and writes nothing, because the first thing anyone wants to
 * know about an import is what it thinks their columns mean.
 */
async function importProjects(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  try {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ success: false, message: 'Paste the rows from your sheet.' });
    }
    if (req.body?.dryRun) return res.json({ ...homeProjectsImport.preview(text), created: 0 });
    const result = await homeProjectsImport.importText(actor.profileId, text);
    rightNow.invalidate(actor.profileId).catch(() => {});
    return res.json(result);
  } catch (err) {
    return fail(res, err, 'Import');
  }
}

module.exports = {
  suggestion,
  listPlaces, addPlace, patchPlace, deletePlace, checkPlace,
  listProjects, addProject, patchProject, deleteProject, importProjects,
};
