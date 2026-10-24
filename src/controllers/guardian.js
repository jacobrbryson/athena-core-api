const engine = require('../services/guardianEngine');
const dispatch = require('../services/guardianEngine/dispatch');
const eufyBridge = require('../services/eufyBridge');
const { actorFor } = require('./propertySecurity');

/**
 * Property → Security → Guardian (services/guardianEngine).
 *
 * Every route is the Security tab's own gate: a signed-in Companion adult on
 * the household allowlist (EUFY_AUTHORIZED_PROFILE_IDS). Paired devices,
 * children and other adults are refused before anything is read. The engine
 * never takes a profile, recipient or action from the body that it does not
 * check against that same allowlist.
 *
 * POST /internal/guardian/dispatch is not a person's route: it is called by
 * the athena-incidents job and by Cloud Tasks, with a Google-signed ID token
 * for an allowed service account (guardianEngine/dispatch.js).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROTOCOL = /^[a-z_]{3,40}$/;
const SCENARIO_STATES = new Set(['closed', 'open', 'partially_open', 'down', 'up', 'unknown', 'not_visible']);

const guarded = fn => async (req, res) => {
  const actor = await actorFor(req, res);
  if (!actor) return;
  try {
    return await fn(req, res, actor);
  } catch (error) {
    if (error.status && error.status < 500) return res.status(error.status).json({ message: error.message });
    console.warn('[guardian] request failed', { message: error?.message });
    return res.status(503).json({ message: 'Guardian is unavailable right now. The guardian migration must be installed.' });
  }
};

/** The page's view, with the bridge's roster read once for camera freshness. Captures nothing. */
async function current() {
  const status = eufyBridge.configured() ? await eufyBridge.status().catch(() => null) : null;
  return engine.overview({ devices: status?.devices || [], bridgeState: eufyBridge.configured() ? (status?.state || 'unavailable') : 'not_connected' });
}

const overview = guarded(async (req, res) => res.json(await current()));

const saveProtocol = guarded(async (req, res, actor) => {
  if (!PROTOCOL.test(req.params.id)) return res.status(400).json({ message: 'Unknown protocol.' });
  await engine.saveConfig(actor.profileId, req.params.id, { enabled: req.body?.enabled, config: req.body?.config || {} });
  return res.json(await current());
});

/** A scenario only ever replaces what a camera "sees" in a simulated run; it is never a real observation. */
function cleanScenario(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const check of ['garage_door', 'patio_umbrella']) {
    if (!raw[check] || typeof raw[check] !== 'object') continue;
    out[check] = {};
    for (const [key, state] of Object.entries(raw[check]).slice(0, 8)) {
      if (/^[a-z0-9_-]{1,40}$/.test(key) && SCENARIO_STATES.has(state)) out[check][key] = state;
    }
  }
  return out;
}

const runNow = guarded(async (req, res, actor) => {
  if (!PROTOCOL.test(req.params.id)) return res.status(400).json({ message: 'Unknown protocol.' });
  const scenario = cleanScenario(req.body?.scenario);
  const out = await engine.runNow(actor.profileId, req.params.id, { simulate: req.body?.simulate === true || !!scenario, scenario });
  return res.status(201).json(out);
});

const incidentAction = action => guarded(async (req, res, actor) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ message: 'Invalid incident id.' });
  if (action === 'recheck') return res.json(await engine.recheck(actor.profileId, req.params.id));
  if (action === 'acknowledge') await engine.acknowledge(actor.profileId, req.params.id);
  if (action === 'dismiss') await engine.dismiss(actor.profileId, req.params.id, req.body?.reason);
  if (action === 'assign') {
    const target = req.body?.profileId;
    if (target !== null && !/^\d{1,12}$/.test(String(target ?? ''))) return res.status(400).json({ message: 'Pick a household adult.' });
    await engine.assign(actor.profileId, req.params.id, target);
  }
  return res.status(204).end();
});

/** The job's or Cloud Tasks' call: observe what's due. Answers only to allowed service accounts. */
async function dispatchDue(req, res, { verify = dispatch.verifyCaller, run = engine.runDue } = {}) {
  res.set('Cache-Control', 'no-store');
  if (!(await verify(req))) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const out = await run({});
    return res.json({ ran: out.ran.length, due: out.planned.due, runs: out.ran });
  } catch (error) {
    console.error('[guardian] dispatch failed', { message: error?.message });
    // 503 makes Cloud Tasks retry; the planner reports anything still missed.
    return res.status(503).json({ message: 'Guardian dispatch failed' });
  }
}

module.exports = {
  overview, saveProtocol, runNow,
  recheck: incidentAction('recheck'), acknowledge: incidentAction('acknowledge'), dismiss: incidentAction('dismiss'), assign: incidentAction('assign'),
  dispatch: (req, res) => dispatchDue(req, res), dispatchWith: dispatchDue, cleanScenario,
};
