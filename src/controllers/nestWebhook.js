const { OAuth2Client } = require('google-auth-library');
const pool = require('../helpers/db');
const access = require('../security/access');
const nest = require('../services/connectors/nest');
const initiative = require('../services/initiative');

/**
 * Pub/Sub push for Google Nest (Device Access) events.
 *
 * Google publishes every device change to a topic it owns; our subscription
 * pushes each message here with an OIDC token signed by Google for the
 * subscription's service account. That token is the only thing trusted: the
 * audience and the account must both match what the owner configured, and
 * nothing in the message chooses a profile — recordEvent() ties a device to
 * a person only through rows written from that person's own link.
 *
 * Pub/Sub retries anything but a 2xx, so the codes mean something:
 *   401/503  auth or config is wrong — retry, it will work once fixed
 *   503      the state could not be stored — retry
 *   204      stored, or unusable in a way a retry would not fix
 */

const client = new OAuth2Client();

async function verifiedPush(req, { audience, serviceAccount, verifier = client } = {}) {
  // Behind the proxy, Authorization carries the proxy's own IAM token and the
  // push token arrives in X-Pubsub-Authorization (proxy_service nestWebhook.js,
  // which always overwrites it). Direct to core — local dev — it is the plain
  // header. Either way it must verify as Google's token for our account.
  const header = req.get('X-Pubsub-Authorization') || req.get('Authorization') || '';
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
  if (!match || !audience || !serviceAccount) return false;
  try {
    const ticket = await verifier.verifyIdToken({ idToken: match[1], audience });
    const claims = ticket.getPayload() || {};
    return claims.email_verified === true && String(claims.email || '').toLowerCase() === serviceAccount.toLowerCase();
  } catch {
    return false;
  }
}

function decode(body) {
  const data = body?.message?.data;
  if (typeof data !== 'string' || data.length > 64_000) return null;
  try { return JSON.parse(Buffer.from(data, 'base64').toString('utf8')); }
  catch { return null; }
}

/** One person's pass, as that person — the same context a worker run uses. */
async function evaluateFor(profileId) {
  const [rows] = await pool.query('SELECT google_id FROM profile WHERE id = ?', [profileId]);
  const identity = rows[0]?.google_id ? { google_id: rows[0].google_id } : null;
  return access.context.run({ identity }, () => initiative.evaluateProfile(profileId));
}

async function receive(req, res, { verifier } = {}) {
  res.set('Cache-Control', 'no-store');
  const audience = process.env.NEST_PUBSUB_AUDIENCE;
  const serviceAccount = process.env.NEST_PUBSUB_SERVICE_ACCOUNT;
  if (!audience || !serviceAccount || !process.env.NEST_DEVICE_ACCESS_PROJECT_ID) {
    return res.status(503).json({ message: 'Nest events are not configured' });
  }
  if (!(await verifiedPush(req, { audience, serviceAccount, verifier }))) {
    return res.status(401).json({ message: 'Invalid push token' });
  }

  const event = decode(req.body);
  if (!event) {
    console.warn('[nest webhook] undecodable message acknowledged', { id: req.body?.message?.messageId || null });
    return res.status(204).end();
  }

  let outcome;
  try {
    outcome = await nest.recordEvent(event);
  } catch (error) {
    console.error('[nest webhook] failed', { code: error?.code || null, message: error?.message });
    return res.status(503).json({ message: 'Event could not be stored; retry delivery' });
  }

  // The event is stored; everything after this is best-effort and must not
  // ask Pub/Sub to resend it. A missed re-read is covered by the hourly sync,
  // and a missed evaluation by the next scheduled initiative pass.
  const evaluate = new Set(outcome.wentOffline);
  for (const profileId of outcome.resync) {
    try {
      await nest.sync(profileId);
      if ((await nest.offlineDevices(profileId)).length) evaluate.add(profileId);
    } catch (error) {
      console.warn('[nest webhook] re-read failed', { profileId, message: error?.message });
    }
  }
  for (const profileId of evaluate) {
    await evaluateFor(profileId).catch((error) =>
      console.warn('[nest webhook] initiative pass failed', { profileId, code: error?.code || null, message: error?.message }));
  }
  return res.status(204).end();
}

module.exports = { receive: (req, res) => receive(req, res), receiveWith: receive, verifiedPush, decode };
