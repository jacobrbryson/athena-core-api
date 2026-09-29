#!/usr/bin/env node
/**
 * Load GCP cost from before the billing export existed into
 * billing_export.billing_history, so the System page's lifetime figure reaches
 * back to the start instead of to the day the export was switched on.
 *
 * The export can't be backfilled further than Google does it, but the Cloud
 * console can download any date range as CSV:
 *   Billing → Reports → range from the project's start, Group by: Service,
 *   Time: Monthly (so each row has a month) → Download CSV
 * or Billing → Cost table for one invoice month at a time (pass --month).
 *
 *   node db/load-gcp-billing-history.js report.csv [more.csv] [--month 202608] [--project athena-476423] [--dry-run]
 *
 * Rows are summed by month, project and service; cost is net of credits
 * ("Subtotal" when the CSV has it, otherwise cost plus every discount,
 * promotion and credit column). Loading a month replaces what was there for
 * that month, so re-running with a corrected file is safe. Any month loaded
 * here wins over the export for that month — load only complete months.
 *
 * Runs with your own gcloud application-default credentials; the runtime
 * service account only reads this table.
 */
require('dotenv').config();
const fs = require('fs');

const TABLE = 'billing_history';

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "2026-08", "202608", "2026-08-01", "8/1/2026", "Aug 2026", "August 1, 2026" → "202608". */
function toMonth(value) {
  const v = String(value || '').trim();
  let m;
  if ((m = v.match(/^(\d{4})-?(\d{2})(?:-\d{2})?/))) return `${m[1]}${m[2]}`;
  if ((m = v.match(/^(\d{1,2})\/\d{1,2}\/(\d{4})/))) return `${m[2]}${m[1].padStart(2, '0')}`;
  if ((m = v.toLowerCase().match(/^([a-z]{3})[a-z]*\.?\s+(?:\d{1,2},?\s+)?(\d{4})/)) && MONTHS.includes(m[1])) {
    return `${m[2]}${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}`;
  }
  return null;
}

function money(value) {
  const cleaned = String(value || '').replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function columns(header) {
  const h = header.map((c) => c.trim().toLowerCase());
  const find = (re) => h.findIndex((c) => re.test(c));
  const subtotal = find(/^subtotal/);
  return {
    month: find(/invoice month|^month$|usage start|^start date|^date$|^usage date/),
    project: find(/project id/),
    service: find(/service description|^service$/),
    net: subtotal,
    cost: subtotal >= 0 ? -1 : find(/^(unrounded )?cost/),
    adjustments: subtotal >= 0 ? [] : h.flatMap((c, i) => (/discount|promotion|credit|savings/.test(c) ? [i] : [])),
    currency: find(/currency/),
    header: h,
  };
}

function load(files, { month: fixedMonth, project: defaultProject }) {
  const totals = new Map();
  for (const file of files) {
    const [header, ...rows] = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const col = columns(header);
    if (col.net < 0 && col.cost < 0) throw new Error(`${file}: no Subtotal or Cost column in ${col.header.join(' | ')}`);
    if (col.month < 0 && !fixedMonth) throw new Error(`${file}: no month column; pass --month YYYYMM (columns: ${col.header.join(' | ')})`);
    if (col.project < 0 && !defaultProject) throw new Error(`${file}: no Project ID column; pass --project`);
    for (const row of rows) {
      // Report CSVs end with total/footer rows that carry no month or service.
      const month = fixedMonth || toMonth(row[col.month]);
      if (!month) continue;
      const project = (col.project >= 0 ? row[col.project] : defaultProject)?.trim();
      const service = (col.service >= 0 ? row[col.service] : 'All services')?.trim() || 'Unknown';
      if (!project || /^total/i.test(service)) continue;
      const cost = col.net >= 0 ? money(row[col.net]) : money(row[col.cost]) + col.adjustments.reduce((sum, i) => sum + money(row[i]), 0);
      const currency = col.currency >= 0 ? row[col.currency].trim() || 'USD' : 'USD';
      const key = [month, project, service, currency].join('\u0000');
      totals.set(key, (totals.get(key) || 0) + cost);
    }
  }
  return [...totals].map(([key, cost]) => {
    const [month, project, service, currency] = key.split('\u0000');
    return { month, project, service, currency, cost: Math.round(cost * 1e6) / 1e6 };
  }).sort((a, b) => a.month.localeCompare(b.month) || b.cost - a.cost);
}

async function write(rows, { exportProject, dataset, source }) {
  const { GoogleAuth } = require('google-auth-library');
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/bigquery'] }).getClient();
  const { token } = await client.getAccessToken();
  const months = [...new Set(rows.map((r) => r.month))];
  const params = [
    { name: 'months', parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } }, parameterValue: { arrayValues: months.map((value) => ({ value })) } },
    { name: 'source', parameterType: { type: 'STRING' }, parameterValue: { value: source } },
  ];
  const values = rows.map((r, i) => {
    for (const [k, type] of [['month', 'STRING'], ['project', 'STRING'], ['service', 'STRING'], ['currency', 'STRING'], ['cost', 'FLOAT64']]) {
      params.push({ name: `${k}${i}`, parameterType: { type }, parameterValue: { value: String(r[k]) } });
    }
    return `(@month${i}, @project${i}, @service${i}, @cost${i}, @currency${i}, @source, CURRENT_TIMESTAMP())`;
  });
  const table = `\`${exportProject}.${dataset}.${TABLE}\``;
  const response = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${exportProject}/queries`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      useLegacySql: false,
      parameterMode: 'NAMED',
      timeoutMs: 60000,
      queryParameters: params,
      query: `BEGIN TRANSACTION;
        DELETE FROM ${table} WHERE invoice_month IN UNNEST(@months);
        INSERT INTO ${table} (invoice_month, project_id, service, cost, currency, source, loaded_at) VALUES ${values.join(',\n')};
        COMMIT TRANSACTION;`,
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || `BigQuery returned HTTP ${response.status}`);
  if (!body?.jobComplete) throw new Error('BigQuery did not finish in time; check the job in the console before re-running');
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const dryRun = args.includes('--dry-run');
  const month = flag('--month');
  const project = flag('--project');
  const files = args.filter((a) => a !== '--dry-run');
  if (!files.length) {
    console.error('usage: node db/load-gcp-billing-history.js report.csv [more.csv] [--month YYYYMM] [--project ID] [--dry-run]');
    process.exit(2);
  }
  if (month && !/^\d{6}$/.test(month)) throw new Error('--month is YYYYMM, e.g. 202608');

  const rows = load(files, { month, project });
  if (!rows.length) throw new Error('No cost rows found — check the CSV has a month, a service and a cost per row.');
  const byMonth = new Map();
  for (const r of rows) byMonth.set(r.month, (byMonth.get(r.month) || 0) + r.cost);
  for (const [m, cost] of byMonth) console.log(`${m}  ${cost.toFixed(2)}  (${rows.filter((r) => r.month === m).length} project/service rows)`);
  const athena = process.env.GCP_PROJECT_ID;
  if (athena) console.log(`${athena} total: ${rows.filter((r) => r.project === athena).reduce((s, r) => s + r.cost, 0).toFixed(2)}`);
  if (dryRun) return console.log('dry run — nothing written');

  const exportProject = process.env.GCP_BILLING_EXPORT_PROJECT || athena;
  if (!exportProject) throw new Error('Set GCP_PROJECT_ID (or GCP_BILLING_EXPORT_PROJECT)');
  await write(rows, {
    exportProject,
    dataset: process.env.GCP_BILLING_EXPORT_DATASET || 'billing_export',
    source: files.map((f) => f.split(/[\\/]/).pop()).join(', ').slice(0, 200),
  });
  console.log(`wrote ${rows.length} rows for ${byMonth.size} month(s) to ${exportProject}.billing_export.${TABLE}`);
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}

module.exports = { parseCsv, toMonth, money, load };
