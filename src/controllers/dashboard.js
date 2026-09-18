const { requireAdultActor } = require('../helpers/actor');
const { getDashboard } = require('../services/dashboard');

async function summary(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json(await getDashboard(actor.profileId, req.user));
  } catch {
    return res.status(503).json({ success: false, message: 'Dashboard data is unavailable. Please retry.' });
  }
}
const news = require('../services/dashboardNews');
async function newsFeed(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    if (req.method === 'PUT') return res.json({ sources: await news.saveSources(actor.profileId, req.body?.sources) });
    if (req.path.endsWith('/sources')) return res.json({ sources: await news.getSources(actor.profileId) });
    return res.json(await news.getNews(actor.profileId));
  } catch (err) {
    return res.status(err.status === 400 ? 400 : 503).json({ success: false, message: err.status === 400 ? err.message : 'News is unavailable. Check that the dashboard migration is installed.' });
  }
}
const priorityService = require('../services/dashboardPriority');
/**
 * The order Athena thinks the cards should be read in. Never fails the page:
 * a model outage returns the default order with source 'default'.
 */
async function priority(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  return res.json(await priorityService.getPriority(actor.profileId, req.user));
}
module.exports = { summary, newsFeed, priority };
