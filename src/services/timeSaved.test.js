jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('uuid', () => ({ v4: () => '00000000-0000-4000-8000-000000000000' }));
const pool = require('../helpers/db');
const { getTimeSaved, MINUTES } = require('./timeSaved');
const { ACTIONS } = require('./actions/registry');

const NOW = new Date('2026-09-30T15:00:00Z');
const rows = (list) => pool.query.mockResolvedValue([list.map(([action_id, day, n]) => ({ action_id, day, n }))]);

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
  expect(args).toEqual([42]);
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
