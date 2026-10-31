const { requireAdultActor } = require('../helpers/actor');
const codeAgents = require('../services/codeAgents');
const workspaceReviews = require('../services/workspaceReviews');

/**
 * Athena's Agents on the Work page: the code investigations and fixes this
 * person approved in the last week (codeAgents.recent — their own recorded
 * actions, read-only), with each fix's state, plus their company PR reviews.
 * Nothing here starts, changes or approves anything; that stays with the
 * action layer. See docs/capabilities/workplaces.md.
 */
async function agents(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    const rows = await codeAgents.recent(actor.profileId);
    const runs = await Promise.all(rows.map(async (r) => {
      const repo = String(r.ref || '').split('#')[0] || null;
      const what = r.kind === 'fix' ? r.params?.change : r.params?.symptom;
      // A fix's state is read from its GitHub issue (cached there); a failure is "unknown", never an error.
      const state = r.kind === 'fix' ? (await codeAgents.fixStatus(r.ref).catch(() => ({ state: 'unknown' }))).state : null;
      return { uuid: r.uuid, kind: r.kind, repo, summary: typeof what === 'string' ? what.slice(0, 200) : null, state, at: r.at };
    }));
    // A failed reviews read must not cost the code agents their panel.
    const reviews = await workspaceReviews.recent(actor.profileId).catch((err) => {
      console.warn('[work] reviews unavailable:', err?.code || err?.message);
      return [];
    });
    const all = [...reviews, ...runs].sort((a, b) => (b.state === 'working') - (a.state === 'working') || new Date(b.at) - new Date(a.at));
    return res.json({ runs: all });
  } catch (err) {
    console.warn('[work] agents unavailable:', err?.message || err);
    return res.status(503).json({ success: false, message: 'Agent activity is unavailable right now.' });
  }
}

module.exports = { agents };
