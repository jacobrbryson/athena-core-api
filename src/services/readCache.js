// Opt-in cache for derived/read data. Callers MUST authorize before every read.
// A database generation fences other instances and late in-flight fills after
// invalidation. Cache failures are misses; origin failures are never cached.
const { createHash, randomUUID } = require('node:crypto');
const pool = require('../helpers/db');
const { encrypt, decrypt } = require('../helpers/crypto');

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 128;
const memory = new Map();
const flights = new Map();
const metrics = { memoryHit: 0, databaseHit: 0, miss: 0, shared: 0, unavailable: 0, oversized: 0 };
let cleanupAt = 0;

function remember(key, text, expires, scope) {
  if (Buffer.byteLength(text) > MAX_BYTES || expires <= Date.now()) return;
  for (const [id, item] of memory) if (item.expires <= Date.now()) memory.delete(id);
  memory.delete(key);
  while (memory.size >= MAX_ENTRIES) memory.delete(memory.keys().next().value);
  memory.set(key, { text, expires, scope });
}

async function generation(profileId, namespace) {
  const [rows] = await pool.query(
    'SELECT generation FROM read_cache_scope WHERE profile_id = ? AND namespace = ?',
    [profileId, namespace],
  );
  return rows[0]?.generation || '0';
}

async function invalidate(profileId, namespace) {
  // Clear local entries immediately, including when the cache DB is unavailable.
  const scope = hash([profileId, namespace]);
  for (const [id, item] of memory) if (item.scope === scope) memory.delete(id);
  if (process.env.READ_CACHE_DISABLED === 'true') return;
  try {
    await pool.query(`INSERT INTO read_cache_scope (profile_id, namespace, generation)
      VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE generation = VALUES(generation)`,
    [profileId, namespace, randomUUID()]);
    await pool.query('DELETE FROM read_cache WHERE profile_id = ? AND namespace = ?', [profileId, namespace]);
  } catch { metrics.unavailable++; }
}

async function read({ profileId, namespace, key, ttlMs }, load) {
  if (process.env.READ_CACHE_DISABLED === 'true' || !profileId || !Number.isFinite(ttlMs) || ttlMs <= 0) return load();
  let revision;
  try { revision = await generation(profileId, namespace); }
  catch { metrics.unavailable++; return load(); }
  const id = hash([profileId, namespace, revision, key]);
  const scope = hash([profileId, namespace]);
  const hit = memory.get(id);
  if (hit?.expires > Date.now()) {
    metrics.memoryHit++;
    memory.delete(id); memory.set(id, hit);
    return JSON.parse(hit.text);
  }
  memory.delete(id);
  if (flights.has(id)) { metrics.shared++; return JSON.parse(await flights.get(id)); }
  const work = (async () => {
    try {
      const [rows] = await pool.query(
        'SELECT payload, expires_ms FROM read_cache WHERE cache_key = ? AND expires_ms > ?', [id, Date.now()],
      );
      if (rows[0]) {
        const text = await decrypt(rows[0].payload);
        JSON.parse(text); // Corruption is a miss, never a failed page.
        const expires = Number(rows[0].expires_ms);
        if (expires > Date.now()) {
          remember(id, text, Math.min(expires, Date.now() + 5000), scope);
          metrics.databaseHit++;
          return text;
        }
      }
    } catch { metrics.unavailable++; }
    metrics.miss++;
    const value = await load();
    const text = JSON.stringify(value);
    if (typeof text !== 'string') throw new Error('Read cache requires JSON data');
    if (Buffer.byteLength(text) > MAX_BYTES) { metrics.oversized++; return text; }
    const expires = Date.now() + Math.min(ttlMs, 600000);
    try {
      const payload = await encrypt(text);
      await pool.query(`INSERT INTO read_cache (cache_key, profile_id, namespace, payload, expires_ms)
        VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload), expires_ms = VALUES(expires_ms)`,
      [id, profileId, namespace, payload, expires]);
      remember(id, text, Math.min(expires, Date.now() + 5000), scope);
      // Bounded, indexed cleanup; no extra timer keeps a process alive.
      if (Date.now() >= cleanupAt) {
        cleanupAt = Date.now() + 60000;
        await pool.query('DELETE FROM read_cache WHERE expires_ms <= ? LIMIT 1000', [Date.now()]);
      }
    } catch { metrics.unavailable++; }
    return text;
  })();
  // Bound coordination too; an overload may duplicate reads, not grow forever.
  if (flights.size < MAX_ENTRIES) flights.set(id, work);
  try { return JSON.parse(await work); }
  finally { if (flights.get(id) === work) flights.delete(id); }
}

module.exports = { read, invalidate, hash, stats: () => ({ ...metrics, entries: memory.size, inFlight: flights.size }) };
