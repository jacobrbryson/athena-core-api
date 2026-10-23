jest.mock('../../helpers/db', () => ({ query: jest.fn().mockResolvedValue([[]]), getConnection: jest.fn() }));
jest.mock('../secrets', () => ({ getSecret: jest.fn().mockResolvedValue(null) }));
jest.mock('./store');
jest.mock('./alpaca');
jest.mock('../connectors/webull', () => ({ snapshot: jest.fn() }));

const store = require('./store');
const alpaca = require('./alpaca');
const webull = require('../connectors/webull');
const clock = require('./marketClock');
const engine = require('./engine');

const DATE = '2026-10-22';
const OPEN = Date.parse(clock.sessionFor(DATE).open_at);
const M = 60_000;
const NOW = OPEN + 40 * M; // 10:10 ET

const account = {
  id: 7, uuid: 'a', broker: 'webull', account_type: 'cash', starting_capital: 423, max_risk_per_trade: 4, max_daily_loss: 8, max_trades_per_day: 2, min_reward_risk: 2,
  allow_fractional: false, alerts_enabled: true, costs: { commission_per_order: 0, sec_fee_rate: 0.0000278, taf_fee_per_share: 0.000166, slippage_per_share: 0.01 },
  broker_cash: null, broker_settled_cash: null, broker_checked_at: null,
};
const flat = (base, from, n) => Array.from({ length: n }, (_, i) => ({ t: from + i * M, o: base, h: base * 1.001, l: base * 0.999, c: base, v: 10_000, vw: base }));
const snap = (p, prev) => ({ trade: { p, t: NOW - 2000 }, quote: { bid: p - 0.01, ask: p + 0.01, t: NOW - 2000 }, daily: { o: prev, v: 1e6, vw: p * 0.998 }, prevDaily: { c: prev, v: 2e6 } });

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  engine._cache.clear();
  store.ensureAccount.mockResolvedValue(account);
  store.getAccount.mockResolvedValue(account);
  store.ledger.mockResolvedValue([{ kind: 'opening', amount: 423, trade_date: '2026-10-21', settles_on: '2026-10-21' }]);
  store.positions.mockResolvedValue([]);
  store.ensureStrategyVersion.mockResolvedValue({ id: 1, version: 1, status: 'paper', params_hash: 'h' });
  store.watchlist.mockResolvedValue([{ symbol: 'ABC', company_name: 'ABC Corp', rank: 1, score: 3, reasons: ['gapped 3%'], source: 'scanner', pinned: false }]);
  store.lastScanAt.mockResolvedValue(NOW - 60_000);
  store.signalState.mockResolvedValue(null);
  store.recordEvaluation.mockResolvedValue({ signal_id: 11, uuid: 's', changed: true, from: null, seq: 1 });
  store.insertSnapshot.mockResolvedValue(5);
  store.insertAlert.mockResolvedValue(true);
  store.saveCandles.mockResolvedValue();
  alpaca.SOURCE = 'alpaca';
  alpaca.configured.mockResolvedValue({ configured: true, feed: 'iex' });
  alpaca.createStream.mockReturnValue({ want: jest.fn(), quote: () => null, info: () => ({ status: 'live', feed: 'iex', last_message_at: null, symbols: [] }), stop: jest.fn() });
  alpaca.bars.mockImplementation(async (symbols) => Object.fromEntries(symbols.map((s) => [s, flat(s === 'ABC' ? 20 : 500, OPEN - 30 * M, 70)])));
  alpaca.latestQuotes.mockImplementation(async (symbols) => Object.fromEntries(symbols.map((s) => [s, { bid: 19.99, ask: 20.01, t: NOW - 1000 }])));
  alpaca.snapshots.mockImplementation(async (symbols) => ({ feed: 'iex', data: Object.fromEntries(symbols.map((s) => [s, snap(s === 'ABC' ? 20 : 500, s === 'ABC' ? 19.4 : 498)])) }));
  alpaca.news.mockResolvedValue([{ headline: 'ABC beats', symbols: ['ABC'], source: 'benzinga', created_at: new Date(NOW - 3600_000).toISOString(), url: null }]);
  alpaca.assetName.mockResolvedValue({ name: 'ABC Corp' });
});
afterEach(() => jest.useRealTimers());

test('a full evaluation reads data, classifies the watchlist and records the decision', async () => {
  const p = await engine.evaluate(42);
  expect(p.data).toEqual(expect.objectContaining({ configured: true, feed: 'iex', can_confirm: false }));
  expect(p.market.phase).toBe('open');
  expect(p.overview.regime).toBeDefined();
  expect(p.watchlist).toHaveLength(1);
  expect(p.watchlist[0].signal.status).not.toBe('ENTRY_CONFIRMED');
  expect(p.watchlist[0].catalyst.headline).toBe('ABC beats');
  expect(p.account.cash.usable_settled).toBe(423);
  expect(store.recordEvaluation).toHaveBeenCalledWith(expect.objectContaining({ profileId: 42, versionId: 1, feed: 'iex' }));
  // A status change keeps a snapshot of what was seen.
  expect(store.insertSnapshot).toHaveBeenCalledWith(expect.objectContaining({ kind: 'symbol', symbol: 'ABC' }));
});

test('is throttled: a second call inside 15 s reuses the first', async () => {
  await engine.evaluate(43);
  await engine.evaluate(43);
  expect(store.recordEvaluation).toHaveBeenCalledTimes(1);
});

test('without a market-data key it says so and evaluates nothing', async () => {
  alpaca.configured.mockResolvedValue({ configured: false, feed: null });
  const p = await engine.evaluate(44);
  expect(p.data.configured).toBe(false);
  expect(p.watchlist).toEqual([]);
  expect(store.recordEvaluation).not.toHaveBeenCalled();
});

test('recording a buy needs a stop below entry and enough recorded cash', async () => {
  expect((await engine.recordEntry(45, { symbol: 'ABC', shares: 2, price: 20, stop: 21 })).error).toMatch(/stop below/);
  expect((await engine.recordEntry(45, { symbol: 'ABC', shares: 50, price: 20, stop: 19 })).error).toMatch(/can't buy on credit/);
  store.openPosition.mockResolvedValue('pos-1');
  store.position.mockResolvedValue({ uuid: 'pos-1' });
  const ok = await engine.recordEntry(45, { symbol: 'abc', shares: 2, price: 20, stop: 19.5, target: 21 });
  expect(ok.position.uuid).toBe('pos-1');
  const [row, ledger] = store.openPosition.mock.calls[0];
  expect(row).toEqual(expect.objectContaining({ mode: 'live', symbol: 'ABC', shares: 2, planned_stop: 19.5 }));
  expect(ledger[0]).toEqual(expect.objectContaining({ kind: 'buy', amount: -40 }));
});

test('a sale before the funds settled warns of a good-faith violation', async () => {
  store.position.mockResolvedValue({ id: 3, uuid: 'p', mode: 'live', status: 'open', symbol: 'ABC', shares: 2, entry_price: 20, entry_at: new Date(NOW - 10 * M).toISOString(), planned_entry: 20, planned_stop: 19.5, entry_fees: 0, unsettled_funds_used: 40, funds_settle_on: '2026-10-23' });
  store.closePosition.mockResolvedValue(true);
  store.candles.mockResolvedValue([]);
  store.signalsForDay.mockResolvedValue([]);
  store.saveDailySummary.mockResolvedValue();
  const out = await engine.recordExit(46, 'p', { price: 21, followed_plan: true });
  expect(out.warnings.join(' ')).toMatch(/good-faith/);
  const [, { journal }, ledger] = store.closePosition.mock.calls[0];
  expect(journal).toEqual(expect.objectContaining({ realized_pl: 2, planned_risk: 1, r_multiple: 2, followed_plan: true }));
  expect(ledger[0]).toEqual(expect.objectContaining({ kind: 'sell', amount: 42, settles_on: '2026-10-23' }));
});

test('reconcile reads Webull and records an explicit adjustment only when asked', async () => {
  webull.snapshot.mockResolvedValue({ checked_at: 'x', accounts: [{ label: 'Cash', type: 'CASH', balance: { cash: 430, settled_cash: 430, buying_power: 430 } }] });
  store.recordBrokerCheck.mockResolvedValue();
  store.addLedger.mockResolvedValue();
  const look = await engine.reconcile(47);
  expect(look.difference).toBe(7);
  expect(store.addLedger).not.toHaveBeenCalled();
  await engine.reconcile(47, { apply: true });
  expect(store.addLedger).toHaveBeenCalledWith(7, [expect.objectContaining({ kind: 'adjustment', amount: 7 })]);
});
