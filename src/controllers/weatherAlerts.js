const { requireAdultActor } = require('../helpers/actor');
const weatherAlerts = require('../services/weatherAlerts');
const weather = require('../services/weather');

/**
 * The Weather panel on Community: the longer forecast at a watched place, and
 * the alerts the person sets for themselves. Everything is the caller's own;
 * nothing here accepts a caller-supplied profile. See
 * docs/capabilities/weather-alerts.md.
 */
function handler(run) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const actor = await requireAdultActor(req, res);
    if (!actor) return;
    try {
      return res.json(await run(actor.profileId, req));
    } catch (err) {
      if (err?.status === 400 || err?.status === 404) return res.status(err.status).json({ success: false, message: err.message });
      console.warn('[weather alerts] unavailable:', err?.message || err);
      return res.status(503).json({ success: false, message: 'Weather alerts are unavailable right now.' });
    }
  };
}

/** Seven days, two days by the hour, and a frost read per night, at home or `?place=`. */
async function outlook(profileId, req) {
  const wanted = typeof req.query.place === 'string' ? req.query.place : null;
  const place = await weatherAlerts.homePlace(profileId, wanted);
  if (!place) return { status: 'no_place', place: null, outlook: null };
  const sky = await weather.outlook(place.latitude, place.longitude);
  return { status: sky ? 'ready' : 'unavailable', place: { uuid: place.uuid, name: place.name }, outlook: sky };
}

module.exports = {
  outlook: handler(outlook),
  list: handler((profileId) => weatherAlerts.list(profileId)),
  save: handler((profileId, req) => weatherAlerts.save(profileId, { ...(req.body || {}), uuid: undefined })),
  update: handler((profileId, req) => weatherAlerts.save(profileId, { ...(req.body || {}), uuid: req.params.uuid })),
  remove: handler((profileId, req) => weatherAlerts.remove(profileId, req.params.uuid)),
};
