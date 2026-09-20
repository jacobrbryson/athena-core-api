const { randomUUID, createHash } = require('node:crypto');
const pool = require('../../helpers/db');
const { withTransaction } = require('../parent-helpers');
const { encrypt, decrypt } = require('../../helpers/crypto');

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const lost = () => Object.assign(new Error('Attention work changed or its lease expired'), { code: 'lease_lost' });

async function watch(profileId, source = 'whoop_workout', conn = pool) {
  const [rows] = await conn.query('SELECT * FROM attention_watch WHERE profile_id = ? AND source = ?', [profileId, source]);
  return rows[0] || null;
}

async function configure(profileId, link, enabled) {
  return withTransaction(async conn => {
    const [existing] = await conn.query('SELECT * FROM attention_watch WHERE profile_id = ? AND source = ? FOR UPDATE', [profileId, 'whoop_workout']);
    const current = existing[0] || null;
    if (!current && !enabled) return null;
    if (current && link && current.credential_uuid !== link.uuid) {
      // Account changes cannot inherit another account's interpretations.
      await conn.query('DELETE FROM attention_record WHERE watch_id = ?', [current.id]);
      await conn.query('DELETE FROM attention_event WHERE watch_id = ?', [current.id]);
    }
    await conn.query(`INSERT INTO attention_watch
      (profile_id, source, credential_uuid, external_account_id, enabled, generation)
      VALUES (?, 'whoop_workout', ?, ?, ?, ?) ON DUPLICATE KEY UPDATE
      credential_uuid = VALUES(credential_uuid), external_account_id = VALUES(external_account_id),
      enabled = VALUES(enabled), generation = VALUES(generation), lease_token = NULL, lease_until = NULL,
      sync_state = NULL, next_sync_at = NOW(3), last_error = NULL`,
    [profileId, link?.uuid || current.credential_uuid, link?.external_account_id || current.external_account_id, enabled ? 1 : 0, randomUUID()]);
    return watch(profileId, 'whoop_workout', conn);
  });
}

async function enqueue(watchId, { key, resourceId, type }, conn = pool) {
  await conn.query(`INSERT INTO attention_event (uuid, watch_id, event_key, resource_id, event_type)
    VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id`,
  [randomUUID(), watchId, hash(key), resourceId, type]);
}

async function receive(accountId, event) {
  // No caller-supplied profile IDs: ownership comes from an active OAuth link
  // and a separate, explicit watch preference. Failures propagate to HTTP 503.
  return withTransaction(async conn => {
    const [watches] = await conn.query(`SELECT w.id FROM attention_watch w
      JOIN user_credential c ON c.uuid = w.credential_uuid AND c.profile_id = w.profile_id
      WHERE w.source = 'whoop_workout' AND w.external_account_id = ? AND w.enabled = 1
      AND c.provider = 'whoop' AND c.status = 'active' AND c.external_account_id = w.external_account_id
      FOR UPDATE`, [accountId]);
    for (const w of watches) await enqueue(w.id, event, conn);
  });
}

async function dueWatches(limit = 20) {
  const [rows] = await pool.query(`SELECT w.* FROM attention_watch w WHERE enabled = 1
    AND (lease_until IS NULL OR lease_until <= NOW(3))
    AND (next_sync_at <= NOW(3) OR EXISTS (SELECT 1 FROM attention_event e WHERE e.watch_id = w.id
      AND e.status IN ('pending', 'retry', 'processing') AND e.available_at <= NOW(3)))
    ORDER BY w.updated_at, w.id LIMIT ?`, [limit]);
  return rows;
}

async function claim(w) {
  const token = randomUUID();
  const [r] = await pool.query(`UPDATE attention_watch SET lease_token = ?, lease_until = DATE_ADD(NOW(3), INTERVAL 5 MINUTE)
    WHERE id = ? AND generation = ? AND enabled = 1 AND (lease_until IS NULL OR lease_until <= NOW(3))`,
  [token, w.id, w.generation]);
  return r.affectedRows ? { ...w, lease_token: token } : null;
}

async function fenced(conn, w) {
  const [rows] = await conn.query(`SELECT id FROM attention_watch WHERE id = ? AND generation = ?
    AND enabled = 1 AND lease_token = ? AND lease_until > NOW(3) FOR UPDATE`, [w.id, w.generation, w.lease_token]);
  if (!rows.length) throw lost();
}

async function nextEvent(w) {
  return withTransaction(async conn => {
    await fenced(conn, w);
    const [rows] = await conn.query(`SELECT * FROM attention_event WHERE watch_id = ?
      AND status IN ('pending', 'retry', 'processing') AND available_at <= NOW(3) ORDER BY id LIMIT 1 FOR UPDATE`, [w.id]);
    if (!rows.length) return null;
    const e = rows[0];
    await conn.query(`UPDATE attention_event SET status = 'processing', attempts = attempts + 1, lease_token = ? WHERE id = ?`, [w.lease_token, e.id]);
    await conn.query('UPDATE attention_watch SET lease_until = DATE_ADD(NOW(3), INTERVAL 5 MINUTE) WHERE id = ?', [w.id]);
    return { ...e, attempts: e.attempts + 1 };
  });
}

async function decode(row) {
  if (!row) return null;
  const { payload_enc, feedback_enc, ...meta } = row;
  return { ...meta, payload: JSON.parse(await decrypt(payload_enc)), feedback: feedback_enc ? JSON.parse(await decrypt(feedback_enc)) : null };
}

async function latest(watchId, resourceId, conn = pool) {
  const [rows] = await conn.query('SELECT * FROM attention_record WHERE watch_id = ? AND resource_id = ? ORDER BY id DESC LIMIT 1', [watchId, resourceId]);
  return decode(rows[0]);
}

async function records(watchId, limit = 30) {
  const [rows] = await pool.query(`SELECT r.* FROM attention_record r
    WHERE r.watch_id = ? AND NOT EXISTS (SELECT 1 FROM attention_record n
      WHERE n.watch_id = r.watch_id AND n.resource_id = r.resource_id AND n.id > r.id)
    ORDER BY r.id DESC LIMIT ?`, [watchId, limit]);
  return Promise.all(rows.map(decode));
}

async function corrections(watchId) {
  const [rows] = await pool.query(`SELECT r.* FROM attention_record r WHERE r.watch_id = ? AND r.feedback_enc IS NOT NULL
    ORDER BY r.feedback_at DESC, r.id DESC LIMIT 30`, [watchId]);
  return Promise.all(rows.map(decode));
}

async function complete(w, e, result) {
  const encrypted = result?.payload ? await encrypt(JSON.stringify(result.payload)) : null;
  return withTransaction(async conn => {
    await fenced(conn, w);
    if (encrypted) {
      await conn.query(`INSERT INTO attention_record (uuid, watch_id, resource_id, observation_hash, context_hash, payload_enc)
        VALUES (?, ?, ?, ?, ?, ?)`, [randomUUID(), w.id, e.resource_id, result.observationHash, result.contextHash, encrypted]);
    }
    await conn.query(`UPDATE attention_event SET status = 'done', disposition = ?, finished_at = NOW(3), last_error = NULL
      WHERE id = ? AND watch_id = ? AND lease_token = ?`, [result?.disposition || 'interpreted', e.id, w.id, w.lease_token]);
    await conn.query('UPDATE attention_watch SET last_error = NULL WHERE id = ?', [w.id]);
  });
}

async function retry(w, e, reason) {
  // Errors are coded by the worker, never provider responses/tokens/prompts.
  const delay = Math.min(3600, 30 * 2 ** Math.min(e.attempts, 7));
  return withTransaction(async conn => {
    await fenced(conn, w);
    await conn.query(`UPDATE attention_event SET status = 'retry', last_error = ?,
      available_at = DATE_ADD(NOW(3), INTERVAL ? SECOND), lease_token = NULL WHERE id = ? AND watch_id = ?`,
    [reason, delay, e.id, w.id]);
    await conn.query('UPDATE attention_watch SET last_error = ? WHERE id = ?', [reason, w.id]);
  });
}

async function syncPage(w, entries, nextState) {
  return withTransaction(async conn => {
    await fenced(conn, w);
    for (const event of entries) await enqueue(w.id, event, conn);
    await conn.query(`UPDATE attention_watch SET sync_state = ?, last_error = NULL,
      next_sync_at = DATE_ADD(NOW(3), INTERVAL ? SECOND), last_sync_at = IF(? = 1, NOW(3), last_sync_at)
      WHERE id = ?`, [nextState ? JSON.stringify(nextState) : null, nextState ? 0 : 3600, nextState ? 0 : 1, w.id]);
  });
}

async function release(w, error = null) {
  await pool.query(`UPDATE attention_watch SET lease_token = NULL, lease_until = NULL,
    last_error = COALESCE(?, last_error), next_sync_at = IF(? IS NULL, next_sync_at, DATE_ADD(NOW(3), INTERVAL 5 MINUTE))
    WHERE id = ? AND generation = ? AND lease_token = ?`, [error, error, w.id, w.generation, w.lease_token]);
}

async function feedback(profileId, uuid, value) {
  const encrypted = await encrypt(JSON.stringify(value));
  return withTransaction(async conn => {
    const w = await watch(profileId, 'whoop_workout', conn);
    if (!w) throw Object.assign(new Error('Review not found'), { status: 404 });
    await conn.query('SELECT id FROM attention_watch WHERE id = ? FOR UPDATE', [w.id]);
    const [rows] = await conn.query('SELECT * FROM attention_record WHERE uuid = ? AND watch_id = ? FOR UPDATE', [uuid, w.id]);
    const row = rows[0];
    if (!row) throw Object.assign(new Error('Review not found'), { status: 404 });
    const current = await latest(w.id, row.resource_id, conn);
    if (current.uuid !== uuid) throw Object.assign(new Error('This activity changed. Refresh before correcting it.'), { status: 409 });
    if (current.payload.observation.state !== 'present') throw Object.assign(new Error('This activity is no longer available.'), { status: 409 });
    await conn.query('UPDATE attention_record SET feedback_enc = ?, feedback_at = NOW(3) WHERE id = ?', [encrypted, row.id]);
    // Invalidate a model run that started before the correction, then ensure
    // it is reconsidered. No stale worker can publish over a human correction.
    await conn.query('UPDATE attention_watch SET generation = ?, lease_token = NULL, lease_until = NULL, next_sync_at = NOW(3) WHERE id = ?', [randomUUID(), w.id]);
    await enqueue(w.id, { key: ['feedback', uuid, randomUUID()], resourceId: row.resource_id, type: 'reconsider' }, conn);
  });
}

async function forget(profileId) {
  return withTransaction(async conn => {
    const [rows] = await conn.query('SELECT id FROM attention_watch WHERE profile_id = ? AND source = ? FOR UPDATE', [profileId, 'whoop_workout']);
    if (!rows.length) return;
    const id = rows[0].id;
    await conn.query('DELETE FROM attention_record WHERE watch_id = ?', [id]);
    await conn.query('DELETE FROM attention_event WHERE watch_id = ?', [id]);
    await conn.query('DELETE FROM attention_watch WHERE id = ?', [id]);
  });
}

async function queueStatus(watchId) {
  const [rows] = await pool.query('SELECT status, COUNT(*) AS count FROM attention_event WHERE watch_id = ? GROUP BY status', [watchId]);
  return Object.fromEntries(rows.map(r => [r.status, Number(r.count)]));
}

async function recheck(w) {
  return withTransaction(async conn => {
    const [owners] = await conn.query('SELECT id FROM attention_watch WHERE id = ? AND profile_id = ? AND generation = ? AND enabled = 1 FOR UPDATE', [w.id, w.profile_id, w.generation]);
    if (!owners.length) throw Object.assign(new Error('Activity reviews changed; refresh and try again.'), { status: 409 });
    const [rows] = await conn.query('SELECT resource_id FROM attention_record WHERE watch_id = ? GROUP BY resource_id ORDER BY MAX(id) DESC LIMIT 30', [w.id]);
    for (const r of rows) await enqueue(w.id, { key: ['manual', randomUUID()], resourceId: r.resource_id, type: 'reconsider' }, conn);
    await conn.query('UPDATE attention_watch SET next_sync_at = NOW(3) WHERE id = ?', [w.id]);
  });
}

module.exports = { hash, parse, watch, configure, enqueue, receive, dueWatches, claim, nextEvent,
  latest, records, corrections, complete, retry, syncPage, release, feedback, forget, queueStatus, recheck };
