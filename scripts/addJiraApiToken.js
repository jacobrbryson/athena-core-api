#!/usr/bin/env node
/**
 * One-off: store a Jira Cloud API token as an encrypted credential for ONE
 * profile. Reads JIRA_API_TOKEN, JIRA_EMAIL (Atlassian login) and JIRA_SITE_URL
 * from the environment; the Athena account is the first argument.
 *
 *   node scripts/addJiraApiToken.js you@example.com
 *
 * Verifies the token against the site before storing, and never prints it.
 */
require('dotenv').config();
const pool = require('../src/helpers/db');
const credentials = require('../src/services/credentials');

(async () => {
  const account = String(process.argv[2] || '').trim().toLowerCase();
  const token = (process.env.JIRA_API_TOKEN || '').trim();
  const email = (process.env.JIRA_EMAIL || '').trim();
  const site = (process.env.JIRA_SITE_URL || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  if (!account || !token || !email || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.atlassian\.net$/.test(site)) {
    throw new Error('Need an account email argument plus JIRA_API_TOKEN, JIRA_EMAIL and a *.atlassian.net JIRA_SITE_URL');
  }
  const check = await fetch(`https://${site}/rest/api/3/myself`, {
    headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`, Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(12000),
  });
  if (!check.ok) throw new Error(`Jira rejected the token (HTTP ${check.status})`);

  const [rows] = await pool.query('SELECT id FROM profile WHERE LOWER(email) = ?', [account]);
  if (rows.length !== 1) throw new Error(`Expected exactly one profile for ${account}, found ${rows.length}`);

  const saved = await credentials.put({
    profileId: rows[0].id, provider: 'jira', kind: 'api_key',
    externalAccountId: site, displayName: email, accessToken: token,
    tokenType: 'basic', actor: 'owner-script',
  });
  console.log(`Stored Jira API-token credential (${saved.status}) for ${account} on ${site}`);
})().catch(err => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end && pool.end());
