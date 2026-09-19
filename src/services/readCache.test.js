jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('../helpers/crypto', () => ({
  encrypt: jest.fn(async value => `encrypted:${value}`),
  decrypt: jest.fn(async value => {
    if (!value.startsWith('encrypted:')) throw new Error('corrupt');
    return value.slice(10);
  }),
}));
const pool = require('../helpers/db');
const crypto = require('../helpers/crypto');
let cache, rows, scopes;
const options = { profileId: 42, namespace: 'test', key: 'read', ttlMs: 30000 };
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-09-19T12:00:00Z'));
  rows = new Map(); scopes = new Map();
  pool.query.mockReset().mockImplementation(async (sql, args = []) => {
    if (sql.startsWith('SELECT generation')) return [[...(scopes.has(args.join(':')) ? [{ generation: scopes.get(args.join(':')) }] : [])]];
    if (sql.startsWith('SELECT payload')) {
      const row = rows.get(args[0]);
      return [[...(row && row.expires_ms > args[1] ? [row] : [])]];
    }
    if (sql.startsWith('INSERT INTO read_cache_scope')) scopes.set(args.slice(0, 2).join(':'), args[2]);
    else if (sql.startsWith('INSERT INTO read_cache ')) rows.set(args[0], { payload: args[3], expires_ms: args[4] });
    return [[]];
  });
  jest.isolateModules(() => { cache = require('./readCache'); });
});
afterEach(() => { jest.useRealTimers(); delete process.env.READ_CACHE_DISABLED; });

test('coalesces identical reads; clones results and scopes by profile and parameters', async () => {
  const load = jest.fn(async () => ({ items: ['one'] }));
  const [a, b] = await Promise.all([cache.read(options, load), cache.read(options, load)]);
  a.items.push('mutated');
  expect(b.items).toEqual(['one']);
  expect(load).toHaveBeenCalledTimes(1);
  expect((await cache.read(options, load)).items).toEqual(['one']);
  await cache.read({ ...options, profileId: 43 }, load);
  await cache.read({ ...options, key: 'other' }, load);
  expect(load).toHaveBeenCalledTimes(3);
});

test('persists encrypted data across process restart and expires it', async () => {
  const load = jest.fn(async () => ({ personal: 'private' }));
  await cache.read(options, load);
  expect([...rows.values()][0].payload).toBe('encrypted:{"personal":"private"}');
  jest.isolateModules(() => { cache = require('./readCache'); });
  await cache.read(options, load);
  expect(load).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(30001);
  await cache.read(options, load);
  expect(load).toHaveBeenCalledTimes(2);
});

test('invalidation fences another instance and a late fill', async () => {
  let release;
  const old = cache.read(options, () => new Promise(resolve => { release = resolve; }));
  while (!release) await Promise.resolve();
  let second;
  jest.isolateModules(() => { second = require('./readCache'); });
  await second.invalidate(42, 'test');
  release({ version: 'old' });
  await old;
  expect(await cache.read(options, async () => ({ version: 'new' }))).toEqual({ version: 'new' });
});

test('DB outage and corrupt ciphertext fall through to origin; failures are never cached', async () => {
  pool.query.mockRejectedValueOnce(new Error('offline'));
  expect(await cache.read(options, async () => 'live')).toBe('live');
  const load = jest.fn().mockRejectedValueOnce(new Error('origin')).mockResolvedValue('recovered');
  await expect(cache.read(options, load)).rejects.toThrow('origin');
  expect(await cache.read(options, load)).toBe('recovered');
  jest.advanceTimersByTime(5001);
  for (const row of rows.values()) row.payload = 'bad';
  expect(await cache.read(options, async () => 'fresh')).toBe('fresh');
});

test('bounded memory, oversized bypass, disabled switch and encryption failure', async () => {
  for (let n = 0; n < 140; n++) await cache.read({ ...options, key: n }, async () => n);
  expect(cache.stats().entries).toBe(128);
  const large = jest.fn(async () => 'x'.repeat(300000));
  await cache.read({ ...options, key: 'large' }, large);
  await cache.read({ ...options, key: 'large' }, large);
  expect(large).toHaveBeenCalledTimes(2);
  crypto.encrypt.mockRejectedValueOnce(new Error('no key'));
  expect(await cache.read({ ...options, key: 'no-key' }, async () => 'live')).toBe('live');
  process.env.READ_CACHE_DISABLED = 'true';
  expect(await cache.read(options, async () => 'uncached')).toBe('uncached');
});
