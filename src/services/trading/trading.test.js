jest.mock('../../helpers/db', () => ({ query: jest.fn(), getConnection: jest.fn() }));
jest.mock('../secrets', () => ({ getSecret: jest.fn().mockResolvedValue(null) }));
const clock = require('./marketClock');
const ind = require('./indicators');
const strategy = require('./strategy');
const { sizePosition, riskBudget } = require('./risk');
const cash = require('./cash');
const analytics = require('./analytics');
const backtest = require('./backtest');
const { measure } = require('./outcomes');
const scanner = require('./scanner');

const DATE = '2026-10-22'; // a Thursday
const session = clock.sessionFor(DATE);
const OPEN = Date.parse(session.open_at);
const M = 60_000;

// A textbook day: a 15-minute range topping at 101.00, a pullback, a closed
// breakout candle on volume, a retest that holds, and a candle back above it.
function breakoutDay() {
  const bars = [];
  for (let i = 0; i < 15; i++) {
    const c = 99.8 + 0.06 * i;
    bars.push({ t: OPEN + i * M, o: c - 0.05, h: i === 10 ? 101.0 : Math.min(100.9, c + 0.1), l: 99.6 + 0.04 * i, c, v: 10_000 });
  }
  const tail = [
    [100.6, 100.75, 100.6, 100.7], [100.6, 100.6, 100.1, 100.4], [100.4, 100.65, 100.5, 100.6], [100.6, 100.75, 100.6, 100.7],
    [100.7, 100.85, 100.7, 100.8], [100.8, 101.0, 100.8, 100.95], [101.1, 101.4, 101.1, 101.3], [101.3, 101.6, 101.2, 101.5],
    [101.4, 101.35, 101.05, 101.2], [101.3, 101.7, 101.3, 101.7], [101.7, 101.7, 101.6, 101.7],
  ];
  tail.forEach(([o, h, l, c], k) => bars.push({ t: OPEN + (15 + k) * M, o, h: Math.max(h, o, c), l, c, v: k === 6 ? 30_000 : 10_000 }));
  // Premarket, well below the range.
  for (let i = 1; i <= 20; i++) bars.unshift({ t: OPEN - i * M, o: 100, h: 100.5, l: 99.5, c: 100, v: 2_000 });
  return bars;
}

function priorDays() {
  return clock.previousTradingDays(DATE, 10).map((d) => {
    const open = Date.parse(clock.sessionFor(d).open_at);
    return { date: d, open_at: open, bars: Array.from({ length: 390 }, (_, i) => ({ t: open + i * M, o: 100, h: 100.2, l: 99.8, c: 100, v: 5_000 })) };
  });
}

const account = {
  settledCash: 423, riskBudget: 4, rewardRisk: 2, allowFractional: false, tradesToday: 0, maxTradesPerDay: 2, accountValue: 423,
  costs: { commission_per_order: 0, sec_fee_rate: 0.0000278, taf_fee_per_share: 0.000166, slippage_per_share: 0.01 },
};

function input(over = {}) {
  const asOf = OPEN + 26 * M;
  return {
    symbol: 'TEST', asOf, session, bars: breakoutDay(), feed: 'sip',
    quote: { bid: 101.69, ask: 101.71, t: asOf - 2000 },
    priorDays: priorDays(), prevDay: { h: 105, l: 98, c: 99.5 }, avgDailyDollarVolume: 500e6,
    market: { spy: { above_vwap: true }, qqq: { above_vwap: true } }, events: [], account, ...over,
  };
}

const cond = (r, id) => r.conditions.find((c) => c.id === id);

describe('marketClock', () => {
  test('knows holidays, early closes and T+1 across a weekend and Thanksgiving', () => {
    expect(clock.isTradingDay('2026-11-26')).toBe(false);
    expect(clock.sessionFor('2026-11-27').early_close).toBe(true);
    expect(clock.settlementDate('2026-10-23')).toBe('2026-10-26');
    expect(clock.settlementDate('2026-11-25')).toBe('2026-11-27');
  });
  test('converts ET wall time across daylight saving', () => {
    expect(clock.etToUtc('2026-10-22', 570).toISOString()).toBe('2026-10-22T13:30:00.000Z');
    expect(clock.etToUtc('2026-12-01', 570).toISOString()).toBe('2026-12-01T14:30:00.000Z');
    expect(clock.phase(new Date('2026-10-22T14:00:00Z')).phase).toBe('open');
    expect(clock.phase(new Date('2026-10-22T12:00:00Z')).phase).toBe('premarket');
  });
  test('flags dates past the holiday table', () => {
    expect(clock.sessionFor('2028-03-01').calendar_verified).toBe(false);
  });
});

describe('indicators', () => {
  test('VWAP is cumulative volume-weighted price', () => {
    const v = ind.vwapSeries([{ h: 10, l: 10, c: 10, v: 100 }, { h: 20, l: 20, c: 20, v: 300 }]);
    expect(v[1]).toBeCloseTo(17.5);
  });
  test('closedBars drops the candle still forming', () => {
    expect(ind.closedBars([{ t: 0 }, { t: M }], M + 30_000)).toHaveLength(1);
  });
  test('a swing low is only known once the bars after it have closed', () => {
    const bars = [5, 4, 3, 4, 5].map((l, i) => ({ t: i, l, h: l + 1 }));
    expect(ind.swingLows(bars, 2)).toHaveLength(1);
    expect(ind.swingLows(bars.slice(0, 4), 2)).toHaveLength(0);
  });
});

describe('strategy.evaluate', () => {
  test('confirms the textbook breakout-retest on SIP data with every condition passing', () => {
    const r = strategy.evaluate(input());
    expect(r.status).toBe('ENTRY_CONFIRMED');
    for (const id of ['above_vwap', 'vwap_rising', 'higher_lows', 'breakout', 'retest_hold', 'volume', 'spread', 'risk_budget', 'reward_risk', 'event_data']) {
      expect([id, cond(r, id).state]).toEqual([id, 'pass']);
    }
    expect(r.sizing.ok).toBe(true);
    expect(r.sizing.est_loss_with_costs).toBeLessThanOrEqual(4);
    expect(r.sizing.position_cost).toBeLessThanOrEqual(423);
    expect(r.levels.stop).toBeLessThan(r.levels.retest_low);
    expect(r.confirmed).toEqual(expect.objectContaining({ entry: r.sizing.entry, stop: r.sizing.stop, target: r.sizing.target }));
  });

  test('never confirms on the IEX feed', () => {
    const r = strategy.evaluate(input({ feed: 'iex' }));
    expect(r.status).toBe('WAIT');
    expect(cond(r, 'event_data').state).toBe('fail');
    expect(r.reason).toMatch(/IEX/);
  });

  test('never confirms on a stale quote', () => {
    const r = strategy.evaluate(input({ quote: { bid: 101.69, ask: 101.71, t: OPEN + 26 * M - 120_000 } }));
    expect(r.status).toBe('WAIT');
    expect(r.data.stale).toBe(true);
  });

  test('an intrabar poke above the range is not a breakout', () => {
    // Evaluate half-way through the breakout minute: its candle hasn't closed.
    const r = strategy.evaluate(input({ asOf: OPEN + 21 * M + 30_000, quote: { bid: 101.2, ask: 101.22, t: OPEN + 21 * M + 29_000 } }));
    expect(cond(r, 'breakout').state).toBe('pending');
    expect(r.status).not.toBe('ENTRY_CONFIRMED');
  });

  test('observes without signalling during the opening range', () => {
    const r = strategy.evaluate(input({ asOf: OPEN + 10 * M }));
    expect(r.status).toBe('WATCH');
  });

  test('future candles cannot change a past evaluation', () => {
    const asOf = OPEN + 26 * M;
    const extra = Array.from({ length: 30 }, (_, i) => ({ t: asOf + i * M, o: 90, h: 90, l: 80, c: 85, v: 1e6 }));
    const a = strategy.evaluate(input());
    const b = strategy.evaluate(input({ bars: [...breakoutDay(), ...extra] }));
    expect(b.status).toBe(a.status);
    expect(b.indicators).toEqual(a.indicators);
  });

  test('a budget that cannot carry one share at the structural stop is AVOID, and the stop is not moved', () => {
    const r = strategy.evaluate(input({ account: { ...account, riskBudget: 0.3 } }));
    expect(r.status).toBe('AVOID');
    expect(r.levels.stop).toBe(strategy.evaluate(input()).levels.stop);
  });

  test('a scheduled event inside the blackout window holds the entry', () => {
    const r = strategy.evaluate(input({ events: [{ name: 'FOMC rate decision', at: new Date(OPEN + 40 * M).toISOString() }] }));
    expect(r.status).toBe('WAIT');
    expect(r.reason).toMatch(/FOMC/);
  });

  test('market weakness conflicts with the long thesis', () => {
    const r = strategy.evaluate(input({ market: { spy: { above_vwap: false }, qqq: { above_vwap: false } } }));
    expect(r.status).not.toBe('ENTRY_CONFIRMED');
    expect(cond(r, 'market').state).toBe('fail');
  });

  test('a confirmed setup ends at its stop', () => {
    const first = strategy.evaluate(input());
    const asOf = OPEN + 28 * M;
    const drop = [{ t: OPEN + 26 * M, o: 101.5, h: 101.6, l: 100.5, c: 100.6, v: 20_000 }, { t: OPEN + 27 * M, o: 100.6, h: 100.7, l: 100.4, c: 100.5, v: 20_000 }];
    const r = strategy.evaluate(input({ asOf, bars: [...breakoutDay(), ...drop], quote: { bid: 100.5, ask: 100.52, t: asOf - 1000 }, previous: { status: 'ENTRY_CONFIRMED', confirmed: first.confirmed } }));
    expect(r.status).toBe('EXIT_INVALIDATED');
    expect(r.exit).toBe('stop');
  });

  test('below VWAP is WAIT with what has to happen next', () => {
    const bars = breakoutDay().map((b) => (b.t >= OPEN ? { ...b, o: 200 - b.o, h: 200 - b.l, l: 200 - b.h, c: 200 - b.c } : b));
    const r = strategy.evaluate(input({ bars, quote: { bid: 98.3, ask: 98.32, t: OPEN + 26 * M - 1000 } }));
    expect(r.status).toBe('WAIT');
    expect(cond(r, 'above_vwap').state).toBe('fail');
    expect(r.next_step).toMatch(/VWAP/);
  });
});

describe('risk', () => {
  test('sizes by the smaller of cash and risk, and rejects zero shares', () => {
    const a = sizePosition({ entry: 20, stop: 19, settledCash: 423, riskBudget: 4, rewardRisk: 2, costs: {} });
    expect(a.shares).toBe(4);
    expect(a.limited_by).toBe('risk');
    expect(a.target).toBe(22);
    const b = sizePosition({ entry: 200, stop: 199, settledCash: 423, riskBudget: 4, rewardRisk: 2, costs: {} });
    expect(b.shares).toBe(2);
    expect(b.limited_by).toBe('cash');
    expect(sizePosition({ entry: 50, stop: 40, settledCash: 423, riskBudget: 4, rewardRisk: 2, costs: {} }).ok).toBe(false);
    expect(sizePosition({ entry: 50, stop: 51, settledCash: 423, riskBudget: 4, rewardRisk: 2, costs: {} }).ok).toBe(false);
  });
  test('costs shrink the position until the cost-inclusive loss fits', () => {
    const r = sizePosition({ entry: 20, stop: 19, settledCash: 423, riskBudget: 4, rewardRisk: 2, spread: 0.04, costs: { slippage_per_share: 0.02 } });
    expect(r.shares).toBe(3);
    expect(r.est_loss_with_costs).toBeLessThanOrEqual(4);
  });
  test('the daily loss limit caps the per-trade budget', () => {
    expect(riskBudget({ maxRiskPerTrade: 4, maxDailyLoss: 8, realizedLossToday: 5, openPlannedRisk: 0 })).toBe(3);
    expect(riskBudget({ maxRiskPerTrade: 4, maxDailyLoss: 8, realizedLossToday: 9, openPlannedRisk: 0 })).toBe(0);
  });
});

describe('cash', () => {
  const ledger = [
    { kind: 'opening', amount: 423, settles_on: '2026-10-21' },
    { kind: 'buy', amount: -200, settles_on: '2026-10-23' },
    { kind: 'sell', amount: 210, settles_on: '2026-10-23' },
  ];
  test('sale proceeds are not settled cash until T+1; debits count at once', () => {
    expect(cash.balances(ledger, '2026-10-22')).toEqual(expect.objectContaining({ settled: 223, unsettled: 210 }));
    expect(cash.balances(ledger, '2026-10-23').settled).toBe(433);
  });
  test('buying with unsettled proceeds is flagged as a good-faith risk', () => {
    const f = cash.fundPurchase(ledger, '2026-10-22', 300);
    expect(f.unsettled_used).toBe(77);
    expect(f.funds_settle_on).toBe('2026-10-23');
    expect(cash.goodFaithViolation({ unsettled_funds_used: 77, funds_settle_on: '2026-10-23' }, '2026-10-22')).toBe(true);
    expect(cash.goodFaithViolation({ unsettled_funds_used: 77, funds_settle_on: '2026-10-23' }, '2026-10-23')).toBe(false);
    expect(cash.fundPurchase(ledger, '2026-10-22', 1000).short_by).toBeGreaterThan(0);
  });
});

describe('analytics', () => {
  test('win rate, profit factor, drawdown and compliance', () => {
    const s = analytics.stats([
      { pl: 8, r: 2, followed_plan: true, exit_at: '2026-10-20T15:00:00Z' },
      { pl: -4, r: -1, followed_plan: true, exit_at: '2026-10-21T15:00:00Z' },
      { pl: -4, r: -1, followed_plan: false, exit_at: '2026-10-22T15:00:00Z' },
    ]);
    expect(s.win_rate).toBeCloseTo(0.333, 2);
    expect(s.profit_factor).toBe(1);
    expect(s.max_drawdown).toBe(8);
    expect(s.rule_compliance).toBeCloseTo(0.667, 2);
  });
});

describe('backtest', () => {
  test('fills on the next open, after the confirmation, and records the trade with costs', () => {
    const bars = breakoutDay();
    // The rest of the day drifts up to the target.
    for (let i = 26; i < 390; i++) bars.push({ t: OPEN + i * M, o: 101.65 + 0.01 * (i - 26), h: 101.75 + 0.01 * (i - 26), l: 101.55 + 0.01 * (i - 26), c: 101.7 + 0.01 * (i - 26), v: 8_000 });
    const out = backtest.run([{ date: DATE, session, symbols: { TEST: { bars, priorDays: priorDays(), prevDay: { h: 105, l: 98, c: 99.5 }, avgDailyDollarVolume: 500e6 } }, spyBars: null, qqqBars: null }], {
      account: { startingCash: 423, maxRiskPerTrade: 4, maxDailyLoss: 8, maxTradesPerDay: 2, rewardRisk: 2, allowFractional: false, costs: account.costs },
    });
    expect(out.metrics.confirmations).toBe(1);
    expect(out.trades).toHaveLength(1);
    const t = out.trades[0];
    expect(Date.parse(t.entry_at)).toBeGreaterThanOrEqual(OPEN + 26 * M);
    expect(t.exit_reason).toBe('target');
    expect(t.fees).toBeGreaterThan(0);
  });
  test('splits dates in order, never shuffling the future into training', () => {
    const s = backtest.splitDates(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    expect(s).toEqual({ development: ['a', 'b', 'c', 'd', 'e', 'f'], validation: ['g', 'h'], out_of_sample: ['i', 'j'] });
  });
});

describe('outcomes', () => {
  test('a candle touching both stop and target counts as the stop', () => {
    const o = measure([{ t: 0, h: 12, l: 9, c: 10 }], { entry: 10, stop: 9.5, target: 11, from: 0, flatAt: 1e9 });
    expect(o.outcome).toBe('stop_first');
  });
  test('target first', () => {
    const o = measure([{ t: 0, h: 10.4, l: 9.9, c: 10.2 }, { t: 1, h: 11.1, l: 10.2, c: 11 }], { entry: 10, stop: 9.5, target: 11, from: 0, flatAt: 1e9 });
    expect(o).toEqual(expect.objectContaining({ outcome: 'target_first', r: 2 }));
  });
});

describe('scanner', () => {
  const snap = (over = {}) => ({
    symbol: 'ABC', trade: { p: 21 }, prevDaily: { c: 20, v: 5e6 }, daily: { o: 20.6, v: 3e6, vw: 20.8 }, quote: { bid: 20.99, ask: 21.01 }, ...over,
  });
  test('scores a gapping, active, liquid name with reasons', () => {
    const r = scanner.scoreSnapshot(snap(), { spyChange: 0.002, minutesIn: 60, settledCash: 423, params: {}, hasCatalyst: true });
    expect(r.score).toBeGreaterThan(0);
    expect(r.reasons.join(' ')).toMatch(/gapped/);
  });
  test('skips penny stocks, wide spreads, unaffordable shares and decliners', () => {
    const base = { spyChange: 0, minutesIn: 60, settledCash: 423, params: {} };
    expect(scanner.scoreSnapshot(snap({ trade: { p: 3 }, prevDaily: { c: 2.8, v: 5e7 } }), base).skip).toMatch(/price/);
    expect(scanner.scoreSnapshot(snap({ quote: { bid: 20.5, ask: 21.5 } }), base).skip).toMatch(/spread/);
    expect(scanner.scoreSnapshot(snap({ trade: { p: 500 }, prevDaily: { c: 480, v: 5e6 } }), base).skip).toMatch(/settled cash/);
    expect(scanner.scoreSnapshot(snap({ trade: { p: 19 } }), base).skip).toMatch(/long-only/);
  });
});
