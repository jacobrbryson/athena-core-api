const config = require('../config');

// GCP has no "what have I spent" API. Cloud Billing exports line items to
// BigQuery (enabled once in the console: Billing → Billing export → Standard
// usage cost → project athena-476423, dataset billing_export), and this reads
// that table with the runtime service account. The export lands a few hours
// behind and has no history from before it was switched on.
const BQ_URL = 'https://bigquery.googleapis.com/bigquery/v2/projects';
const TABLE_PREFIX = 'gcp_billing_export_v1_';
const TIMEOUT_MS = 20000;
const TOP_SKUS = 10;

let authClient = null;
async function token() {
  if (!authClient) {
    const { GoogleAuth } = require('google-auth-library');
    authClient = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/bigquery.readonly'] });
  }
  const client = await authClient.getClient();
  const { token: value } = await client.getAccessToken();
  return value;
}

async function bq(method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BQ_URL}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(json?.error?.message || `BigQuery returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function settings() {
  const project = config.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';
  return {
    project,
    // Where the export table lives; defaults to this project.
    exportProject: process.env.GCP_BILLING_EXPORT_PROJECT || project,
    dataset: process.env.GCP_BILLING_EXPORT_DATASET || 'billing_export',
  };
}

/** The export table is named after the billing account, so find it rather than configure it. */
async function findTable({ exportProject, dataset }) {
  const body = await bq('GET', `${exportProject}/datasets/${dataset}/tables?maxResults=100`);
  const table = (body?.tables || []).map((t) => t.tableReference?.tableId).find((id) => id?.startsWith(TABLE_PREFIX));
  return table || null;
}

async function query(project, sql, params) {
  const body = await bq('POST', `${project}/queries`, {
    query: sql,
    useLegacySql: false,
    timeoutMs: TIMEOUT_MS - 2000,
    parameterMode: 'NAMED',
    queryParameters: Object.entries(params).map(([name, value]) => ({
      name, parameterType: { type: 'STRING' }, parameterValue: { value },
    })),
  });
  if (!body?.jobComplete) throw new Error('BigQuery did not finish in time');
  const fields = (body.schema?.fields || []).map((f) => f.name);
  return (body.rows || []).map((row) => Object.fromEntries(row.f.map((cell, i) => [fields[i], cell.v])));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Billing's invoice month is Pacific time, so "this month" follows it. */
function invoiceMonth(now) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' }).formatToParts(now);
  return `${parts.find((p) => p.type === 'year').value}${parts.find((p) => p.type === 'month').value}`;
}

async function getBilling(now = new Date()) {
  const cfg = settings();
  const base = { checkedAt: now.toISOString(), project: cfg.project || null, dataset: `${cfg.exportProject}.${cfg.dataset}` };
  if (!cfg.project) return { configured: false, reason: 'no_project', ...base };

  let table;
  try {
    table = await findTable(cfg);
  } catch (err) {
    if (err.status === 404) return { configured: false, reason: 'no_dataset', ...base };
    throw err;
  }
  if (!table) return { configured: false, reason: 'no_export', ...base };

  const from = `\`${cfg.exportProject}.${cfg.dataset}.${table}\``;
  const params = { month: invoiceMonth(now), project: cfg.project };
  const where = 'WHERE invoice.month = @month AND project.id = @project';
  const credits = 'IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)';
  const [services, skus, days, meta] = await Promise.all([
    query(cfg.exportProject, `SELECT service.description AS name, SUM(cost) AS cost, SUM(${credits}) AS credits
      FROM ${from} ${where} GROUP BY name ORDER BY cost DESC`, params),
    query(cfg.exportProject, `SELECT service.description AS service, sku.description AS name, SUM(cost) AS cost, SUM(${credits}) AS credits
      FROM ${from} ${where} GROUP BY service, name ORDER BY cost DESC LIMIT ${TOP_SKUS}`, params),
    query(cfg.exportProject, `SELECT FORMAT_DATE('%F', DATE(usage_start_time, 'America/Los_Angeles')) AS date, SUM(cost) + SUM(${credits}) AS cost
      FROM ${from} ${where} GROUP BY date ORDER BY date`, params),
    query(cfg.exportProject, `SELECT ANY_VALUE(currency) AS currency, MAX(export_time) AS last_export
      FROM ${from} ${where}`, params),
  ]);

  const gross = services.reduce((sum, s) => sum + Number(s.cost || 0), 0);
  const creditTotal = services.reduce((sum, s) => sum + Number(s.credits || 0), 0);
  const lastExport = Number(meta[0]?.last_export);
  return {
    configured: true,
    ...base,
    invoiceMonth: params.month,
    currency: meta[0]?.currency || 'USD',
    lastExportAt: Number.isFinite(lastExport) && lastExport > 0 ? new Date(lastExport * 1000).toISOString() : null,
    costThisMonth: num(gross + creditTotal),
    grossThisMonth: num(gross),
    creditsThisMonth: num(creditTotal),
    services: services.map((s) => ({ name: s.name, cost: num(Number(s.cost) + Number(s.credits)), gross: num(s.cost) })),
    topSkus: skus.map((s) => ({ service: s.service, name: s.name, cost: num(Number(s.cost) + Number(s.credits)), gross: num(s.cost) })),
    daily: days.map((d) => ({ date: d.date, cost: num(d.cost) })),
  };
}

module.exports = { getBilling, invoiceMonth };
