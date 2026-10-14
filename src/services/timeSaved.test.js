jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('uuid', () => ({ v4: () => '00000000-0000-4000-8000-000000000000' }));
jest.mock('./codeAgents', () => ({ ...jest.requireActual('./codeAgents'), fixStatus: jest.fn() }));
const pool = require('../helpers/db');
const codeAgents = require('./codeAgents');
const { getTimeSaved, MINUTES } = require('./timeSaved');
const { ACTIONS } = require('./actions/registry');

const NOW = new Date('2026-09-30T15:00:00Z');
// The grouped read, then the merge-gated read (fixes, one row each).
const rows = (list, fixes = []) =>
  pool.query
    .mockReset()
    .mockResolvedValueOnce([list.map(([action_id, day, n]) => ({ action_id, day, n }))])
    .mockResolvedValueOnce([fixes.map(([day, result_ref]) => ({ action_id: 'fix_code', day, result_ref }))]);

test('every registered action has a deliberate minutes value, even when it is zero', () => {
  expect(ACTIONS.map((a) => a.id).filter((id) => !(id in MINUTES))).toEqual([]);
});

test('counts only done actions for the caller, split by month, action and recent day', async () => {
  rows([
    ['create_calendar_event', '2026-09-29', 3],
    ['delete_email', '2026-09-30', 8],
    ['dismiss_email', '2026-09-30', 5],
    ['create_calendar_event', '2026-08-15', 2],
    ['remember_fact', '2026-07-01', 4],
  ]);
  const r = await getTimeSaved(42, NOW);
  const [sql, args] = pool.query.mock.calls[0];
  expect(sql).toMatch(/status = 'done'/);
  expect(sql).toMatch(/JSON_LENGTH\(params, '\$\.email_triage_uuids'\)/);
  expect(sql).toMatch(/action_id NOT IN \(\?\)/);
  expect(args).toEqual([42, ['fix_code']]);
  expect(r.minutesThisMonth).toBe(8); // 3×2 + 8×0.25 + 5×0
  expect(r.minutesLastMonth).toBe(4);
  expect(r.minutesAllTime).toBe(14);
  expect(r.actionsThisMonth).toBe(16);
  expect(r.since).toBe('2026-07-01');
  expect(r.byAction.map((a) => [a.actionId, a.count, a.minutes])).toEqual([
    ['create_calendar_event', 3, 6], ['delete_email', 8, 2], ['dismiss_email', 5, 0],
  ]);
  expect(r.daily).toEqual([{ date: '2026-09-29', minutes: 6 }, { date: '2026-09-30', minutes: 2 }]);
});

test('an action the registry no longer knows counts for nothing rather than guessing', async () => {
  rows([['retired_action', '2026-09-10', 4]]);
  const r = await getTimeSaved(42, NOW);
  expect(r.minutesThisMonth).toBe(0);
  expect(r.byAction[0]).toMatchObject({ actionId: 'retired_action', label: 'retired_action', minutesEach: 0 });
});

test('nothing done yet is zeros, not an error', async () => {
  rows([]);
  expect(await getTimeSaved(42, NOW)).toMatchObject({ minutesThisMonth: 0, minutesAllTime: 0, since: null, byAction: [], daily: [] });
});

test('a bundle counts every email it covered, at the per-item rate', async () => {
  rows([['archive_emails', '2026-09-30', 30]]);
  const r = await getTimeSaved(42, NOW);
  expect(r.minutesThisMonth).toBe(3);
  expect(r.byAction[0]).toMatchObject({ actionId: 'archive_emails', count: 30, minutesEach: 0.1 });
});

test('a fix counts only once its pull request merged', async () => {
  const states = { 'a/b#1': 'merged', 'a/b#2': 'closed', 'a/b#3': 'open', 'a/b#4': 'working' };
  codeAgents.fixStatus.mockImplementation(async (ref) => ({ state: states[ref] }));
  rows([], [['2026-09-29', 'a/b#1'], ['2026-09-29', 'a/b#2'], ['2026-09-30', 'a/b#3'], ['2026-09-30', 'a/b#4']]);
  const r = await getTimeSaved(42, NOW);
  expect(r.minutesThisMonth).toBe(MINUTES.fix_code);
  expect(r.byAction).toEqual([expect.objectContaining({ actionId: 'fix_code', count: 1 })]);
});

test('a fix whose status GitHub cannot give counts for nothing', async () => {
  codeAgents.fixStatus.mockRejectedValue(new Error('GitHub down'));
  rows([], [['2026-09-29', 'a/b#1']]);
  const r = await getTimeSaved(42, NOW);
  expect(r.minutesAllTime).toBe(0);
  expect(r.actionsAllTime).toBe(0);
});
