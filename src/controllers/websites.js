const { requireAdultActor } = require('../helpers/actor');
const websites = require('../services/websites');

/**
 * The Websites panel on Projects: the sites a person manages and how each is
 * doing, read from Search Console and Analytics. Everything is the caller's
 * own; nothing here accepts a caller-supplied profile or Google host. See
 * docs/capabilities/websites.md.
 */
function fail(res, err) {
  if (err?.status === 400 || err?.status === 404) return res.status(err.status).json({ success: false, message: err.message });
  if (err?.code === 'not_connected') return res.status(409).json({ success: false, message: 'Google Websites access is not connected.', code: 'not_connected' });
  if (err?.code === 'provider_error') return res.status(502).json({ success: false, message: err.message });
  console.warn('[websites] unavailable:', err?.message || err);
  return res.status(503).json({ success: false, message: 'Your websites are unavailable right now.' });
}

// "Check now" calls Google several times per site, so one person cannot press it
// in a loop. The nightly job refreshes everything regardless.
const REFRESH_GAP_MS = 60_000;
const lastRefresh = new Map();

function handler(run) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const actor = await requireAdultActor(req, res);
    if (!actor) return;
    try {
      return res.json(await run(actor.profileId, req, res));
    } catch (err) {
      return fail(res, err);
    }
  };
}

module.exports = {
  list: handler(async (profileId) => ({ sites: await websites.list(profileId) })),
  discover: handler((profileId) => websites.discover(profileId)),
  save: handler(async (profileId, req) => ({ site: await websites.save(profileId, req.body || {}) })),
  update: handler(async (profileId, req) => ({ site: await websites.save(profileId, { ...(req.body || {}), uuid: req.params.uuid }) })),
  remove: handler(async (profileId, req) => {
    if (!(await websites.remove(profileId, req.params.uuid))) throw Object.assign(new Error("That site isn't on your list."), { status: 404 });
    return { sites: await websites.list(profileId) };
  }),
  refresh: handler(async (profileId, req, res) => {
    const key = `${profileId}:${req.params.uuid || 'all'}`;
    const wait = REFRESH_GAP_MS - (Date.now() - (lastRefresh.get(key) || 0));
    if (wait > 0) {
      res.status(429);
      return { success: false, message: `Checked a moment ago — try again in ${Math.ceil(wait / 1000)} seconds.`, sites: await websites.list(profileId) };
    }
    lastRefresh.set(key, Date.now());
    return { sites: await websites.refresh(profileId, req.params.uuid || null) };
  }),
};
