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
const news = require('../services/news');
/** A 400 carries the service's own message; anything else is redacted. */
function newsError(res, err) {
  if (err?.status === 400) return res.status(400).json({ success: false, message: err.message });
  console.warn('[dashboard] news unavailable:', err?.message || err);
  return res.status(503).json({ success: false, message: 'News is unavailable. Check that the news-watch migration is installed.' });
}
/** The headlines Athena has already read. Never fetches anything itself. */
async function newsFeed(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json(await news.getNews(actor.profileId));
  } catch (err) {
    return newsError(res, err);
  }
}
/** GET the watch list, or PUT a pasted one. Intervals are not a person's to set. */
async function newsSources(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    if (req.method === 'PUT') return res.json({ sources: await news.setSources(actor.profileId, req.body?.sources) });
    return res.json({ sources: await news.getSources(actor.profileId), maxSources: news.MAX_SOURCES });
  } catch (err) {
    return newsError(res, err);
  }
}
/** Label, sharing with Athena's world memory, and pausing. Never the rhythm. */
async function patchNewsSource(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    const updated = await news.updateSource(actor.profileId, req.params.uuid, {
      ...(req.body?.label !== undefined ? { label: req.body.label } : {}),
      ...(req.body?.scope !== undefined ? { scope: req.body.scope } : {}),
      ...(req.body?.enabled !== undefined ? { enabled: !!req.body.enabled } : {}),
    });
    if (!updated) return res.status(404).json({ success: false, message: 'That source is not on your list.' });
    return res.json({ source: updated });
  } catch (err) {
    return newsError(res, err);
  }
}
async function deleteNewsSource(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    const removed = await news.removeSource(actor.profileId, req.params.uuid);
    if (!removed) return res.status(404).json({ success: false, message: 'That source is not on your list.' });
    return res.json({ success: true });
  } catch (err) {
    return newsError(res, err);
  }
}
/**
 * "Look now" — for the moment just after someone pastes a page. Rate limited
 * per person in the service, because this is the one news path where a click
 * reaches somebody else's server.
 */
async function checkNews(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    const result = await news.checkNow(actor.profileId);
    return res.json({ checked: result.checked, changed: result.changed, failed: result.failed, cooling: result.cooling });
  } catch (err) {
    return newsError(res, err);
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
module.exports = { summary, newsFeed, newsSources, patchNewsSource, deleteNewsSource, checkNews, priority };
