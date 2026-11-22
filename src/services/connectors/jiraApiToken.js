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

// --- Writes (owner, 2026-11-20: "add tasks from within that card") ---------
// Called only from services/actions after the person's own click (the Tasks
// card's Add task drawer, the direct action create_jira_issue). They take
// params normalize() vouched for. Only API-token links: Atlassian sign-in is
// granted read:jira-work alone, so it cannot create anything.

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,19}$/;

async function call(access, path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`${access.baseUrl}${path}`, {
      method,
      headers: { Authorization: access.authorization, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw Object.assign(new Error(`Jira request failed: ${err.message}`), { code: 'provider_error' });
  }
  if (!response.ok) {
    let detail = '';
    try {
      const data = await response.json();
      detail = [...(data.errorMessages || []), ...Object.values(data.errors || {})].filter(Boolean).join('; ').slice(0, 300);
    } catch { /* no body */ }
    const rejected = response.status === 401 || response.status === 403;
    throw Object.assign(new Error(detail ? `Jira: ${detail}` : rejected ? 'Jira refused the request' : `Jira: HTTP ${response.status}`), { code: 'provider_error', providerStatus: response.status, status: response.status === 400 ? 400 : 502 });
  }
  return response.status === 204 ? null : response.json();
}

/** Projects this person can create issues in, most recently active first. */
async function listProjects(access) {
  const data = await call(access, '/rest/api/3/project/search?maxResults=50&orderBy=-lastIssueUpdatedTime&action=create');
  return (data?.values || [])
    .filter(p => p && PROJECT_KEY.test(p.key || '') && !p.archived)
    .map(p => ({ key: p.key, name: String(p.name || p.key).slice(0, 120) }));
}

/** The issue type a new to-do becomes: "Task", else the first plain (non-epic, non-subtask) type. */
async function taskType(access, projectKey) {
  const data = await call(access, `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?maxResults=50`);
  const types = (data?.issueTypes || data?.values || []).filter(t => t && t.id && !t.subtask);
  const chosen = types.find(t => /^task$/i.test(t.name)) || types.find(t => !/^epic$/i.test(t.name)) || null;
  return chosen ? { id: String(chosen.id), name: String(chosen.name) } : null;
}

/** The active sprint on the project's scrum board, or null (kanban, no board, none running). */
async function activeSprint(access, projectKey) {
  const boards = await call(access, `/rest/agile/1.0/board?type=scrum&maxResults=10&projectKeyOrId=${encodeURIComponent(projectKey)}`);
  for (const board of (boards?.values || []).slice(0, 5)) {
    const sprints = await call(access, `/rest/agile/1.0/board/${encodeURIComponent(board.id)}/sprint?state=active&maxResults=5`).catch(() => null);
    const sprint = (sprints?.values || []).find(s => s && s.id && s.state === 'active');
    if (sprint) return { id: Number(sprint.id), name: String(sprint.name || 'Current sprint').slice(0, 120) };
  }
  return null;
}

const adf = (text) => ({
  type: 'doc', version: 1,
  content: String(text).split('\n').map(line => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })),
});

/** Create one issue assigned to the caller, then put it in the sprint normalize() found. */
async function createIssue(access, params) {
  const me = await call(access, '/rest/api/3/myself');
  const created = await call(access, '/rest/api/3/issue', {
    method: 'POST',
    body: {
      fields: {
        project: { key: params.project_key },
        issuetype: { id: params.issue_type_id },
        summary: params.summary,
        ...(me?.accountId ? { assignee: { accountId: me.accountId } } : {}),
        ...(params.due ? { duedate: params.due } : {}),
        ...(params.description ? { description: adf(params.description) } : {}),
      },
    },
  });
  const key = created?.key;
  if (!key) throw Object.assign(new Error('Jira did not return the new issue'), { code: 'provider_error' });
  const link = `${access.baseUrl}/browse/${encodeURIComponent(key)}`;
  // The issue exists from here on: a sprint that refuses it is said, never a failure.
  let sprintNote = null;
  if (params.sprint_id) {
    try {
      await call(access, `/rest/agile/1.0/sprint/${encodeURIComponent(params.sprint_id)}/issue`, { method: 'POST', body: { issues: [key] } });
    } catch (err) {
      sprintNote = `Created ${key}, but it couldn’t be added to ${params.sprint_name || 'the sprint'}: ${err.message}`;
    }
  }
  return { ref: key, detail: { link, ...(sprintNote ? { note: sprintNote } : {}) } };
}

module.exports = { forProfile, readIssues, JQL, PROJECT_KEY, listProjects, taskType, activeSprint, createIssue };
