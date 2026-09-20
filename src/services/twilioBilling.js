const secrets = require('./secrets');

const BASE_URL = 'https://api.twilio.com/2010-04-01/Accounts';
const TIMEOUT_MS = 10000;

async function config() {
  const [account, key, secret] = await Promise.all([
    secrets.getSecret('TWILIO_ACCOUNT_SID'),
    secrets.getSecret('TWILIO_SID'),
    secrets.getSecret('TWILIO_CLIENT_SECRET'),
  ]);
  if (!account || !secret) return null;
  return { account, username: key || account, secret };
}

async function twilioGet(cfg, path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}/${cfg.account}/${path}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${cfg.username}:${cfg.secret}`).toString('base64')}` },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(body?.message || `Twilio returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function records(body) {
  return (Array.isArray(body?.usage_records) ? body.usage_records : []).map((record) => ({
    category: record.category || record.friendly_name || 'Other',
    description: record.description || record.friendly_name || record.category || 'Usage',
    count: record.count ?? null,
    countUnit: record.count_unit || null,
    price: record.price ?? null,
    priceUnit: record.price_unit || null,
  }));
}

async function getBilling() {
  const cfg = await config();
  if (!cfg) return { configured: false, checkedAt: new Date().toISOString() };
  const [balance, today, month] = await Promise.all([
    twilioGet(cfg, 'Balance.json'),
    twilioGet(cfg, 'Usage/Records/Today.json'),
    twilioGet(cfg, 'Usage/Records/ThisMonth.json'),
  ]);
  return {
    configured: true,
    checkedAt: new Date().toISOString(),
    balance: { amount: balance?.balance ?? null, currency: balance?.currency || null },
    today: records(today),
    month: records(month),
  };
}

module.exports = { getBilling };
