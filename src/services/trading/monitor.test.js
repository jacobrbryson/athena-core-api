jest.mock('../../helpers/db', () => ({ query: jest.fn(), getConnection: jest.fn() }));
jest.mock('../secrets', () => ({ getSecret: jest.fn().mockResolvedValue(null) }));
jest.mock('../guardianEngine/dispatch', () => ({ configured: jest.fn().mockReturnValue(true), wakeAt: jest.fn().mockResolvedValue(true), dispatchNow: jest.fn().mockResolvedValue({ ok: true }), verifyCaller: jest.fn() }));
jest.mock('./engine', () => ({ evaluate: jest.fn().mockResolvedValue({ watchlist: [] }) }));
jest.mock('./notifications', () => ({ enabledProfiles: jest.fn(), process: jest.fn().mockResolvedValue({ created: 0, sent: 0 }) }));

const dispatch = require('../guardianEngine/dispatch');
const engine = require('./engine');
const notifications = require('./notifications');
const clock = require('./marketClock');
const monitor = require('./monitor');
const { tickWith } = require('../../controllers/tradingMonitor');

const DATE = '2026-10-22';
const OPEN = Date.parse(clock.sessionFor(DATE).open_at);
const M = 60_000;

beforeEach(() => {
  jest.clearAllMocks();
  monitor._reset();
  process.env.GUARDIAN_DISPATCH_AUDIENCE = 'https://core.example';
  notifications.enabledProfiles.mockResolvedValue([1]);
});

test('the window is trading days only, 15 min before the open to 10 after the close', () => {
  expect(monitor.inWindow(OPEN - 16 * M)).toBe(false);
  expect(monitor.inWindow(OPEN - 15 * M)).toBe(true);
  expect(monitor.inWindow(Date.parse(clock.sessionFor(DATE).close_at) + 10 * M)).toBe(true);
  expect(monitor.inWindow(Date.parse(clock.sessionFor(DATE).close_at) + 11 * M)).toBe(false);
  expect(monitor.inWindow(clock.etToUtc('2026-10-24', 11 * 60).getTime())).toBe(false); // Saturday
});

test('a tick evaluates server-side, notifies, and books the next one', async () => {
  const out = await monitor.tick({ now: OPEN + 30 * M });
  expect(engine.evaluate).toHaveBeenCalledWith(1);
  expect(notifications.process).toHaveBeenCalled();
  expect(dispatch.wakeAt).toHaveBeenCalledWith(OPEN + 31 * M, { url: 'https://core.example/internal/trading/tick', name: 'trading-tick', reason: 'tick' });
  expect(out.next_booked).toBe(true);
});

test('no chain without anyone opted in, and none past the window', async () => {
  notifications.enabledProfiles.mockResolvedValue([]);
  await monitor.tick({ now: OPEN + 30 * M });
  expect(dispatch.wakeAt).not.toHaveBeenCalled();
  notifications.enabledProfiles.mockResolvedValue([1]);
  await monitor.tick({ now: Date.parse(clock.sessionFor(DATE).close_at) + 9.5 * M });
  expect(dispatch.wakeAt).not.toHaveBeenCalled();
});

test('a market-data outage still runs the notifications pass', async () => {
  engine.evaluate.mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'rate_limited' }));
  const out = await monitor.tick({ now: OPEN + 30 * M });
  expect(notifications.process).toHaveBeenCalledWith(1, expect.objectContaining({ dashboard: null }));
  expect(out.next_booked).toBe(true);
});

test('the backstop is ignored while the chain is alive', async () => {
  await monitor.tick({ now: OPEN + 30 * M });
  expect(await monitor.tick({ now: OPEN + 31 * M, reason: 'backstop' })).toMatchObject({ skipped: 'chain alive' });
  expect((await monitor.tick({ now: OPEN + 34 * M, reason: 'backstop' })).skipped).toBeUndefined();
});

test('the tick route answers only an allowed caller', async () => {
  const res = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
  await tickWith({ body: {} }, res, { verify: async () => false, run: jest.fn() });
  expect(res.status).toHaveBeenCalledWith(401);
  const run = jest.fn().mockResolvedValue({ phase: 'open', profiles: 1, results: [{ sent: 1 }], next_booked: true });
  await tickWith({ body: { reason: 'backstop' } }, res, { verify: async () => true, run });
  expect(run).toHaveBeenCalledWith({ reason: 'backstop' });
});
