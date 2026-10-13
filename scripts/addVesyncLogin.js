#!/usr/bin/env node
/**
 * One-off: link a VeSync (Etekcity) scale to ONE profile. Reads VESYNC_EMAIL
 * and VESYNC_PASSWORD (and optionally VESYNC_REGION, US or EU) from the
 * environment; the Athena account is the first argument.
 *
 *   node scripts/addVesyncLogin.js you@example.com            # verify + store
 *   node scripts/addVesyncLogin.js you@example.com --dry-run  # verify only
 *
 * Logs in, finds the scale, reads the weigh-ins and prints which fields VeSync
 * sent and how the newest one reads in Athena's terms — so a field VeSync
 * renamed shows up here rather than as a blank on the dashboard. Stores the
 * password encrypted (VeSync renews a session only by logging in again) and
 * never prints it.
 */
require('dotenv').config();
const pool = require('../src/helpers/db');
const credentials = require('../src/services/credentials');
const vesync = require('../src/services/connectors/vesync');
const bodyComposition = require('../src/services/bodyComposition');

(async () => {
  const account = String(process.argv[2] || '').trim().toLowerCase();
  const dryRun = process.argv.includes('--dry-run');
  const email = (process.env.VESYNC_EMAIL || '').trim();
  const password = process.env.VESYNC_PASSWORD || '';
  const region = (process.env.VESYNC_REGION || 'US').trim().toUpperCase() === 'EU' ? 'EU' : 'US';
  if (!account || !email || !password) {
    throw new Error('Need an account email argument plus VESYNC_EMAIL and VESYNC_PASSWORD');
  }

  const [rows] = await pool.query('SELECT id FROM profile WHERE LOWER(email) = ?', [account]);
  if (rows.length !== 1) throw new Error(`Expected exactly one profile for ${account}, found ${rows.length}`);
  const profileId = rows[0].id;

  const session = await vesync.login({ profileId, email, password, region });
  console.log(`Logged in to VeSync (${session.region} region).`);
  const scale = await vesync.findScale(session, profileId);
  console.log(`Scale: ${scale.name}`);
  const raw = await vesync.fetchWeighIns(session, profileId, scale.configModule);
  console.log(`Weigh-ins returned: ${raw.length}`);
  if (raw.length) {
    const keys = [...new Set(raw.flatMap(r => Object.keys(r || {})))].sort();
    console.log(`Fields VeSync sent: ${keys.join(', ')}`);
    const subUsers = new Set(raw.map(r => r?.subUserID ?? null));
    if (subUsers.size > 1) console.log(`Note: ${subUsers.size} different subUserID values — more than one person's weigh-ins came back.`);
    const parsed = raw.map(vesync.normalize).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at));
    console.log(`Readable weigh-ins: ${parsed.length}`);
    if (parsed.length) console.log(`Range: ${parsed[parsed.length - 1].at.slice(0, 10)} to ${parsed[0].at.slice(0, 10)}`);
    if (parsed[0]) {
      const { impedance_ohm, sex, age, height_cm } = parsed[0];
      // Athena's estimates come from these; a wrong sex code or an impedance
      // in odd units would skew every one of them.
      console.log('Estimate inputs on the newest weigh-in:', { impedance_ohm, sex, age, height_cm, raw_gender: raw.find(r => vesync.normalize(r)?.at === parsed[0].at)?.gender });
      console.log('Newest, as Athena reads it:', bodyComposition.enrich(parsed.slice(0, 1)).weighIns[0]);
    }
  }

  if (dryRun) { console.log('Dry run: nothing stored.'); return; }
  const saved = await credentials.put({
    profileId, provider: 'vesync', kind: 'api_key',
    externalAccountId: session.accountID, displayName: email,
    accessToken: session.token, refreshToken: password,
    tokenType: session.region, actor: 'owner-script',
  });
  console.log(`Stored VeSync credential (${saved.status}) for ${account}`);
})().catch(err => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end && pool.end());
