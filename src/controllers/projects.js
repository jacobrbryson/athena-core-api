/**
 * Projects, for the Companion app. See docs/architecture/projects.md.
 *
 * Every route is behind requireAdultActor: projects are an adult's own lists.
 * Nothing here performs an action — creating, editing and ticking things off is
 * the person doing it in their own app. Every write answers with the whole
 * snapshot, so the app never has to guess what a change did to the links,
 * blocked states or ranking around it.
 */
const { requireAdultActor } = require('../helpers/actor');
const projects = require('../services/projects');
const entries = require('../services/projects/entries');
const bindings = require('../services/projects/bindings');
const { rank } = require('../services/projects/rank');
const rightNow = require('../services/rightNow');

async function snapshot(profileId) {
  const all = await projects.getAll(profileId);
  const ranks = rank(all);
  for (const p of all.projects) {
    const r = ranks.get(p.uuid);
    p.rank = r ? r.score : null;
    p.rankWhy = r ? r.why : [];
  }
  return all;
}

function fail(res, err) {
  if (err?.status === 400 || err?.status === 404) {
    return res.status(err.status).json({ success: false, message: err.message });
  }
  console.warn('[projects] unavailable:', err?.message || err);
  return res.status(503).json({ success: false, message: 'Projects are unavailable right now. Check that the projects migration is installed.' });
}

/** Wrap a write: resolve the adult, run it, answer with the fresh snapshot. */
function write(fn) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const actor = await requireAdultActor(req, res);
    if (!actor) return;
    try {
      const result = await fn(actor.profileId, req);
      rightNow.invalidate(actor.profileId).catch(() => {});
      return res.json({ success: true, result: result ?? null, ...(await snapshot(actor.profileId)) });
    } catch (err) {
      return fail(res, err);
    }
  };
}

/** A project's journal, newest first. Not in the snapshot: photos are many and only one project is open at a time. */
async function listEntries(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json({ entries: await entries.list(actor.profileId, req.params.uuid) });
  } catch (err) {
    return fail(res, err);
  }
}

/** A stored photo, streamed from the private bucket to the person who owns the project. */
async function entryImage(req, res) {
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    const { file, contentType } = await entries.openImage(actor.profileId, req.params.uuid, req.params.entryUuid);
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'private, max-age=86400');
    file.createReadStream()
      .on('error', (err) => {
        if (!res.headersSent) res.status(err?.code === 404 ? 404 : 503).end();
        else res.destroy(err);
      })
      .pipe(res);
  } catch (err) {
    if (err?.status === 404) return res.status(404).end();
    console.warn('[projects] photo', err?.message || err);
    return res.status(503).end();
  }
}

/** Live data for a project's bindings — weight against its line, workouts, upcoming events. */
async function bound(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json({ bindings: await bindings.read(actor.profileId, req.params.uuid) });
  } catch (err) {
    return fail(res, err);
  }
}

/** What a binding can point at: the sports they've recorded, the metrics there are. */
async function bindingOptions(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json(await bindings.options(actor.profileId));
  } catch (err) {
    return fail(res, err);
  }
}

async function list(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json(await snapshot(actor.profileId));
  } catch (err) {
    return fail(res, err);
  }
}

const body = (req) => req.body || {};

module.exports = {
  list,
  create: write((pid, req) => projects.create(pid, body(req))),
  update: write((pid, req) => projects.update(pid, req.params.uuid, body(req))),
  remove: write((pid, req) => projects.remove(pid, req.params.uuid)),

  addStep: write((pid, req) => projects.addStep(pid, req.params.uuid, body(req))),
  updateStep: write((pid, req) => projects.updateStep(pid, req.params.uuid, req.params.stepUuid, body(req))),
  removeStep: write((pid, req) => projects.removeStep(pid, req.params.uuid, req.params.stepUuid)),
  reorderSteps: write((pid, req) => projects.reorderSteps(pid, req.params.uuid, body(req).order)),

  addLink: write((pid, req) => projects.addLink(pid, req.params.uuid, body(req))),
  removeLink: write((pid, req) => projects.removeLink(pid, req.params.uuid, { relation: req.query.relation, to: req.query.to })),

  createConcern: write((pid, req) => projects.createConcern(pid, body(req))),
  updateConcern: write((pid, req) => projects.updateConcern(pid, req.params.uuid, body(req))),
  removeConcern: write((pid, req) => projects.removeConcern(pid, req.params.uuid)),

  putCharter: write((pid, req) => projects.putCharter(pid, req.params.area, body(req))),

  listEntries,
  bound,
  bindingOptions,
  addBinding: write((pid, req) => bindings.add(pid, req.params.uuid, body(req))),
  removeBinding: write((pid, req) => bindings.remove(pid, req.params.uuid, req.params.bindingUuid)),
  entryImage,
  addEntry: write((pid, req) => entries.add(pid, req.params.uuid, body(req))),
  updateEntry: write((pid, req) => entries.update(pid, req.params.uuid, req.params.entryUuid, body(req))),
  removeEntry: write((pid, req) => entries.remove(pid, req.params.uuid, req.params.entryUuid)),
};
