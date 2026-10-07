const { requireAdultActor } = require('../helpers/actor');
const doors = require('../services/doorToDoor');

/** Street safety checks (door to door). Adult-only; always the caller's own. */
function fail(res, err) {
  if (err?.status === 400 || err?.status === 404 || err?.status === 503) return res.status(err.status).json({ success: false, message: err.message });
  console.warn('[doorToDoor] unavailable:', err?.message || err);
  return res.status(503).json({ success: false, message: 'Your street checks are unavailable right now.' });
}

function handler(run) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const actor = await requireAdultActor(req, res);
    if (!actor) return;
    try {
      return res.json(await run(actor.profileId, req));
    } catch (err) {
      return fail(res, err);
    }
  };
}

module.exports = {
  list: handler(async (profileId) => ({ rounds: await doors.listRounds(profileId) })),
  start: handler(async (profileId, req) => ({ round: await doors.startRound(profileId, req.body || {}) })),
  get: handler(async (profileId, req) => ({ round: await doors.getRound(profileId, req.params.uuid) })),
  addDoor: handler(async (profileId, req) => ({ round: await doors.addDoor(profileId, req.params.uuid, req.body?.address) })),
  sync: handler(async (profileId, req) => ({ round: await doors.applyMarks(profileId, req.params.uuid, req.body?.updates) })),
  close: handler(async (profileId, req) => ({ round: await doors.closeRound(profileId, req.params.uuid, req.body?.closed !== false) })),
  remove: handler(async (profileId, req) => ({ rounds: await doors.removeRound(profileId, req.params.uuid) })),
};
