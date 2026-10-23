#!/usr/bin/env node
/**
 * One-off: link a Webull brokerage account to ONE profile, read-only. Reads
 * WEBULL_APP_KEY and WEBULL_APP_SECRET (from developer.webull.com → OpenAPI
 * Management → My Applications) and optionally WEBULL_ENV=sandbox from the
 * environment; the Athena account is the first argument.
 *
 *   node scripts/addWebullLogin.js you@example.com            # verify + store
 *   node scripts/addWebullLogin.js you@example.com --dry-run  # verify only
 *   node scripts/addWebullLogin.js you@example.com --no-2fa   # account has 2FA off
 *
 * With 2FA on (the default), Webull texts a code to the account's phone and
 * shows an "OpenAPI" prompt in the Webull app (Menu → Messages → OpenAPI
 * Notifications if it doesn't pop up). Enter the code there within five
 * minutes; this script waits for it. The token lapses after 15 days with no
 * API calls, and re-running this script is the fix.
 *
 * Then lists the accounts and prints what Athena would see, so a field Webull
 * renamed shows up here rather than as a blank on the Finance tab. Stores the
 * key and secret encrypted and never prints them.
 */
require('dotenv').config();
const pool = require('../src/helpers/db');
const credentials = require('../src/services/credentials');
const webull = require('../src/services/connectors/webull');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const account = String(process.argv[2] || '').trim().toLowerCase();
  const dryRun = process.argv.includes('--dry-run');
  const twoFactor = !process.argv.includes('--no-2fa');
  const appKey = (process.env.WEBULL_APP_KEY || '').trim();
  const appSecret = (process.env.WEBULL_APP_SECRET || '').trim();
  const environment = (process.env.WEBULL_ENV || '').trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
  if (!account || !appKey || !appSecret) throw new Error('Need an account email argument plus WEBULL_APP_KEY and WEBULL_APP_SECRET');

  const [rows] = await pool.query('SELECT id FROM profile WHERE LOWER(email) = ?', [account]);
  if (rows.length !== 1) throw new Error(`Expected exactly one profile for ${account}, found ${rows.length}`);
  const profileId = rows[0].id;
  const link = { appKey, appSecret, token: null, environment };
  console.log(`Webull ${environment}, signing with ${process.env.WEBULL_SIGNATURE_ALGORITHM === 'HMAC-SHA1' ? 'HMAC-SHA1' : 'HMAC-SHA256'}.`);

  if (twoFactor) {
    let t = await webull.createToken(link);
    console.log(`Token created: ${t.status}.`);
    if (t.status !== 'NORMAL') {
      console.log('Open the Webull app and enter the SMS code in the OpenAPI prompt (5 minutes)…');
      const deadline = Date.now() + 5 * 60_000;
      while (t.status === 'PENDING' && Date.now() < deadline) {
        await sleep(5000);
        t = await webull.checkToken(link, t.token);
      }
    }
    if (t.status !== 'NORMAL') throw new Error(`Token was not approved (status ${t.status}). Run the script again.`);
    link.token = t.token;
    console.log(`Token approved${t.expiresAt ? `, Webull says it expires ${new Date(t.expiresAt).toISOString()}` : ''}.`);
  }

  const listed = await webull.request(link, 'GET', '/trading/accounts/list');
  const raw = Array.isArray(listed) ? listed : listed?.data || [];
  console.log(`Accounts returned: ${raw.length}`);
  if (raw[0]) console.log(`Account fields Webull sent: ${Object.keys(raw[0]).sort().join(', ')}`);
  const accounts = raw.map(webull.normalizeAccount);
  for (const a of accounts) {
    await sleep(1100);
    const balance = await webull.request(link, 'GET', '/trading/assets/balances/get', { query: { account_id: a.id } });
    console.log(`\n${a.label} (····${a.number_tail || '?'}, ${a.class || a.type})`);
    console.log('  Balance fields:', Object.keys(balance || {}).sort().join(', '));
    console.log('  As Athena reads it:', webull.normalizeBalance(balance));
    await sleep(1100);
    const positions = await webull.request(link, 'GET', '/trading/assets/positions/list', { query: { account_id: a.id } });
    const list = Array.isArray(positions) ? positions : positions?.data || [];
    console.log(`  Positions: ${list.length}${list[0] ? ` — first: ${JSON.stringify(webull.normalizePosition(list[0]))}` : ''}`);
  }

  if (dryRun) { console.log('\nDry run: nothing stored.'); return; }
  const tail = accounts.find(a => a.number_tail)?.number_tail;
  const saved = await credentials.put({
    profileId, provider: 'webull', kind: 'api_key',
    externalAccountId: appKey, displayName: tail ? `Webull ····${tail}` : 'Webull',
    accessToken: appSecret, refreshToken: link.token || undefined,
    tokenType: environment, actor: 'owner-script',
  });
  console.log(`\nStored Webull credential (${saved.status}) for ${account}`);
})().catch(err => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end && pool.end());
