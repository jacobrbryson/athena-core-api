const credentials = require('../credentials');

/**
 * Jira Cloud by personal API token, stored as an encrypted `api_key`
 * credential for the one profile it was added to (see db/ or
 * scripts/addJiraApiToken.js).
 *
 * Everyone else links Jira through Atlassian OAuth (registry.js). An API token
 * is HTTP Basic (`atlassian-email:token`) against the site itself rather than
 * api.atlassian.com. The site host is kept in external_account_id and the
 * Atlassian email in display_name. Because the row belongs to a profile, there
 * is no other account that can reach it.
 */

const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.atlassian\.net$/i;
const TIMEOUT_MS = 12000;
// Only the current sprint: the backlog and future sprints aren't today's work.
const JQL = 'assignee = currentUser() AND sprint in openSprints() AND statusCategory != Done ORDER BY updated DESC';

/** `{ baseUrl, authorization }` when this profile's Jira link is an API token, else null. */
async function forProfile(profileId) {
  const credential = await credentials.get(profileId, 'jira', { actor: 'athena' });
  if (!credential || credential.kind !== 'api_key' || !credential.accessToken) return null;
  const host = String(credential.externalAccountId || '').toLowerCase();
  const email = credential.displayName;
  // The host is spliced into a URL the token is sent to — only ever Atlassian's.
  if (!HOST.test(host) || !email) return null;
  return { baseUrl: `https://${host}`, authorization: `Basic ${Buffer.from(`${email}:${credential.accessToken}`).toString('base64')}` };
}

/** The same shape work.jira() returns for OAuth users. */
async function readIssues(access) {
  const url = new URL(`${access.baseUrl}/rest/api/3/search/jql`);
  url.searchParams.set('jql', JQL);
  url.searchParams.set('maxResults', '25');
  url.searchParams.set('fields', 'summary,status,project,updated,duedate');
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: access.authorization, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw Object.assign(new Error(`Jira request failed: ${err.message}`), { code: 'provider_error' });
  }
  if (!response.ok) {
    const rejected = response.status === 401 || response.status === 403;
    throw Object.assign(new Error(rejected ? 'Jira rejected the API token' : `Jira: HTTP ${response.status}`), { code: 'provider_error', providerStatus: response.status });
  }
  const data = await response.json();
  return {
    issues: (data.issues || []).slice(0, 25).map(issue => ({
      key: issue.key, title: issue.fields?.summary || issue.key, status: issue.fields?.status?.name,
      // 'new' | 'indeterminate' | 'done' — what "In Progress" means in any workflow.
      statusCategory: issue.fields?.status?.statusCategory?.key,
      project: issue.fields?.project?.name, updated: issue.fields?.updated, due: issue.fields?.duedate,
      site: access.baseUrl.replace('https://', ''), url: `${access.baseUrl}/browse/${encodeURIComponent(issue.key)}`,
    })),
    partial: false,
    // Jira has more than the 25 asked for, so a count is a floor.
    capped: !!data.nextPageToken || data.isLast === false || (data.issues || []).length > 25,
  };
}

module.exports = { forProfile, readIssues, JQL };
