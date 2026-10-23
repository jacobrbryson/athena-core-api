const express = require('express');
const { requireAuthOrDevice } = require('../middleware/auth');
const { requireAdultActor } = require('../helpers/actor');
const engine = require('../services/trading/engine');
const store = require('../services/trading/store');
const strategy = require('../services/trading/strategy');
const clock = require('../services/trading/marketClock');

// Family → Trading (docs/capabilities/trading.md): the signed-in adult's own
// trading desk. Analysis, records and settings only — nothing here, or
// anywhere in services/trading, can place, change or cancel an order.
const router = express.Router();
router.use(requireAuthOrDevice);

const SYMBOL = /^[A-Z]{1,5}$/;

function handler(fn) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const actor = await requireAdultActor(req, res);
    if (!actor) return;
    try {
      const out = await fn(req, actor.profileId, res);
      if (!res.headersSent) res.json(out);
    } catch (err) {
      if (err?.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ message: 'Trading isn\'t set up yet (migration 0092_trading is pending).' });
      if (err?.code === 'rate_limited') return res.status(503).json({ message: 'The market-data provider asked us to slow down. Try again in a minute.' });
      if (err?.code === 'unauthorized') return res.status(503).json({ message: 'The market-data provider refused the API key.' });
      console.error('[trading] request failed', { path: req.path, code: err?.code || null, message: err?.message });
      res.status(500).json({ message: 'Trading data is unavailable right now.' });
    }
  };
}

function bad(res, message) {
  res.status(400).json({ message });
}

router.get('/dashboard', handler(async (req, profileId) => {
  const payload = await engine.evaluate(profileId, { force: req.query.fresh === '1' });
  return { ...payload, alerts: await store.alerts(profileId, { limit: 30 }) };
}));

router.get('/symbol/:symbol', handler(async (req, profileId, res) => {
  const symbol = String(req.params.symbol).toUpperCase();
  if (!SYMBOL.test(symbol)) return bad(res, 'Symbol must be 1–5 letters.');
  return engine.symbolDetail(profileId, symbol);
}));

router.post('/watchlist', handler(async (req, profileId, res) => {
  const symbol = String(req.body?.symbol || '').toUpperCase().trim();
  if (!SYMBOL.test(symbol)) return bad(res, 'Symbol must be 1–5 letters.');
  await store.ensureAccount(profileId);
  await store.addManualWatch(profileId, clock.etParts().date, symbol);
  engine._cache.delete(profileId);
  return { ok: true };
}));

router.delete('/watchlist/:symbol', handler(async (req, profileId) => {
  await store.removeWatch(profileId, clock.etParts().date, String(req.params.symbol).toUpperCase());
  engine._cache.delete(profileId);
  return { ok: true };
}));

router.put('/account', handler(async (req, profileId, res) => {
  const out = await store.updateAccount(profileId, req.body || {});
  if (out.error) return bad(res, out.error);
  engine._cache.delete(profileId);
  return out;
}));

router.post('/cash', handler(async (req, profileId, res) => {
  const out = await engine.recordCash(profileId, req.body || {});
  if (out.error) return bad(res, out.error);
  return out;
}));

router.get('/ledger', handler(async (req, profileId) => {
  const account = await store.ensureAccount(profileId);
  return { entries: await store.ledger(account.id) };
}));

router.post('/reconcile', handler(async (req, profileId, res) => {
  try {
    const out = await engine.reconcile(profileId, { apply: req.body?.apply === true });
    if (out.error) return bad(res, out.error);
    return out;
  } catch (err) {
    if (err?.code === 'not_connected') return bad(res, 'Webull isn\'t linked, so there is nothing to reconcile against.');
    throw err;
  }
}));

router.get('/positions', handler(async (req, profileId) => {
  const mode = req.query.mode === 'paper' ? 'paper' : 'live';
  const status = ['open', 'closed'].includes(req.query.status) ? req.query.status : undefined;
  return { positions: await store.positions(profileId, { mode, status, limit: 200 }) };
}));

router.post('/positions', handler(async (req, profileId, res) => {
  const out = await engine.recordEntry(profileId, req.body || {});
  if (out.error) return bad(res, out.error);
  return out;
}));

router.post('/positions/:uuid/close', handler(async (req, profileId, res) => {
  const out = await engine.recordExit(profileId, req.params.uuid, req.body || {});
  if (out.error) return bad(res, out.error);
  return out;
}));

router.patch('/positions/:uuid/journal', handler(async (req, profileId, res) => {
  const p = await store.position(profileId, req.params.uuid);
  if (!p) return bad(res, 'No such position.');
  await store.updateJournal(profileId, p.id, { followed_plan: req.body?.followed_plan, notes: req.body?.notes });
  return { position: await store.position(profileId, req.params.uuid) };
}));

router.get('/performance', handler(async (req, profileId) => {
  const mode = req.query.mode === 'paper' ? 'paper' : 'live';
  const period = ['day', 'week', 'month', 'all'].includes(req.query.period) ? req.query.period : 'week';
  return engine.performance(profileId, { mode, period });
}));

router.get('/signals', handler(async (req, profileId) => {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : clock.etParts().date;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : clock.addDays(to, -30);
  return { signals: await store.signalsBetween(profileId, from, to) };
}));

router.get('/signals/:uuid/replay', handler(async (req, profileId, res) => {
  const out = await engine.replay(profileId, req.params.uuid);
  if (!out) return res.status(404).json({ message: 'No such signal.' });
  return out;
}));

router.get('/alerts', handler(async (req, profileId) => ({ alerts: await store.alerts(profileId, { limit: 50 }) })));

router.post('/alerts/seen', handler(async (req, profileId) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 200);
  await store.markAlertsSeen(profileId, ids);
  return { ok: true };
}));

router.post('/alerts/:id/dismiss', handler(async (req, profileId) => {
  await store.dismissAlert(profileId, Number(req.params.id));
  return { ok: true };
}));

router.get('/strategy', handler(async () => ({
  key: strategy.STRATEGY_KEY,
  params: strategy.DEFAULT_PARAMS,
  versions: await store.strategyVersions(strategy.STRATEGY_KEY),
  backtests: await store.backtestRuns(20),
})));

module.exports = router;
