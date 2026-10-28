const { requireAdultActor } = require('../helpers/actor');
const inbox = require('../services/notifications/inbox');

/** GET /dashboard/inbox — what is still waiting, and the last week of what was dealt with. */
async function list(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json(await inbox.list(actor.profileId));
  } catch (err) {
    console.warn('[notifications] list failed:', err?.message || err);
    return res.status(500).json({ success: false, message: "I couldn't load your notifications just now." });
  }
}

/** POST /dashboard/inbox/:uuid/ack */
async function acknowledge(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    const cleared = await inbox.acknowledge(actor.profileId, req.params.uuid, 'app');
    return res.json({ success: true, cleared });
  } catch (err) {
    console.warn('[notifications] ack failed:', err?.message || err);
    return res.status(500).json({ success: false, message: "I couldn't acknowledge that just now." });
  }
}

/** POST /dashboard/inbox/ack-all */
async function acknowledgeAll(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json({ success: true, cleared: await inbox.acknowledgeAll(actor.profileId) });
  } catch (err) {
    console.warn('[notifications] ack-all failed:', err?.message || err);
    return res.status(500).json({ success: false, message: "I couldn't acknowledge those just now." });
  }
}

module.exports = { list, acknowledge, acknowledgeAll };
