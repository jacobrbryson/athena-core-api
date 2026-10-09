jest.mock('../credentials', () => ({ get: jest.fn() }));
const credentials = require('../credentials');
const jiraApiToken = require('./jiraApiToken');
beforeEach(() => { jest.resetAllMocks(); global.fetch = jest.fn(); });
const row = over => ({ kind: 'api_key', accessToken: 'tok', externalAccountId: 'team.atlassian.net', displayName: 'me@work.com', ...over });

test('an api_key Jira credential becomes Basic auth against its own site', async () => {
  credentials.get.mockResolvedValueOnce(row());
  const access = await jiraApiToken.forProfile(8);
  expect(access.baseUrl).toBe('https://team.atlassian.net');
  expect(access.authorization).toBe(`Basic ${Buffer.from('me@work.com:tok').toString('base64')}`);
});
test('OAuth links, missing links and non-atlassian hosts never get the token path', async () => {
  credentials.get.mockResolvedValueOnce(row({ kind: 'oauth2' }));
  expect(await jiraApiToken.forProfile(8)).toBeNull();
  credentials.get.mockResolvedValueOnce(null);
  expect(await jiraApiToken.forProfile(8)).toBeNull();
  credentials.get.mockResolvedValueOnce(row({ externalAccountId: 'evil.example.com' }));
  expect(await jiraApiToken.forProfile(8)).toBeNull();
});
test('reads assigned issues with basic auth and rejects bad tokens', async () => {
  const access = { baseUrl: 'https://team.atlassian.net', authorization: 'Basic x' };
  fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ issues: [{ key: 'A-1', fields: { summary: 'Do it', status: { name: 'Open' }, project: { name: 'A' } } }] }) });
  const result = await jiraApiToken.readIssues(access);
  expect(result.issues[0]).toMatchObject({ key: 'A-1', url: 'https://team.atlassian.net/browse/A-1' });
  expect(fetch.mock.calls[0][0].searchParams.get('jql')).toContain('assignee = currentUser()');
  expect(fetch.mock.calls[0][0].searchParams.get('jql')).toContain('sprint in openSprints()');
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Basic x');
  fetch.mockResolvedValueOnce({ ok: false, status: 401 });
  await expect(jiraApiToken.readIssues(access)).rejects.toThrow('rejected');
});
test('issues carry their status category, and capped says whether Jira has more', async () => {
  const access = { baseUrl: 'https://team.atlassian.net', authorization: 'Basic x' };
  const issues = [{ key: 'A-1', fields: { summary: 'Do it', status: { name: 'Code Review', statusCategory: { key: 'indeterminate' } }, project: { name: 'A' } } }];
  fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ issues, isLast: false, nextPageToken: 'n' }) });
  const more = await jiraApiToken.readIssues(access);
  expect(more.issues[0].statusCategory).toBe('indeterminate');
  expect(more.capped).toBe(true);
  fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ issues, isLast: true }) });
  expect((await jiraApiToken.readIssues(access)).capped).toBe(false);
});
