const { timingSafeEqual } = require('node:crypto');
const pool = require('../helpers/db');
const access = require('../security/access');
const sightings = require('../services/sightings');
const packageWatch = require('../services/packageWatch');
const initiative = require('../services/initiative');

const MAX_PASSES = 4;

/**
 * Events from the household Eufy bridge (eufy-bridge/server.mjs), each with
 * at most one frame, for the sightings log (services/sightings.js).
 *
 * The caller is the bridge, not a person: its proof is the shared bridge
 * token. Behind the proxy, Authorization carries the proxy's own IAM token
 * and the bridge's arrives in X-Eufy-Bridge-Authorization (proxy_service
 * eufyEvents.js always overwrites it); direct to core — local dev — it is
 * the plain header. Nothing in the body chooses a person: alerts go only to
 * the owners of rules the sightings match.
 *
 * The bridge never retries, so a failure is logged here and answered, not
 * queued.
 */
function authorized(req) {
  const token = process.env.EUFY_BRIDGE_TOKEN || '';
  const header = req.get('X-Eufy-Bridge-Authorization') || req.get('Authorization') || '';
  const supplied = Buffer.from(header.replace(/^Bearer /, ''));
  const expected = Buffer.from(token);
  return expected.length >= 32 && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Run as a household adult so the model call passes the same access check a person's would. */
async function asOwner(fn) {
  const owner = (process.env.EUFY_AUTHORIZED_PROFILE_IDS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
  const [rows] = owner ? await pool.query('SELECT google_id FROM profile WHERE id = ?', [owner]) : [[]];
  const identity = rows[0]?.google_id ? { google_id: rows[0].google_id } : null;
  return access.context.run({ identity }, fn);
}

async function evaluateFor(profileId) {
  const [rows] = await pool.query('SELECT google_id FROM profile WHERE id = ?', [profileId]);
  const identity = rows[0]?.google_id ? { google_id: rows[0].google_id } : null;
  return access.context.run({ identity }, () => initiative.evaluateProfile(profileId));
}

/**
 * A re-check the bridge sends for a package watch (services/packageWatch.js):
 * one fresh frame from the camera the package was seen on. The answer says
 * whether to send another, and when — the bridge keeps that timer.
 */
async function recheck(req, res, { recheckWith = packageWatch.recheck } = {}) {
  try {
    const next = await asOwner(() => recheckWith({ event: req.body?.event, frame: req.body?.frame || null }));
    return res.status(200).json({ recheck: next });
  } catch (error) {
    console.error('[eufy events] package recheck failed', { code: error?.code || null, message: error?.message });
    return res.status(503).json({ message: 'Recheck could not be recorded' });
  }
}

async function receive(req, res, { record = sightings.record, recheckWith, watch = packageWatch.onSightings } = {}) {
  res.set('Cache-Control', 'no-store');
  if (!authorized(req)) return res.status(401).json({ message: 'Unauthorized' });
  if (req.body?.event?.kind === 'recheck') return recheck(req, res, recheckWith ? { recheckWith } : {});
  let written;
  try {
    written = await asOwner(() => record({ event: req.body?.event, frame: req.body?.frame || null }));
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ message: error.message });
    console.error('[eufy events] sighting failed', { code: error?.code || null, message: error?.message });
    return res.status(503).json({ message: 'Sighting could not be recorded' });
  }
  // Recorded; alerts are best-effort from here. The scheduled initiative pass
  // is the backstop for anyone this misses.
  try {
    for (const profileId of await sightings.profilesToAlert(written)) {
      // A pass says one event; keep going while there is another to say.
      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        const outcome = await evaluateFor(profileId).catch(error =>
          console.warn('[eufy events] initiative pass failed', { profileId, code: error?.code || null, message: error?.message }));
        if (!outcome?.nudges?.length) break;
      }
    }
  } catch (error) {
    console.warn('[eufy events] rule check failed', { message: error?.message });
  }
  // A package opens a porch watch; the bridge is asked to look again later.
  let asks = [];
  try {
    asks = await watch(written);
  } catch (error) {
    console.warn('[eufy events] package watch failed', { message: error?.message });
  }
  return res.status(200).json({ sightings: written.length, ...(asks.length ? { recheck: asks } : {}) });
}

module.exports = { receive: (req, res) => receive(req, res), receiveWith: receive, authorized };
