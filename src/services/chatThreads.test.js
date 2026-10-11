jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('./actions', () => ({ get: jest.fn() }));
jest.mock('./codeAgents', () => ({ mayUse: jest.fn(), findings: jest.fn(), fixStatus: jest.fn() }));
const pool = require('../helpers/db');
const actions = require('./actions');
const code = require('./codeAgents');
const threads = require('./chatThreads');
beforeEach(() => jest.resetAllMocks());

test('history resolves live outcomes only against the caller profile and displays expired requests', async () => {
  actions.get.mockResolvedValueOnce({ uuid: 'a', status: 'pending', expires_at: '2000-01-01' }).mockResolvedValueOnce(null);
  const history = await threads.hydrate([{ uuid: 'm', action_uuid: 'a' }, { uuid: 'other', action_uuid: 'b' }], 42);
  expect(actions.get.mock.calls).toEqual([[42, 'a'], [42, 'b']]);
  expect(history[0].action.status).toBe('expired');
  expect(history[1].action).toBeUndefined();
});

test('an anonymous history never resolves private action data', async () => {
  await threads.hydrate([{ action_uuid: 'a' }], null);
  expect(actions.get).not.toHaveBeenCalled();
});

test('reminder history retains each occurrence independent of notification expiry or reaction', async () => {
  pool.query.mockResolvedValue([{}]);
  await threads.syncReminderUpdates(7, 42);
  const [sql, params] = pool.query.mock.calls[0];
  expect(params).toEqual([7, 42]);
  expect(sql).toContain('INSERT IGNORE');
  expect(sql).toContain('reminder.profile_id = n.profile_id');
  expect(sql).toContain('a.profile_id = n.profile_id');
  expect(sql).toContain('n.created_at');
  expect(sql).not.toContain('n.expires_at');
  expect(sql).not.toContain('n.status');
});

test('background updates are idempotent, private and anchored through an owned action', async () => {
  pool.query.mockResolvedValue([{}]);
  await threads.appendActionUpdate(42, 'a', 'occurrence:1', 'Posted');
  await threads.appendActionUpdate(42, 'a', 'occurrence:1', 'Posted');
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toContain('a.uuid = ? AND a.profile_id = ?');
  expect(params.slice(-2)).toEqual(['a', 42]);
  expect(pool.query.mock.calls[1][1][0]).toBe(params[0]);
  expect(pool.query.mock.calls[1][1][3]).toBe(params[3]);
});

test('code progress obeys the existing owner eligibility check', async () => {
  pool.query.mockResolvedValue([[{ uuid: 'a', action_id: 'fix_code', result_ref: 'repo#1' }]]);
  code.mayUse.mockResolvedValue(false);
  await threads.syncCodeUpdates(7, 42);
  expect(code.fixStatus).not.toHaveBeenCalled();
  expect(pool.query).toHaveBeenCalledTimes(1);
});

test('a merged PR update does not claim verified deployment', async () => {
  pool.query.mockResolvedValueOnce([[{ uuid: 'a', action_id: 'fix_code', result_ref: 'repo#1' }]]).mockResolvedValue([{}]);
  code.mayUse.mockResolvedValue(true);
  code.fixStatus.mockResolvedValue({ state: 'merged', url: 'https://github.com/repo/pull/1' });
  await threads.syncCodeUpdates(7, 42);
  expect(pool.query.mock.calls[1][1][1]).toContain('Deployment has not been verified');
});
