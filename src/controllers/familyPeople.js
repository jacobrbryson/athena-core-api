const { requireAdultActor } = require('../helpers/actor');
const familyPeople = require('../services/familyPeople');

/** Children's birthdays and the Google Contacts linked to remembered family. Adult-only; always the caller's own. */
function fail(res, err) {
  if (err?.status === 400 || err?.status === 404) return res.status(err.status).json({ success: false, message: err.message });
  console.warn('[familyPeople] unavailable:', err?.message || err);
  return res.status(503).json({ success: false, message: 'Your family list is unavailable right now.' });
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
  overview: handler((profileId) => familyPeople.overview(profileId)),
  link: handler((profileId, req) => familyPeople.linkContact(profileId, req.params.factUuid, req.body || {})),
  unlink: handler((profileId, req) => familyPeople.unlinkContact(profileId, req.params.factUuid)),
  remove: handler((profileId, req) => familyPeople.removePerson(profileId, req.params.factUuid)),
  merge: handler((profileId, req) => familyPeople.mergePeople(profileId, req.params.factUuid, req.body?.intoUuid)),
};
