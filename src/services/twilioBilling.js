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

function smsUsage(body) {
  return (Array.isArray(body?.usage_records) ? body.usage_records : [])
    .filter((record) => {
      const category = String(record.category || '').toLowerCase();
      const name = String(record.friendly_name || record.description || '').toLowerCase();
      return category === 'sms' || category === 'sms-outbound' || /outbound.*sms|sms.*outbound/.test(name);
    })
    .reduce((total, record) => {
      const count = Number(record.count);
      const price = Number(record.price);
      return {
        messagesSent: total.messagesSent + (Number.isFinite(count) ? count : 0),
        cost: total.cost + (Number.isFinite(price) ? Math.abs(price) : 0),
      };
    }, { messagesSent: 0, cost: 0 });
}

async function getBilling() {
  const cfg = await config();
  if (!cfg) return { configured: false, checkedAt: new Date().toISOString() };
  const [balance, month] = await Promise.all([
    twilioGet(cfg, 'Balance.json'),
    twilioGet(cfg, 'Usage/Records/ThisMonth.json'),
  ]);
  const usage = smsUsage(month);
  return {
    configured: true,
    checkedAt: new Date().toISOString(),
    balance: { amount: balance?.balance ?? null, currency: balance?.currency || null },
    smsMessagesSent: usage.messagesSent,
    smsCostThisMonth: usage.cost,
  };
}

module.exports = { getBilling };
