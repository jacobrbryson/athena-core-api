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

// ---------------------------------------------------------------------------
// Breakage the three checks above could not see (2026-11-05). Each of these
// was live for weeks while the System page said "ok": an OpenAI key OpenAI had
// revoked (dreams and images, from 10-27), a job whose ATHENA_BACKGROUND_GOOGLE_ID
// was set but empty (95% of embeddings refused, from at least 10-15), and a
// job that could not load the keyring and so could not open any saved sign-in
// (Keep, Webull, Contacts). They read the shared logs, so a failure in any
// Cloud Run Job shows up here even though this runs in the API service.
// ---------------------------------------------------------------------------

/** A provider refusing the key itself, not a quota, outage or bad request. */
const AUTH_ERROR = /\bHTTP 40[13]\b|incorrect api key|invalid api key|api key not valid|api_key_invalid/i;
/** The access gate's refusal: the call never reached a provider. */
const REFUSED = 'Guardian access or owner approval required';
const REFUSED_MIN = 5;
const REFUSED_SHARE = 0.5;
const PROVIDER_NAMES = { openai: 'OpenAI', gemini: 'Gemini', orcwood: 'Orcwood', anthropic: 'Anthropic' };

const providerName = (id) => PROVIDER_NAMES[String(id).split(/[-_:]/)[0]] || String(id);
const listOf = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const day = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });

async function providerKeys() {
  const id = 'keys';
  const label = 'Provider keys';
  try {
    // Two days, because dreams call OpenAI once a night: a shorter window would
    // forget a dead key by the afternoon.
    const [rows] = await withTimeout(pool.query(
      `SELECT endpoint_id, task, outcome, error, created_at FROM llm_call_log
       WHERE created_at >= NOW() - INTERVAL 48 HOUR AND endpoint_id IS NOT NULL ORDER BY created_at, id`), DB_TIMEOUT_MS, 'timed out');
    const byEndpoint = new Map();
    for (const r of rows || []) {
      const e = byEndpoint.get(r.endpoint_id) || { lastOk: null, last: null, failures: [] };
      if (r.outcome === 'ok') { e.lastOk = r.created_at; e.failures = []; }
      else if (AUTH_ERROR.test(String(r.error || ''))) e.failures.push(r);
      e.last = r;
      byEndpoint.set(r.endpoint_id, e);
    }
    const broken = [];
    for (const [endpointId, e] of byEndpoint) {
      // Still broken only if the most recent call was itself refused for its key.
      if (!e.failures.length || e.last !== e.failures[e.failures.length - 1]) continue;
      const code = (String(e.failures[0].error).match(/HTTP (40[13])/) || [])[1];
      const tasks = [...new Set(e.failures.map((f) => f.task))];
      const since = e.lastOk ? `since ${day(e.failures[0].created_at)}` : 'on every call for two days';
      broken.push(`${providerName(endpointId)} is rejecting Athena's API key${code ? ` (HTTP ${code})` : ''} ${since}: ${listOf(tasks)} calls fail.`);
    }
    if (broken.length) return { id, label, status: 'down', detail: broken.join(' ') };
    return { id, label, status: 'ok', detail: 'Every provider accepts its key' };
  } catch (err) {
    return { id, label, status: 'ok', detail: `Couldn't read the call log (${err?.code || err?.message || 'error'})` };
  }
}

async function backgroundIdentity() {
  const id = 'identity';
  const label = 'Background identity';
  try {
    const [rows] = await withTimeout(pool.query(
      `SELECT task, COUNT(*) AS calls, SUM(error = ?) AS refused FROM llm_call_log
       WHERE created_at >= NOW() - INTERVAL 6 HOUR GROUP BY task`, [REFUSED]), DB_TIMEOUT_MS, 'timed out');
    const refused = (rows || [])
      .map((r) => ({ task: r.task, calls: Number(r.calls) || 0, refused: Number(r.refused) || 0 }))
      .filter((r) => r.refused >= REFUSED_MIN && r.refused / r.calls >= REFUSED_SHARE);
    if (refused.length) {
      const what = listOf(refused.map((r) => `${r.refused} of ${r.calls} ${r.task}`));
      return {
        id, label, status: 'down',
        detail: `${what} calls in the last 6 hours were refused before reaching a model. A job is running without an authorized identity — check ATHENA_BACKGROUND_GOOGLE_ID on the Cloud Run Jobs.`,
      };
    }
    return { id, label, status: 'ok', detail: 'Background work is authorized' };
  } catch (err) {
    return { id, label, status: 'ok', detail: `Couldn't read the call log (${err?.code || err?.message || 'error'})` };
  }
}

const CONNECTOR_NAMES = { google_keep: 'Google Keep', google_contacts: 'Google Contacts', google_calendar: 'Google Calendar', webull: 'Webull', whoop: 'WHOOP', vesync: 'VeSync', nest: 'Nest' };
const connectorName = (p) => CONNECTOR_NAMES[p] || String(p).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

async function savedSignIns() {
  const id = 'credentials';
  const label = 'Saved sign-ins';
  try {
    // A decrypt failure is broken until the same provider is read successfully again.
    const [rows] = await withTimeout(pool.query(
      `SELECT provider,
              MAX(CASE WHEN action = 'failed' AND detail LIKE 'decrypt failed%' THEN created_at END) AS failed_at,
              MAX(CASE WHEN action IN ('read', 'refreshed', 'linked') THEN created_at END) AS ok_at,
              SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN action = 'failed' AND detail LIKE 'decrypt failed%' THEN detail END ORDER BY created_at DESC SEPARATOR '\\n'), '\\n', 1) AS why
       FROM user_credential_audit WHERE created_at >= NOW() - INTERVAL 3 DAY
       GROUP BY provider HAVING failed_at IS NOT NULL`), DB_TIMEOUT_MS, 'timed out');
    const broken = (rows || []).filter((r) => !r.ok_at || new Date(r.failed_at) > new Date(r.ok_at));
    if (broken.length) {
      const why = String(broken[0].why || '').replace(/^decrypt failed:\s*/, '');
      return {
        id, label, status: 'down',
        detail: `Athena can't decrypt the saved ${listOf(broken.map((r) => connectorName(r.provider)))} sign-in${broken.length > 1 ? 's' : ''}${why ? ` (${why})` : ''}. The process that tried is not loading the encryption keyring — check GCP_PROJECT_ID on that job.`,
      };
    }
    return { id, label, status: 'ok', detail: 'Saved sign-ins open' };
  } catch (err) {
    return { id, label, status: 'ok', detail: `Couldn't read the credential audit (${err?.code || err?.message || 'error'})` };
  }
}

/** Steps that report a count of failures, not ok:false — a connector with one bad profile still "succeeds". */
async function nightlySteps() {
  const id = 'nightlySteps';
  const label = 'Nightly steps';
  try {
    const [rows] = await withTimeout(pool.query(
      `SELECT DATE_FORMAT(report_date, '%Y-%m-%d') AS d, metrics FROM self_review_report ORDER BY report_date DESC LIMIT 1`), DB_TIMEOUT_MS, 'timed out');
    const raw = rows?.[0]?.metrics;
    const metrics = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const steps = metrics?.maintenance;
    if (!steps || typeof steps !== 'object') return { id, label, status: 'ok', detail: 'No step results recorded yet' };
    const failing = Object.entries(steps)
      .filter(([, s]) => s && typeof s === 'object' && (s.ok === false || Number(s.failed) > 0))
      .map(([name, s]) => (s.ok === false ? `${name} (${String(s.error || 'failed').slice(0, 120)})` : `${name} (${s.failed} failed)`));
    if (failing.length) return { id, label, status: 'degraded', detail: `On ${rows[0].d}: ${failing.join('; ')}.` };
    return { id, label, status: 'ok', detail: `Every step ran clean on ${rows[0].d}` };
  } catch (err) {
    return { id, label, status: 'ok', detail: `Couldn't read the last report (${err?.code || err?.message || 'error'})` };
  }
}

async function getHealth(now = new Date()) {
  const checks = await Promise.all([
    database(), Promise.resolve().then(models), nightly(now),
    providerKeys(), backgroundIdentity(), savedSignIns(), nightlySteps(),
  ]);
  const worst = checks.reduce((acc, c) => (RANK[c.status] > RANK[acc] ? c.status : acc), 'ok');
  return { status: worst, checkedAt: now.toISOString(), checks };
}

// ---------------------------------------------------------------------------
// Telling the owner. A problem goes into the notification inbox — no push —
// once per check per day while it lasts, so acknowledging one means "I know"
// and it comes back tomorrow only if it is still broken. The inbox is a record,
// not a gate, and nothing here decides whether anyone is disturbed.
// ---------------------------------------------------------------------------

async function ownerGoogleIds() {
  const ids = new Set();
  try {
    const secrets = require('./secrets');
    const raw = (await secrets.getSecret('CODE_AGENT_GOOGLE_IDS').catch(() => null)) || '';
    for (const s of raw.split(/[\s,]+/)) if (s.trim()) ids.add(s.trim());
  } catch { /* fall through to the job identity */ }
  if (process.env.ATHENA_BACKGROUND_GOOGLE_ID) ids.add(process.env.ATHENA_BACKGROUND_GOOGLE_ID.trim());
  return ids;
}

/** Is this profile one of the owner's? Fails closed. */
async function isOwner(profileId) {
  if (!profileId) return false;
  try {
    const ids = await ownerGoogleIds();
    if (!ids.size) return false;
    const [rows] = await pool.query('SELECT google_id FROM profile WHERE id = ? LIMIT 1', [profileId]);
    return !!rows?.[0]?.google_id && ids.has(String(rows[0].google_id));
  } catch {
    return false;
  }
}

async function ownerProfileIds() {
  const ids = [...(await ownerGoogleIds())];
  if (!ids.length) return [];
  const [rows] = await pool.query(`SELECT id FROM profile WHERE google_id IN (${ids.map(() => '?').join(', ')})`, ids);
  return (rows || []).map((r) => Number(r.id)).filter(Boolean);
}

const TITLES = { down: 'Something is broken', degraded: 'Something needs a look' };

/**
 * Put every check that isn't ok into the owner's notifications. Idempotent per
 * (check, local day); skips one that is still waiting unacknowledged. Never throws.
 */
async function notifyOwner(health, { profileIds } = {}) {
  try {
    const inbox = require('./notifications/inbox');
    const problems = (health?.checks || []).filter((c) => c.status !== 'ok');
    if (!problems.length) return 0;
    const owners = profileIds || (await ownerProfileIds());
    const date = new Date(health.checkedAt || Date.now()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    let recorded = 0;
    for (const profileId of owners) {
      const [waiting] = await pool.query(
        `SELECT JSON_UNQUOTE(JSON_EXTRACT(data, '$.check')) AS c FROM athena_notification
         WHERE profile_id = ? AND kind = 'system_health' AND acknowledged_at IS NULL`, [profileId]);
      const open = new Set((waiting || []).map((r) => r.c));
      for (const c of problems) {
        if (open.has(c.id)) continue;
        const out = await inbox.record(profileId, {
          title: `${TITLES[c.status] || TITLES.degraded}: ${c.label}`,
          body: c.detail,
          data: { kind: 'system_health', check: c.id, status: c.status, uuid: `health:${c.id}:${date}`, url: '/system' },
        });
        if (out?.created) recorded += 1;
      }
    }
    return recorded;
  } catch (err) {
    console.warn('[systemHealth] could not notify the owner:', err?.message || err);
    return 0;
  }
}

module.exports = { getHealth, isOwner, notifyOwner, AUTH_ERROR };
