jest.mock('../../helpers/db', () => ({ query: jest.fn() }));
jest.mock('./store', () => ({ watch: jest.fn(), configure: jest.fn(), records: jest.fn(), feedback: jest.fn(), queueStatus: jest.fn(), forget: jest.fn(), recheck: jest.fn() }));
jest.mock('./whoop', () => ({ authorize: jest.fn() }));
jest.mock('../credentials', () => ({ list: jest.fn() }));
const pool = require('../../helpers/db');
const store = require('./store');
const source = require('./whoop');
const service = require('./index');
const watch = { id: 1, profile_id: 42, enabled: 1 };
const record = { uuid: 'r', resource_id: 'a', payload: {
  observation: { state: 'present', label: 'Frisbee' },
  context: { calendarCredential: 'calendar1', evidence: [{ id: 'memory:fact1', kind: 'memory', value: { key: 'occupation', text: 'Coach' } }] },
  interpretation: { label: 'Coaching', status: 'likely', evidence_ids: ['memory:fact1'] },
} };
beforeEach(() => { jest.resetAllMocks(); store.records.mockResolvedValue([record]); source.authorize.mockResolvedValue({ calendarCredential: 'calendar1' }); store.watch.mockResolvedValue(watch); pool.query.mockResolvedValue([[{ uuid: 'fact1', memory_key: 'occupation', memory_value: 'Coach' }]]); });
test('forgotten facts invalidate saved reasoning in both the panel and chat', async () => {
  pool.query.mockResolvedValue([[]]);
  const result = await service.visibleRecords(watch, { calendarCredential: 'calendar1' });
  expect(result[0]).toMatchObject({ stale: true, evidence: [], interpretation: null });
  expect(await service.promptBlock(42)).toBeNull();
});
test('a changed calendar account cannot reuse old derived reasoning', async () => {
  const result = await service.visibleRecords(watch, { calendarCredential: 'calendar2' });
  expect(result[0].stale).toBe(true); expect(result[0].interpretation).toBeNull();
});
test('chat distinguishes source label, tentative inference and human correction', async () => {
  expect(await service.promptBlock(42)).toContain('likely');
  store.records.mockResolvedValue([{ ...record, feedback: { label: 'Soccer coaching', note: 'Confirmed by me' } }]);
  const text = await service.promptBlock(42);
  expect(text).toContain('user_confirmed'); expect(text).toContain('Soccer coaching'); expect(text).toContain('Frisbee');
});
test('paused reviews are not injected into chat', async () => {
  store.watch.mockResolvedValue({ ...watch, enabled: 0 });
  expect(await service.promptBlock(42)).toBeNull(); expect(store.records).not.toHaveBeenCalled();
});
test('feedback rejects oversized or executable payloads as labels and uses the authenticated owner', async () => {
  await expect(service.feedback(42, 'r', { kind: 'correct', label: { sql: 'DROP TABLE' } })).rejects.toMatchObject({ status: 400 });
  await service.feedback(42, 'r', { kind: 'correct', label: 'Coaching', profile_id: 999 });
  expect(store.feedback).toHaveBeenCalledWith(42, 'r', { kind: 'correct', label: 'Coaching', note: '' });
});
