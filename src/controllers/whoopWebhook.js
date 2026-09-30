const crypto = require('node:crypto');
const secrets = require('../services/secrets');
const store = require('../services/attention/store');
const whoop = require('../services/connectors/whoop');

// Recovery and sleep only refresh the cache; workouts also feed activity reviews.
const KNOWN = new Set(['workout.updated', 'workout.deleted', 'recovery.updated', 'recovery.deleted', 'sleep.updated', 'sleep.deleted']);
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

function validSignature(secret, raw, timestamp, signature, now = Date.now()) {
  if (typeof secret !== 'string' || !secret || !Buffer.isBuffer(raw) || typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp)) > 5 * 60_000 || typeof signature !== 'string') return false;
  const expected = crypto.createHmac('sha256', secret).update(timestamp).update(raw).digest('base64');
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function receive(req, res) {
  res.set('Cache-Control', 'no-store');
  try {
    const secret = await secrets.getSecret('WHOOP_CLIENT_SECRET');
    if (!secret) return res.status(503).json({ message: 'Webhook unavailable' });
    if (!validSignature(secret, req.body, req.get('X-WHOOP-Signature-Timestamp'), req.get('X-WHOOP-Signature'))) {
      return res.status(401).json({ message: 'Invalid webhook signature' });
    }
    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); }
    catch { return res.status(400).json({ message: 'Invalid webhook payload' }); }
    if (!payload || !Number.isSafeInteger(payload.user_id) || payload.user_id <= 0 || !UUID.test(payload.id) ||
        typeof payload.trace_id !== 'string' || !/^[A-Za-z0-9._:-]{1,190}$/.test(payload.trace_id) || typeof payload.type !== 'string') {
      return res.status(400).json({ message: 'Expected a WHOOP v2 event' });
    }
    if (!KNOWN.has(payload.type)) return res.status(204).end();
    // Every known event means cached WHOOP reads are stale: this is what lets
    // them be kept for hours. It precedes the acknowledgment, so a failed
    // lookup is retried by WHOOP instead of leaving yesterday's score up.
    await whoop.invalidateAccount(payload.user_id);
    if (payload.type.startsWith('workout.')) {
      // Include resource/type in the key: even a reused trace cannot collapse
      // two different activities into a single occurrence.
      await store.receive(String(payload.user_id), {
        key: ['webhook', payload.trace_id, payload.type, payload.id.toLowerCase()], resourceId: payload.id.toLowerCase(), type: payload.type,
      });
    }
    return res.status(204).end(); // only after the inbox transaction committed
  } catch {
    return res.status(503).json({ message: 'Webhook could not be persisted; retry delivery' });
  }
}

module.exports = { receive, validSignature };
