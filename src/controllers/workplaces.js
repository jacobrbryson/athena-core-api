const { requireAdultActor } = require('../helpers/actor');
const workplaces = require('../services/workplaces');

/**
 * The Workplaces panel on Work: where the person works, what they do there,
 * and which connections and email addresses belong to each. Everything is the
 * caller's own; nothing here accepts a caller-supplied profile. See
 * docs/capabilities/workplaces.md.
 */
function fail(res, err) {
  if (err?.status === 400 || err?.status === 404) return res.status(err.status).json({ success: false, message: err.message });
  if (err?.code === 'ER_DUP_ENTRY') return res.status(400).json({ success: false, message: 'That is already on your list.' });
  console.warn('[workplaces] unavailable:', err?.message || err);
  return res.status(503).json({ success: false, message: 'Your workplaces are unavailable right now.' });
}

// Every write can move a primary flag or a link, so each one answers with the
// whole picture: { workplaces, available }.
function handler(run) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const actor = await requireAdultActor(req, res);
    if (!actor) return;
    try {
      const extra = await run(actor.profileId, req);
      return res.json({ ...(extra || {}), ...(await workplaces.overview(actor.profileId)) });
    } catch (err) {
      return fail(res, err);
    }
  };
}

module.exports = {
  list: handler(async () => null),
  save: handler(async (profileId, req) => ({ workplace: await workplaces.save(profileId, { ...(req.body || {}), uuid: undefined }) })),
  update: handler(async (profileId, req) => ({ workplace: await workplaces.save(profileId, { ...(req.body || {}), uuid: req.params.uuid }) })),
  remove: handler(async (profileId, req) => {
    if (!(await workplaces.remove(profileId, req.params.uuid))) throw Object.assign(new Error("That workplace isn't on your list."), { status: 404 });
  }),
  link: handler(async (profileId, req) => {
    const body = req.body || {};
    await workplaces.link(profileId, req.params.uuid, { credential: body.credential, email: body.email, site: body.site, project: body.project });
  }),
  unlink: handler(async (profileId, req) => {
    await workplaces.unlink(profileId, req.params.uuid, req.params.linkUuid);
  }),
};
