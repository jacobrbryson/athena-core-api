const { requireAdultActor } = require('../helpers/actor');
const community = require('../services/community');

/**
 * The Community page: points of interest (the watched places, saved through
 * the nearby-incidents routes), neighbours and local events. Everything is
 * the caller's own; nothing here accepts a caller-supplied profile. See
 * docs/capabilities/community.md.
 */
function fail(res, err) {
  if (err?.status === 400 || err?.status === 404) return res.status(err.status).json({ success: false, message: err.message });
  // Google refusing a contacts read (an API switched off, a quota) says what
  // to fix in its own words; the owner is the one reading it.
  if (err?.code === 'provider_error' || err?.code === 'not_connected') return res.status(502).json({ success: false, message: err.message });
  console.warn('[community] unavailable:', err?.message || err);
  return res.status(503).json({ success: false, message: 'Your community list is unavailable right now.' });
}

/** Wraps a handler: no-store, adult actor resolved, errors answered. */
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
  overview: handler((profileId) => community.overview(profileId)),
  // The person's own Google Contacts, searched for the "link a contact" box.
  searchContacts: handler((profileId, req) => community.searchContacts(profileId, req.query.q)),
  // Contacts whose Google address is this street line: suggestions, never links.
  contactsAtAddress: handler((profileId, req) => community.contactsAtAddress(profileId, req.query.address)),
  saveNeighbor: handler(async (profileId, req) => ({ neighbors: await community.saveNeighbor(profileId, req.body || {}) })),
  updateNeighbor: handler(async (profileId, req) => ({ neighbors: await community.saveNeighbor(profileId, { ...(req.body || {}), uuid: req.params.uuid }) })),
  removeNeighbor: handler(async (profileId, req) => ({ neighbors: await community.removeNeighbor(profileId, req.params.uuid) })),
  saveEvent: handler(async (profileId, req) => ({ events: await community.saveEvent(profileId, req.body || {}) })),
  updateEvent: handler(async (profileId, req) => ({ events: await community.saveEvent(profileId, { ...(req.body || {}), uuid: req.params.uuid }) })),
  removeEvent: handler(async (profileId, req) => ({ events: await community.removeEvent(profileId, req.params.uuid) })),
};
