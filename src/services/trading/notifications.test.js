jest.mock('../../helpers/db', () => ({ query: jest.fn(), getConnection: jest.fn() }));
jest.mock('../secrets', () => ({ getSecret: jest.fn().mockResolvedValue(null) }));
jest.mock('./store');
jest.mock('./engine', () => ({ evaluate: jest.fn() }));
jest.mock('../push', () => ({ sendToProfile: jest.fn(), statusFor: jest.fn() }));
jest.mock('../initiative', () => ({ listMutes: jest.fn().mockResolvedValue([]), getPref: jest.fn().mockResolvedValue({ quiet_from: 22, quiet_to: 7 }), inQuietHours: jest.fn().mockReturnValue(false) }));

const pool = require('../../helpers/db');
const store = require('./store');
const engine = require('./engine');
const push = require('../push');
const initiative = require('../initiative');
const clock = require('./marketClock');
const lifecycle = require('./lifecycle');
const notifications = require('./notifications');
const { ENTRY_CONDITIONS } = require('./strategy');

const DATE = '2026-10-22'; // a Thursday
const OPEN = Date.parse(clock.sessionFor(DATE).open_at);
const M = 60_000;
const CONFIRMED_AT = OPEN + 40 * M; // 10:10 ET
const NOW = CONFIRMED_AT + 30_000;
const SIGNAL_UUID = '11111111-2222-4333-8444-555555555555';

const pass = (ids = ENTRY_CONDITIONS) => ids.map(id => ({ id, state: 'pass' }));
const sizing = { ok: true, entry: 86.6, stop: 86.15, target: 87.5, shares: 4, position_cost: 346.4, planned_loss: 1.8, est_loss_with_costs: 1.96, reward_risk: 2 };
const freshData = (o = {}) => ({ feed: 'sip', feed_can_confirm: true, stale: false, problems: [], bar_age_s: 20, quote_age_s: 2, blackout: null, ...o });

function signal(o = {}) {
  return {
    id: 9, uuid: SIGNAL_UUID, symbol: 'INTC', session_date: DATE, feed: 'sip', version_status: 'validated', strategy_version: 3, status: 'ENTRY_CONFIRMED',
    confirmed_at: new Date(CONFIRMED_AT).toISOString(), expires_at: new Date(CONFIRMED_AT + 10 * M).toISOString(), ...o,
  };
}
function confirmEvent(o = {}) {
  return { seq: 2, evaluated_at: new Date(CONFIRMED_AT).toISOString(), from_status: 'SETUP_FORMING', to_status: 'ENTRY_CONFIRMED', reason: 'All entry conditions passed on closed candles.', conditions: pass(), indicators: { data: freshData() }, sizing, ...o };
}
function evaluation(o = {}) {
  return { status: 'ENTRY_CONFIRMED', reason: 'Still within the confirmed plan.', evaluated_at: new Date(NOW - 5000).toISOString(), data: freshData(), indicators: { price: 86.7 }, conditions: pass(), sizing, ...o };
}
function dashboard(o = {}) {
  const { account = {}, ...rest } = o;
  return {
    market: { phase: 'open', et_date: DATE }, data: { can_confirm: true, feed: 'sip' }, strategy: { key: 'orb_vwap', status: 'validated' }, events: { today: [] },
    account: {
      settings: { max_trades_per_day: 2, min_reward_risk: 2, allow_fractional: false, ...account.settings },
      cash: { usable_settled: 423, broker_settled_today: 423, ...account.cash },
      today: { trades: 0, risk_budget: 4, ...account.today },
    },
    watchlist: [{ symbol: 'INTC', signal: evaluation(o.evaluation) }],
    ...rest,
  };
}
const livePrefs = { ...notifications.DEFAULT_PREFS, enabled: true, live_strategies: ['orb_vwap'] };

// ---------------------------------------------------------------------------
// A small in-memory stand-in for the three notification tables.
// ---------------------------------------------------------------------------
let db;
function fakeDb({ prefs = livePrefs, alerts = [] } = {}) {
  db = { prefs, rows: [], deliveries: [], alerts, nextId: 1 };
  pool.query.mockImplementation(async (sql, args = []) => {
    const s = sql.replace(/\s+/g, ' ');
    if (s.startsWith('SELECT * FROM trading_notification_prefs')) {
      if (!db.prefs) return [[]];
      const p = db.prefs;
      return [[{ ...p, ...Object.fromEntries(['enabled', 'setup_forming', 'entry_confirmed', 'invalidation', 'paper', 'risk_limit'].map(k => [k, p[k] ? 1 : 0])), live_strategies: JSON.stringify(p.live_strategies) }]];
    }
    if (s.startsWith('SELECT signal_id, event, state FROM trading_notifications')) return [db.rows.filter(r => args[1].includes(r.signal_id))];
    if (s.startsWith('INSERT IGNORE INTO trading_notifications')) {
      const [uuid, profile_id, signal_id, source_seq, source_alert_id, event, mode, priority, dedupe_key, symbol, payload_json, deep_link, state, state_reason, expires_at] = args;
      if (db.rows.some(r => r.profile_id === profile_id && r.dedupe_key === dedupe_key)) return [{ affectedRows: 0 }];
      db.rows.push({ id: db.nextId++, uuid, profile_id, signal_id, source_seq, source_alert_id, event, mode, priority, dedupe_key, symbol, payload_json, deep_link, state, state_reason, expires_at, attempts: 0, not_before: null, created_at: new Date(NOW), sent_at: null });
      return [{ affectedRows: 1 }];
    }
    if (s.includes('FROM trading_alerts')) return [db.alerts];
    if (s.includes("SET state = 'pending', claim_id = NULL WHERE profile_id = ? AND state = 'sending'")) return [{ affectedRows: 0 }];
    if (s.startsWith('SELECT * FROM trading_notifications WHERE profile_id = ? AND state IN')) {
      const at = args[1].getTime();
      return [db.rows.filter(r => ['pending', 'held'].includes(r.state) && (!r.not_before || r.not_before.getTime() <= at))];
    }
    if (s.includes("SET state = 'sending'")) {
      const r = db.rows.find(x => x.id === args[2] && ['pending', 'held'].includes(x.state));
      if (!r) return [{ affectedRows: 0 }];
      Object.assign(r, { state: 'sending', claim_id: args[0], attempts: r.attempts + 1 });
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith('UPDATE trading_notifications SET state = ?')) {
      const cols = /SET (.*) WHERE id = \? AND claim_id = \?/.exec(s)[1].split(', ').map(x => x.split(' = '));
      const id = args[args.length - 2];
      const r = db.rows.find(x => x.id === id && x.claim_id === args[args.length - 1]);
      if (!r) return [{ affectedRows: 0 }];
      let i = 0;
      for (const [col, v] of cols) r[col] = v === '?' ? args[i++] : null;
      return [{ affectedRows: 1 }];
    }
    if (s.includes('MAX(sent_at)')) {
      const sent = db.rows.filter(r => r.priority === 'low' && r.state === 'sent' && r.id !== args[1]).map(r => r.sent_at.getTime());
      return [[{ at: sent.length ? new Date(Math.max(...sent)) : null }]];
    }
    if (s.startsWith('INSERT INTO trading_notification_deliveries')) {
      db.deliveries.push(args);
      return [{ affectedRows: 1 }];
    }
    throw new Error(`unexpected query: ${s.slice(0, 90)}`);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  fakeDb();
  store.signalsWithEventsForDay.mockResolvedValue([{ ...signal(), events: [{ seq: 1, evaluated_at: new Date(CONFIRMED_AT - 5 * M).toISOString(), from_status: null, to_status: 'SETUP_FORMING', reason: 'Broke $86.40 at 10:05 AM.', conditions: [], indicators: { data: freshData() }, sizing: null }, confirmEvent()] }]);
  store.signalByUuid.mockResolvedValue(signal());
  store.expireDue.mockResolvedValue([]);
  engine.evaluate.mockResolvedValue(dashboard());
  push.sendToProfile.mockResolvedValue({ sent: 1, failed: 0, devices: 1, results: [{ uuid: 'd1', name: 'Pixel', platform: 'android', ok: true }] });
  initiative.inQuietHours.mockReturnValue(false);
});
afterEach(() => jest.useRealTimers());

// ---------------------------------------------------------------------------
// Lifecycle (pure)
// ---------------------------------------------------------------------------
describe('lifecycle', () => {
  test('a confirmed entry is actionable for its window, never past the entry cutoff', () => {
    expect(lifecycle.expiryFor({ sessionDate: DATE, status: 'ENTRY_CONFIRMED', confirmedAt: new Date(CONFIRMED_AT).toISOString() }).getTime()).toBe(CONFIRMED_AT + 10 * M);
    const late = clock.etToUtc(DATE, 14 * 60 + 55).toISOString();
    expect(lifecycle.expiryFor({ sessionDate: DATE, status: 'ENTRY_CONFIRMED', confirmedAt: late }).getTime()).toBe(clock.etToUtc(DATE, 15 * 60).getTime());
    expect(lifecycle.expiryFor({ sessionDate: DATE, status: 'SETUP_FORMING' }).getTime()).toBe(clock.etToUtc(DATE, 15 * 60).getTime());
  });

  test('expired opportunities: terminal signals never expire again; due ones do', () => {
    expect(lifecycle.isExpired(signal(), CONFIRMED_AT + 10 * M)).toBe(true);
    expect(lifecycle.isExpired(signal(), CONFIRMED_AT + 9 * M)).toBe(false);
    expect(lifecycle.isExpired(signal({ status: 'EXPIRED' }), CONFIRMED_AT + 60 * M)).toBe(false);
    expect(lifecycle.isExpired(signal({ status: 'EXIT_INVALIDATED' }), CONFIRMED_AT + 60 * M)).toBe(false);
    expect(lifecycle.expiredResult(signal(), NOW).status).toBe('EXPIRED');
  });

  test('strategy.evaluate keeps an EXPIRED setup expired (it can never re-confirm the same day)', () => {
    const strategy = require('./strategy');
    const r = strategy.evaluate({ symbol: 'INTC', asOf: NOW, session: clock.sessionFor(DATE), bars: [], feed: 'sip', account: { settledCash: 423, riskBudget: 4, rewardRisk: 2, costs: {}, tradesToday: 0, maxTradesPerDay: 2 }, previous: { status: 'EXPIRED', reason: 'Window closed.', confirmed: { entry: 86.6, stop: 86.15, target: 87.5, at: new Date(CONFIRMED_AT).toISOString() } } });
    expect(r.status).toBe('EXPIRED');
  });

  test('IEX: every condition but the feed is a paper setup, and only that', () => {
    const iex = { status: 'WAIT', sizing, conditions: [...pass(ENTRY_CONDITIONS.filter(id => id !== 'event_data')), { id: 'event_data', state: 'fail' }], data: freshData({ feed: 'iex', feed_can_confirm: false }) };
    expect(lifecycle.isPaperSetup(iex)).toBe(true);
    expect(lifecycle.stateKey(iex)).toBe('WAIT_PAPER_SETUP');
    expect(lifecycle.isPaperSetup({ ...iex, data: freshData({ feed: 'iex', feed_can_confirm: false, stale: true }) })).toBe(false); // stale quotes
    expect(lifecycle.isPaperSetup({ ...iex, data: freshData({ feed: 'iex', feed_can_confirm: false, blackout: 'FOMC' }) })).toBe(false);
    expect(lifecycle.isPaperSetup({ ...iex, conditions: iex.conditions.map(c => (c.id === 'volume' ? { ...c, state: 'fail' } : c)) })).toBe(false);
  });

  test('live needs SIP, a validated version AND the person switching it on', () => {
    expect(lifecycle.liveEligibility({ feedCanConfirm: true, versionStatus: 'validated', prefs: livePrefs }).live).toBe(true);
    expect(lifecycle.liveEligibility({ feedCanConfirm: false, versionStatus: 'validated', prefs: livePrefs }).why).toEqual(["the market-data feed isn't full-market (SIP)"]);
    expect(lifecycle.liveEligibility({ feedCanConfirm: true, versionStatus: 'paper', prefs: livePrefs }).live).toBe(false); // strategy changed → new unvalidated version
    expect(lifecycle.liveEligibility({ feedCanConfirm: true, versionStatus: 'validated', prefs: { live_strategies: [] } }).live).toBe(false);
  });

  test('confirmed notification text comes from the stored plan', () => {
    const [c] = lifecycle.candidatesFromEvent(confirmEvent(), signal());
    expect(c).toMatchObject({ event: 'ENTRY_CONFIRMED', dedupe_key: 'confirm:9', priority: 'high' });
    const { title, body } = lifecycle.render({ event: 'ENTRY_CONFIRMED', mode: 'live', payload: c.payload });
    expect(title).toBe('ATHENA: INTC setup confirmed');
    expect(body).toContain('Entry $86.60, stop $86.15, target $87.50.');
    expect(body).toContain('Four shares (~$346.40), $1.80 planned risk, 2:1.');
    expect(body).toContain('Review before entering.');
    const paper = lifecycle.render({ event: 'ENTRY_CONFIRMED', mode: 'paper', payload: c.payload }, { paperBecause: ['the strategy isn\'t validated yet'], ledgerOnly: true });
    expect(paper.title).toBe('ATHENA PAPER / EXPERIMENTAL: INTC setup lined up');
    expect(paper.body).toContain("Sized from Athena's ledger");
    expect(paper.body).toContain('Not a live trade alert');
  });

  test('invalidation and expiry only retract something that reached a device', () => {
    const e = { seq: 3, evaluated_at: new Date(NOW).toISOString(), from_status: 'ENTRY_CONFIRMED', to_status: 'EXIT_INVALIDATED', reason: 'Closed below VWAP.', conditions: [], indicators: {} };
    expect(lifecycle.candidatesFromEvent(e, signal(), new Map())).toEqual([]);
    expect(lifecycle.candidatesFromEvent(e, signal(), new Map([['ENTRY_CONFIRMED', 'sent']]))[0]).toMatchObject({ event: 'SETUP_INVALIDATED', priority: 'high' });
    expect(lifecycle.candidatesFromEvent(e, signal(), new Map([['ENTRY_CONFIRMED', 'lapsed']]))[0].skip).toMatch(/Nothing about this setup/);
    const x = { ...e, from_status: 'ENTRY_CONFIRMED', to_status: 'EXPIRED' };
    expect(lifecycle.candidatesFromEvent(x, signal(), new Map([['ENTRY_CONFIRMED', 'sent']]))[0]).toMatchObject({ event: 'SETUP_EXPIRED' });
    expect(lifecycle.candidatesFromEvent(x, signal(), new Map([['ENTRY_CONFIRMED', 'sent'], ['SETUP_INVALIDATED', 'sent']]))).toEqual([]);
  });

  describe('revalidate', () => {
    const n = () => ({ payload: lifecycle.candidatesFromEvent(confirmEvent(), signal())[0].payload });
    const run = (o = {}, now = NOW) => lifecycle.revalidate({ notification: n(), signal: signal(o.signal), evaluation: o.evaluation === undefined ? evaluation() : o.evaluation, dashboard: dashboard(o.dashboard), prefs: o.prefs || livePrefs, now });
    const failing = (r) => r.checks.filter(c => !c.ok).map(c => c.id);

    test('a fresh, intact setup is actionable and live', () => {
      const r = run();
      expect(failing(r)).toEqual([]);
      expect(r).toMatchObject({ actionable: true, mode: 'live', ledger_only: false });
    });
    test('stale quotes', () => expect(failing(run({ evaluation: evaluation({ data: freshData({ stale: true, problems: ['quote is 45s old'] }) }) }))).toContain('fresh_data'));
    test('market-data outage: no current evaluation', () => expect(run({ evaluation: null }).actionable).toBe(false));
    test('market halt: candles stop arriving, the last evaluation ages out', () => {
      expect(failing(run({ evaluation: evaluation({ evaluated_at: new Date(NOW - 5 * M).toISOString() }) }))).toContain('fresh_data');
    });
    test('expired opportunity', () => expect(failing(run({}, CONFIRMED_AT + 11 * M))).toContain('not_expired'));
    test('price ran past the entry range', () => expect(failing(run({ evaluation: evaluation({ indicators: { price: 86.9 } }) }))).toContain('entry_range'));
    test('the strategy moved on', () => expect(failing(run({ evaluation: evaluation({ status: 'EXIT_INVALIDATED', reason: 'Reached the stop.' }) }))).toContain('conditions'));
    test('insufficient settled cash', () => expect(failing(run({ dashboard: { account: { cash: { usable_settled: 200, broker_settled_today: 200 } } } }))).toEqual(['settled_cash']));
    test('daily risk budget used up', () => expect(failing(run({ dashboard: { account: { today: { risk_budget: 1 } } } }))).toEqual(['daily_risk']));
    test('daily trade limit', () => expect(failing(run({ dashboard: { account: { today: { trades: 2, risk_budget: 4 } } } }))).toEqual(['trade_count']));
    test('an event blackout', () => expect(failing(run({ dashboard: { events: { today: [{ name: 'FOMC', at: new Date(NOW + 10 * M).toISOString() }] } } }))).toEqual(['no_blackout']));
    test('the market closed', () => expect(failing(run({ dashboard: { market: { phase: 'afterhours' } } }))).toContain('market_open'));
    test('an unvalidated strategy is still checked, but only ever paper', () => {
      const r = run({ dashboard: { strategy: { status: 'paper' } } });
      expect(r).toMatchObject({ actionable: true, mode: 'paper' });
      expect(r.paper_because).toContain("the strategy isn't validated yet");
    });
    test('the IEX feed is only ever paper', () => {
      const r = run({ dashboard: { data: { can_confirm: false, feed: 'iex' } } });
      expect(r.mode).toBe('paper');
    });
    test('ledger-only sizing is flagged', () => expect(run({ dashboard: { account: { cash: { usable_settled: 423, broker_settled_today: null } } } }).ledger_only).toBe(true));
  });
});

// ---------------------------------------------------------------------------
// Outbox: derive, dedupe, deliver
// ---------------------------------------------------------------------------
describe('outbox', () => {
  test('nothing is derived without the opt-in', async () => {
    fakeDb({ prefs: null });
    expect(await notifications.sync(1, { date: DATE })).toEqual({ created: 0 });
    expect(db.rows).toHaveLength(0);
  });

  test('duplicate signals: deriving twice (a restart, a racing poll) makes one row', async () => {
    await notifications.sync(1, { date: DATE });
    await notifications.sync(1, { date: DATE });
    expect(db.rows.map(r => r.dedupe_key)).toEqual(['confirm:9']); // forming isn't the latest event, so not replayed
  });

  test('a validated, enabled, SIP confirmation is sent live with the stored figures and a deep link', async () => {
    const out = await notifications.process(1, { now: NOW });
    expect(out).toMatchObject({ created: 1, sent: 1 });
    const call = push.sendToProfile.mock.calls[0][1];
    expect(call.title).toBe('ATHENA: INTC setup confirmed');
    expect(call.collapseKey).toBe(`trading-${db.rows[0].uuid}`);
    expect(call.data.url).toBe(`/family/trading?n=${db.rows[0].uuid}&setup=${SIGNAL_UUID}`);
    expect(call.ttlSeconds).toBe((CONFIRMED_AT + 10 * M - NOW) / 1000);
    expect(db.rows[0]).toMatchObject({ state: 'sent', mode: 'live' });
    expect(db.deliveries).toHaveLength(1);
    // A second pass sends nothing more.
    await notifications.process(1, { now: NOW + 15_000 });
    expect(push.sendToProfile).toHaveBeenCalledTimes(1);
  });

  test('IEX never produces a live confirmation', async () => {
    store.signalsWithEventsForDay.mockResolvedValue([{ ...signal({ feed: 'iex', status: 'WAIT' }), events: [confirmEvent({ to_status: 'WAIT', conditions: [...pass(ENTRY_CONDITIONS.filter(id => id !== 'event_data')), { id: 'event_data', state: 'fail' }], indicators: { data: freshData({ feed: 'iex', feed_can_confirm: false }) } })] }]);
    engine.evaluate.mockResolvedValue(dashboard({ data: { can_confirm: false, feed: 'iex' }, evaluation: { status: 'WAIT', data: freshData({ feed: 'iex', feed_can_confirm: false }), conditions: [...pass(ENTRY_CONDITIONS.filter(id => id !== 'event_data')), { id: 'event_data', state: 'fail' }] } }));
    await notifications.process(1, { now: NOW });
    expect(db.rows[0]).toMatchObject({ mode: 'paper', priority: 'low', state: 'sent' });
    expect(push.sendToProfile.mock.calls[0][1].title).toMatch(/^ATHENA PAPER \/ EXPERIMENTAL/);
  });

  test('a stale setup is never sent: it lapses with the reason', async () => {
    engine.evaluate.mockResolvedValue(dashboard({ evaluation: { data: freshData({ stale: true, problems: ['quote is 45s old'] }) } }));
    await notifications.process(1, { now: NOW });
    expect(push.sendToProfile).not.toHaveBeenCalled();
    expect(db.rows[0].state).toBe('lapsed');
    expect(db.rows[0].state_reason).toMatch(/quote is 45s old/);
  });

  test('quiet hours hold rather than drop', async () => {
    initiative.inQuietHours.mockReturnValue(true);
    await notifications.process(1, { now: NOW });
    expect(push.sendToProfile).not.toHaveBeenCalled();
    expect(db.rows[0].state).toBe('held');
    expect(db.rows[0].not_before.getTime()).toBe(NOW + 15 * M);
  });

  test('browser permission denied / push off: recorded as failed, not retried', async () => {
    push.sendToProfile.mockResolvedValue({ sent: 0, failed: 0, devices: 0, skipped: 'not enabled' });
    await notifications.process(1, { now: NOW });
    expect(db.rows[0]).toMatchObject({ state: 'failed' });
    expect(db.rows[0].state_reason).toMatch(/Push notifications are off/);
  });

  test('disconnected devices: a soft failure retries with backoff, then fails', async () => {
    push.sendToProfile.mockResolvedValue({ sent: 0, failed: 1, devices: 1, results: [{ uuid: 'd1', name: 'Pixel', ok: false, reason: 'UNAVAILABLE' }] });
    await notifications.process(1, { now: NOW });
    expect(db.rows[0]).toMatchObject({ state: 'pending', state_reason: 'Pixel: UNAVAILABLE' });
    expect(db.rows[0].not_before.getTime()).toBe(NOW + 30_000);
    await notifications.process(1, { now: NOW + 30_000 });
    expect(db.rows[0].not_before.getTime()).toBe(NOW + 30_000 + 60_000);
    // Each retry re-validates against a current evaluation (an old one would lapse it).
    engine.evaluate.mockResolvedValue(dashboard({ evaluation: { evaluated_at: new Date(NOW + 85_000).toISOString() } }));
    await notifications.process(1, { now: NOW + 90_000 });
    expect(db.rows[0].state).toBe('failed');
    expect(db.deliveries).toHaveLength(3);
  });

  test('the cooldown holds low-priority alerts and never touches an invalidation', async () => {
    fakeDb({ prefs: { ...livePrefs, cooldown_min: 30, live_strategies: [] } }); // paper → low priority
    db.rows.push({ id: 99, uuid: 'x', profile_id: 1, signal_id: 8, event: 'SETUP_FORMING', priority: 'low', state: 'sent', sent_at: new Date(NOW - 5 * M), dedupe_key: 'forming:8', payload_json: '{}' });
    await notifications.process(1, { now: NOW });
    const confirm = db.rows.find(r => r.dedupe_key === 'confirm:9');
    expect(confirm.state).toBe('held');
    expect(confirm.not_before.getTime()).toBe(NOW + 25 * M);

    db.rows.push({ id: 100, uuid: 'y', profile_id: 1, signal_id: 8, event: 'SETUP_INVALIDATED', mode: 'paper', priority: 'high', state: 'pending', dedupe_key: 'invalid:8', payload_json: JSON.stringify({ symbol: 'AMD', reason: 'Closed below VWAP.' }), attempts: 0, created_at: new Date(NOW) });
    await notifications.deliver(1, { now: NOW + 1000 });
    expect(db.rows.find(r => r.id === 100).state).toBe('sent');
  });

  test('a mute is honoured', async () => {
    initiative.listMutes.mockResolvedValueOnce(['trading']);
    await notifications.process(1, { now: NOW });
    expect(db.rows[0]).toMatchObject({ state: 'skipped', state_reason: 'You muted trading notifications.' });
  });

  test('risk limits notify once per day', async () => {
    fakeDb({ alerts: [{ id: 5, dedupe_key: `risk:${DATE}:full`, title: 'Daily loss limit reached', body: 'Realized -$8.00 today against a $8.00 limit.', created_at: new Date(NOW) }, { id: 6, dedupe_key: `risk:${DATE}:half`, title: 'Half', body: 'x', created_at: new Date(NOW) }] });
    store.signalsWithEventsForDay.mockResolvedValue([]);
    await notifications.process(1, { now: NOW });
    await notifications.process(1, { now: NOW + 60_000 });
    expect(db.rows.map(r => r.event)).toEqual(['RISK_LIMIT_REACHED']);
    expect(push.sendToProfile.mock.calls[0][1].title).toBe('ATHENA: Daily loss limit reached');
  });

  test('outside trading hours a setup lapses instead of being sent', async () => {
    const evening = clock.etToUtc(DATE, 18 * 60).getTime();
    db.rows.push({ id: 50, uuid: 'z', profile_id: 1, signal_id: 9, event: 'SETUP_FORMING', mode: 'paper', priority: 'low', state: 'pending', dedupe_key: 'forming:9', payload_json: JSON.stringify({ symbol: 'INTC', signal_uuid: SIGNAL_UUID }), attempts: 0, created_at: new Date(NOW) });
    await notifications.deliver(1, { now: evening });
    expect(db.rows[0]).toMatchObject({ state: 'lapsed' });
    expect(push.sendToProfile).not.toHaveBeenCalled();
  });

  test('live alerts cannot be switched on for an unvalidated strategy', async () => {
    expect(await notifications.setPrefs(1, { live_strategy: true }, { versionStatus: 'paper' })).toEqual({ error: expect.stringMatching(/validated/) });
    expect(await notifications.setPrefs(1, { cooldown_min: 999 })).toEqual({ error: expect.any(String) });
  });
});
