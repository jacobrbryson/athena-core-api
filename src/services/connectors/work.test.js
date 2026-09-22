jest.mock('./http', () => ({ providerGet: jest.fn() }));
const { providerGet } = require('./http');
const work = require('./work');
beforeEach(() => jest.resetAllMocks());
// Gmail moved to its own connector — see gmail.test.js. work.js only has
// Jira and Slack now (see work.js's header comment for why).
test('Jira searches only authorized sites and returns partial failures honestly', async () => {
  providerGet.mockResolvedValueOnce([{ id: 'one', name: 'Site', url: 'https://site.atlassian.net', scopes: ['read:jira-work'] }, { id: 'two', scopes: ['read:jira-work'] }, { id: 'hidden', scopes: [] }]);
  providerGet.mockResolvedValueOnce({ issues: [{ key: 'A-1', fields: { summary: 'A task', project: { name: 'A' }, status: { name: 'Open' } } }] }).mockRejectedValueOnce(new Error('down'));
  const result = await work.jira(42);
  expect(result.partial).toBe(true);
  expect(result.issues).toHaveLength(1);
  expect(providerGet.mock.calls[1][3].query.jql).toContain('assignee = currentUser()');
  expect(providerGet).toHaveBeenCalledTimes(3);
});
test('Jira total failure is not an empty work list', async () => {
  providerGet.mockResolvedValueOnce([{ id: 'one', scopes: ['read:jira-work'] }]).mockRejectedValueOnce(new Error('down'));
  await expect(work.jira(42)).rejects.toThrow();
});
test('Slack searches mentions for the authenticated user, not a supplied user id', async () => {
  providerGet.mockResolvedValueOnce({ ok: true, user_id: 'U42', team: 'Team' }).mockResolvedValueOnce({ ok: true, messages: { matches: [{ text: 'Hi', ts: '1', channel: { name: 'general' } }] } });
  const result = await work.slack(42);
  expect(providerGet.mock.calls[1][3].query.query).toMatch(/^<@U42> after:/);
  expect(result.messages[0].channel).toBe('general');
});
test('Slack HTTP-200 API failures are not treated as empty success', async () => {
  providerGet.mockResolvedValueOnce({ ok: true, user_id: 'U42' }).mockResolvedValueOnce({ ok: false, error: 'missing_scope' });
  await expect(work.slack(42)).rejects.toThrow();
});
