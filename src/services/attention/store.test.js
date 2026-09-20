jest.mock('../../helpers/db', () => ({ query: jest.fn() }));
jest.mock('../parent-helpers', () => ({ withTransaction: jest.fn(fn => fn(require('../../helpers/db'))) }));
jest.mock('../../helpers/crypto', () => ({ encrypt: jest.fn(async v => `encrypted:${v}`), decrypt: jest.fn(async v => v.slice(10)) }));
const pool = require('../../helpers/db');
const store = require('./store');
const w = { id: 1, profile_id: 42, generation: 'g1', lease_token: 'lease1' };
beforeEach(() => { jest.clearAllMocks(); pool.query.mockResolvedValue([{ affectedRows: 1 }]); });

test('duplicate deliveries use a stable database unique key while distinct resources/types remain distinct', async () => {
  const a = { key: ['trace', 'updated', 'activity-a'], resourceId: 'activity-a', type: 'updated' };
  await store.enqueue(1, a); await store.enqueue(1, a);
  await store.enqueue(1, { ...a, key: ['trace', 'updated', 'activity-b'], resourceId: 'activity-b' });
  expect(pool.query.mock.calls[0][0]).toContain('ON DUPLICATE KEY');
  expect(pool.query.mock.calls[0][1][2]).toBe(pool.query.mock.calls[1][1][2]);
  expect(pool.query.mock.calls[0][1][2]).not.toBe(pool.query.mock.calls[2][1][2]);
});
test('a webhook can only enqueue for an opted-in owner of an active matching account', async () => {
  pool.query.mockResolvedValueOnce([[]]); await store.receive('99', { key: 'key', resourceId: 'activity', type: 'updated' });
  expect(pool.query).toHaveBeenCalledTimes(1);
  const [sql, args] = pool.query.mock.calls[0];
  expect(sql).toMatch(/c.profile_id = w.profile_id/); expect(sql).toMatch(/w.enabled = 1/);
  expect(sql).toMatch(/c.status = 'active'/); expect(sql).toMatch(/FOR UPDATE/); expect(args).toEqual(['99']);
});
test('claim is atomic and includes generation plus expired lease check', async () => {
  pool.query.mockResolvedValue([{ affectedRows: 0 }]);
  expect(await store.claim(w)).toBeNull();
  expect(pool.query.mock.calls[0][0]).toMatch(/generation = \?/);
  expect(pool.query.mock.calls[0][0]).toMatch(/lease_until <= NOW/);
});
test('lost lease rejects an old worker before it writes an analysis or settles an event', async () => {
  pool.query.mockResolvedValueOnce([[]]);
  await expect(store.complete(w, { id: 2 }, { payload: { private: 'data' } })).rejects.toMatchObject({ code: 'lease_lost' });
  expect(pool.query).toHaveBeenCalledTimes(1);
  expect(pool.query.mock.calls[0][0]).toMatch(/generation = \?.*\s+AND enabled = 1 AND lease_token = \? AND lease_until > NOW/);
});
test('successful completion stores encrypted snapshots and settlement in the fenced transaction', async () => {
  pool.query.mockResolvedValueOnce([[{ id: 1 }]]);
  await store.complete(w, { id: 2, resource_id: 'activity' }, { payload: { observation: 'private activity' }, observationHash: 'h', contextHash: 'c' });
  const insert = pool.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO attention_record'));
  expect(insert[1].at(-1)).toMatch(/^encrypted:/);
  expect(pool.query.mock.calls.some(([sql]) => sql.includes("status = 'done'"))).toBe(true);
});
test('restart can reclaim processing work left by an expired worker', async () => {
  pool.query.mockResolvedValueOnce([[{ id: 1 }]]).mockResolvedValueOnce([[{ id: 2, attempts: 1, status: 'processing' }]]);
  expect(await store.nextEvent(w)).toMatchObject({ id: 2, attempts: 2 });
  expect(pool.query.mock.calls[1][0]).toContain("'processing'");
  expect(pool.query.mock.calls[1][0]).toContain('FOR UPDATE');
});
test('retry retains work indefinitely with a bounded delay, never marks it discarded', async () => {
  pool.query.mockResolvedValueOnce([[{ id: 1 }]]);
  await store.retry(w, { id: 2, attempts: 100 }, 'processing_failed');
  const [sql, args] = pool.query.mock.calls[1];
  expect(sql).toContain("status = 'retry'"); expect(args[1]).toBe(3600);
});
test('source cursor cannot advance when enqueue fails', async () => {
  pool.query.mockResolvedValueOnce([[{ id: 1 }]]).mockRejectedValueOnce(new Error('write failed'));
  await expect(store.syncPage(w, [{ key: 'x', resourceId: 'a', type: 'reconcile' }], { nextToken: 'next' })).rejects.toThrow('write failed');
  expect(pool.query.mock.calls.some(([sql]) => sql.includes('SET sync_state'))).toBe(false);
});

test('another owner cannot correct a guessed review UUID', async () => {
  pool.query.mockResolvedValueOnce([[{ id: 9, profile_id: 99 }]])
    .mockResolvedValueOnce([[{ id: 9 }]]).mockResolvedValueOnce([[]]);
  await expect(store.feedback(99, 'someone-elses-review', { label: 'Forged' })).rejects.toMatchObject({ status: 404 });
  expect(pool.query.mock.calls[2][1]).toEqual(['someone-elses-review', 9]);
  expect(pool.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE attention_record'))).toBe(false);
});
