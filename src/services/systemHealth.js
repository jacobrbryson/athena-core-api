const pool = require('../helpers/db');
const llm = require('./llm');

// One plain answer to "is Athena all right?" for the System page, built from
// the few things that decide whether she can actually help someone: her
// database, a model to answer with, and the nightly job that keeps her memory
// and review current. Each check says why when it isn't ok, because the page
// links straight to that reason.
const DB_TIMEOUT_MS = 5000;
const FAILING_SHARE = 0.25;
// The nightly review writes one row per local day; two missed nights is a stall.
const NIGHTLY_STALE_DAYS = 2;

const RANK = { ok: 0, degraded: 1, down: 2 };

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function database() {
  try {
    await withTimeout(pool.query('SELECT 1'), DB_TIMEOUT_MS, 'timed out');
    return { id: 'database', label: 'Database', status: 'ok', detail: 'Reachable' };
  } catch (err) {
    return { id: 'database', label: 'Database', status: 'down', detail: `Not reachable (${err?.code || err?.message || 'error'})` };
  }
}

function models() {
  const status = llm.status();
  const chat = status.serving?.chat;
  if (!chat) return { id: 'models', label: 'Models', status: 'down', detail: 'No model is available to answer chat.' };
  const endpoint = [...(status.orcwood || []), ...(status.frontier || [])].find((e) => e.id === chat.endpointId);
  const calls = (status.recentCalls || []).filter((c) => c.task !== 'eval');
  const failed = calls.filter((c) => c.outcome !== 'ok').length;
  const where = `${chat.model} (${chat.tier})`;
  if (endpoint?.health?.calls > 0 && endpoint.health.errorRate > FAILING_SHARE) {
    return { id: 'models', label: 'Models', status: 'degraded', detail: `Chat is on ${where}, which is failing ${Math.round(endpoint.health.errorRate * 100)}% of calls.` };
  }
  if (calls.length >= 4 && failed / calls.length > FAILING_SHARE) {
    return { id: 'models', label: 'Models', status: 'degraded', detail: `${failed} of the last ${calls.length} model calls failed.` };
  }
  return { id: 'models', label: 'Models', status: 'ok', detail: `Chat is on ${where}` };
}

async function nightly(now) {
  try {
    const [rows] = await withTimeout(
      pool.query("SELECT DATE_FORMAT(MAX(report_date), '%Y-%m-%d') AS last FROM self_review_report"),
      DB_TIMEOUT_MS, 'timed out');
    const last = rows?.[0]?.last || null;
    if (!last) return { id: 'nightly', label: 'Nightly review', status: 'degraded', detail: 'Has never run.', lastRunOn: null };
    const days = Math.floor((now.getTime() - Date.parse(`${last}T12:00:00Z`)) / 86400000);
    if (days > NIGHTLY_STALE_DAYS) {
      return { id: 'nightly', label: 'Nightly review', status: 'degraded', detail: `Last ran ${days} days ago (${last}).`, lastRunOn: last };
    }
    return { id: 'nightly', label: 'Nightly review', status: 'ok', detail: `Last ran ${last}`, lastRunOn: last };
  } catch (err) {
    return { id: 'nightly', label: 'Nightly review', status: 'degraded', detail: `Couldn't read the last report (${err?.code || err?.message || 'error'}).`, lastRunOn: null };
  }
}

async function getHealth(now = new Date()) {
  const checks = await Promise.all([database(), Promise.resolve().then(models), nightly(now)]);
  const worst = checks.reduce((acc, c) => (RANK[c.status] > RANK[acc] ? c.status : acc), 'ok');
  return { status: worst, checkedAt: now.toISOString(), checks };
}

module.exports = { getHealth };
