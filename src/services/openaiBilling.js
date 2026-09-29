const secrets = require('./secrets');

// OpenAI publishes spend, not a prepaid credit balance: the balance the
// dashboard shows is session-only. This reads the organization Costs API with
// an admin key, which is why it is a separate secret from OPENAI_API_KEY.
const COSTS_URL = 'https://api.openai.com/v1/organization/costs';
const TIMEOUT_MS = 10000;
const MAX_PAGES = 5;
// "Lifetime" starts the day the Athena GCP project was created; the admin key
// sees the whole organization, so anything earlier isn't Athena's. Past days
// never change, so the all-time sum is cached rather than re-read per view.
const LIFETIME_SINCE = process.env.ATHENA_BILLING_SINCE || '2025-10-27';
const LIFETIME_PAGE_DAYS = 180;
const LIFETIME_MAX_PAGES = 12;
const LIFETIME_TTL_MS = 60 * 60 * 1000;
let lifetimeCache = null;

async function openaiGet(key, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${COSTS_URL}?${params}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(body?.error?.message || `OpenAI returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** Start of the current month, UTC — the Costs API buckets by UTC day. */
function monthStart(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/** Every cost since LIFETIME_SINCE, one sum; ungrouped, so it pages by day only. */
async function costSince(key, since, now) {
  if (lifetimeCache && lifetimeCache.key === key && now - lifetimeCache.at < LIFETIME_TTL_MS) return lifetimeCache.total;
  let total = 0;
  let page = null;
  for (let i = 0; i < LIFETIME_MAX_PAGES; i++) {
    const params = new URLSearchParams({ start_time: String(Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000)), bucket_width: '1d', limit: String(LIFETIME_PAGE_DAYS) });
    if (page) params.set('page', page);
    const body = await openaiGet(key, params);
    for (const bucket of Array.isArray(body?.data) ? body.data : []) {
      for (const result of Array.isArray(bucket?.results) ? bucket.results : []) {
        const value = Number(result?.amount?.value);
        if (Number.isFinite(value)) total += value;
      }
    }
    if (!body?.has_more || !body?.next_page) break;
    page = body.next_page;
  }
  lifetimeCache = { key, at: now.getTime(), total };
  return total;
}

async function getBilling(now = new Date()) {
  const key = await secrets.getSecret('OPENAI_API_ADMIN_KEY');
  if (!key) return { configured: false, checkedAt: now.toISOString() };

  const start = monthStart(now);
  const buckets = [];
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const params = new URLSearchParams({ start_time: String(Math.floor(start.getTime() / 1000)), bucket_width: '1d', limit: '31' });
    params.append('group_by', 'line_item');
    if (page) params.set('page', page);
    const body = await openaiGet(key, params);
    buckets.push(...(Array.isArray(body?.data) ? body.data : []));
    if (!body?.has_more || !body?.next_page) break;
    page = body.next_page;
  }

  let currency = null;
  let total = 0;
  const byLineItem = new Map();
  const daily = [];
  for (const bucket of buckets) {
    let dayTotal = 0;
    for (const result of Array.isArray(bucket?.results) ? bucket.results : []) {
      const value = Number(result?.amount?.value);
      if (!Number.isFinite(value)) continue;
      currency = currency || String(result.amount.currency || 'usd').toUpperCase();
      dayTotal += value;
      const item = result.line_item || 'Other';
      byLineItem.set(item, (byLineItem.get(item) || 0) + value);
    }
    total += dayTotal;
    daily.push({ date: new Date(Number(bucket.start_time) * 1000).toISOString().slice(0, 10), cost: round(dayTotal) });
  }
  const today = now.toISOString().slice(0, 10);
  const allTime = await costSince(key, LIFETIME_SINCE, now);

  return {
    configured: true,
    checkedAt: now.toISOString(),
    currency: currency || 'USD',
    monthStart: start.toISOString().slice(0, 10),
    costThisMonth: round(total),
    costToday: daily.find((d) => d.date === today)?.cost ?? 0,
    costAllTime: round(allTime),
    allTimeSince: LIFETIME_SINCE,
    lineItems: [...byLineItem].map(([name, cost]) => ({ name, cost: round(cost) }))
      .filter((item) => item.cost > 0).sort((a, b) => b.cost - a.cost),
    daily: daily.sort((a, b) => a.date.localeCompare(b.date)),
  };
}

module.exports = { getBilling, _resetCache: () => { lifetimeCache = null; } };
