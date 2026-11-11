/**
 * Reading incoming texts — see services/textMessages.
 *
 *   POST /dashboard/texts/incoming                  the phone forwarding one text (device token only)
 *   POST /dashboard/texts/suggestions/:uuid/approve the Add/Update button
 *   POST /dashboard/texts/suggestions/:uuid/decline No thanks
 *   POST /dashboard/texts/suggestions/:uuid/used    the reply was put in Messages or copied
 *   GET  /dashboard/texts/recent                    outcomes only, for the settings panel
 *
 * Every handler acts on the caller's own profile, resolved from the verified
 * token, and only for an adult account. Nothing here reads a profile id from
 * the body; a suggestion uuid is only ever checked against the caller's rows.
 */
const { requireAdultActor } = require('../helpers/actor');
const texts = require('../services/textMessages');

function fail(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  if (status >= 500 && status !== 503) console.error('[texts]', err?.message);
  return res.status(status).json({ success: false, code: err?.code || null, message: status >= 500 && status !== 503 ? "Couldn't do that" : err.message });
}

async function incoming(req, res) {
  res.set('Cache-Control', 'no-store');
  // A handset speaks for itself: only the paired phone that read the text may
  // send it, never a browser session.
  if (req.user?.kind !== 'device') return res.status(403).json({ success: false, message: 'Device token required' });
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  const b = req.body || {};
  try {
    return res.json(await texts.ingest(actor.profileId, {
      package: typeof b.package === 'string' ? b.package : null,
      thread: typeof b.thread === 'string' ? b.thread : null,
      sender: typeof b.sender === 'string' ? b.sender : null,
      group: b.group === true,
      text: typeof b.text === 'string' ? b.text : null,
      postedAt: typeof b.postedAt === 'string' ? b.postedAt : null,
    }));
  } catch (err) {
    return fail(res, err);
  }
}

const decider = (decision) => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json(await texts.decide(actor.profileId, String(req.params.uuid || '').slice(0, 36), decision));
  } catch (err) {
    return fail(res, err);
  }
};

async function used(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json(await texts.noteUsed(actor.profileId, String(req.params.uuid || '').slice(0, 36)));
  } catch (err) {
    return fail(res, err);
  }
}

async function recent(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json({ texts: await texts.recent(actor.profileId), longTextChars: texts.LONG_TEXT_CHARS });
  } catch (err) {
    return fail(res, err);
  }
}

module.exports = { incoming, approve: decider('approve'), decline: decider('decline'), used, recent };
