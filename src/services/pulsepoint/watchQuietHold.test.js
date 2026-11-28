jest.mock('../../helpers/db', () => ({ query: jest.fn(), getConnection: jest.fn() }));
jest.mock('../initiative', () => ({ getPref: jest.fn(), inQuietHours: jest.fn(), quietEndsAt: jest.fn() }));
jest.mock('../push', () => ({ deliverNudge: jest.fn() }));

const pool = require('../../helpers/db');
const initiative = require('../initiative');
const push = require('../push');
const watch = require('./watch');

// A held alert keeps its full three hours counted from the end of quiet hours
// (owner, 2026-11-28). Before, a 2am call expired at 5am, before a 6am release.
const SIX_AM = new Date('2026-11-25T11:00:00Z');
const alert = { dedupeKey: 'k1', text: 'Structure fire on Main St', urgent: false, facts: { incidentIds: ['1'] } };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  initiative.getPref.mockResolvedValue({ enabled: true, timezone: 'America/New_York', quiet_from: 22, quiet_to: 6 });
  initiative.quietEndsAt.mockReturnValue(SIX_AM);
  push.deliverNudge.mockResolvedValue({ sent: 1 });
});

afterEach(() => jest.restoreAllMocks());

test('an alert held for quiet hours has its expiry moved to three hours after the window ends', async () => {
  initiative.inQuietHours.mockReturnValue(true);
  pool.query.mockResolvedValue([{ affectedRows: 1 }]);

  const out = await watch._tell(1, alert);

  expect(out.pushed.skipped).toBe('held for quiet hours');
  expect(push.deliverNudge).not.toHaveBeenCalled();
  const update = pool.query.mock.calls.find(([sql]) => /UPDATE athena_nudge/.test(sql));
  expect(update[0]).toMatch(/GREATEST\(expires_at, DATE_ADD\(\?, INTERVAL \? SECOND\)\)/);
  expect(update[1][0]).toBe(SIX_AM);
  expect(update[1][1]).toBe(3 * 60 * 60);
});

test('if the expiry cannot be moved, the alert is pushed now rather than risk losing it', async () => {
  initiative.inQuietHours.mockReturnValue(true);
  pool.query.mockImplementation(async (sql) => {
    if (/UPDATE athena_nudge/.test(sql)) throw new Error('lost connection');
    return [{ affectedRows: 1 }];
  });

  const out = await watch._tell(1, alert);

  expect(push.deliverNudge).toHaveBeenCalledTimes(1);
  expect(out.pushed.sent).toBe(1);
});

test('outside quiet hours the alert is pushed at once and its expiry is left alone', async () => {
  initiative.inQuietHours.mockReturnValue(false);
  pool.query.mockResolvedValue([{ affectedRows: 1 }]);

  await watch._tell(1, alert);

  expect(push.deliverNudge).toHaveBeenCalledTimes(1);
  expect(pool.query.mock.calls.some(([sql]) => /UPDATE athena_nudge/.test(sql))).toBe(false);
});

test('an urgent alert is never held and never has its expiry moved', async () => {
  initiative.inQuietHours.mockReturnValue(true);
  pool.query.mockResolvedValue([{ affectedRows: 1 }]);

  await watch._tell(1, { ...alert, urgent: true });

  expect(push.deliverNudge).toHaveBeenCalledTimes(1);
  expect(initiative.getPref).not.toHaveBeenCalled();
  expect(pool.query.mock.calls.some(([sql]) => /UPDATE athena_nudge/.test(sql))).toBe(false);
});
