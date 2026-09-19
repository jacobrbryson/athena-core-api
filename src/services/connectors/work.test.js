jest.mock('./http', () => ({ providerGet: jest.fn() }));
const { providerGet } = require('./http');
const work = require('./work');
beforeEach(() => jest.resetAllMocks());
test('Gmail reads only scoped unread inbox metadata, without mutating mail', async () => {
  providerGet.mockResolvedValueOnce({ emailAddress: 'person@example.com' }).mockResolvedValueOnce({ messages: [{ id: 'a/b' }] }).mockResolvedValueOnce({ payload: { headers: [{ name: 'Subject', value: 'Hello' }, { name: 'From', value: 'Sender' }] } });
  const result = await work.gmail(42);
  expect(result.account).toBe('person@example.com');
  expect(result.messages[0].title).toBe('Hello');
  expect(providerGet).toHaveBeenNthCalledWith(2, 42, 'gmail', '/users/me/messages', { query: { q: 'in:inbox is:unread', maxResults: 5 } });
  expect(providerGet).toHaveBeenNthCalledWith(3, 42, 'gmail', '/users/me/messages/a%2Fb', { query: { format: 'metadata' } });
});
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
