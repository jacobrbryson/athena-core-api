process.env.PUBLIC_API_BASE_URL = 'https://api.example.com/api/v1';
process.env.INTEGRATION_REDIRECT_ALLOWLIST = 'https://app.example.com';
jest.mock('../../helpers/db', () => ({ query: jest.fn() }));
jest.mock('../secrets', () => ({ getSecret: jest.fn(async () => 'test-secret') }));
jest.mock('../consent', () => ({ hasConsent: jest.fn(async () => true) }));
jest.mock('../credentials', () => ({ put: jest.fn(), get: jest.fn(), updateTokens: jest.fn(), markNeedsReauth: jest.fn(), STATUS_NEEDS_REAUTH: 'needs_reauth' }));
const pool = require('../../helpers/db');
const credentials = require('../credentials');
const oauth = require('./oauth');
const { getProvider } = require('./registry');
const originalFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockImplementation(async sql => /SELECT/.test(sql) ? [[{ profile_id: 42, redirect_to: 'https://app.example.com' }]] : [{ affectedRows: 1 }]);
  credentials.put.mockImplementation(async value => ({ provider: value.provider }));
  global.fetch = jest.fn();
});
afterAll(() => { global.fetch = originalFetch; });
const response = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
test('Slack requests a read-only user grant, without bot scopes', async () => {
  const result = await oauth.begin({ profileId: 42 }, 'slack');
  const url = new URL(result.authorize_url);
  expect(url.searchParams.get('user_scope')).toBe('search:read');
  expect(url.searchParams.has('scope')).toBe(false);
  expect(url.searchParams.get('state')).toBeTruthy();
});
test('Slack saves nested user tokens and never substitutes a bot token', async () => {
  global.fetch.mockResolvedValue(response({ ok: true, access_token: 'bot-token', authed_user: { id: 'U42', access_token: 'user-token', refresh_token: 'refresh', scope: 'search:read' } }));
  await oauth.complete('slack', { state: 'state', code: 'code' });
  expect(credentials.put).toHaveBeenCalledWith(expect.objectContaining({ profileId: 42, accessToken: 'user-token', refreshToken: 'refresh' }));
  credentials.put.mockClear();
  global.fetch.mockResolvedValue(response({ ok: true, access_token: 'bot-token' }));
  await expect(oauth.complete('slack', { state: 'state', code: 'code' })).rejects.toThrow();
  expect(credentials.put).not.toHaveBeenCalled();
});
test('Slack rotates top-level user tokens and retains new refresh tokens', async () => {
  credentials.get.mockResolvedValue({ uuid: 'slack-user', expired: true, refreshToken: 'old', status: 'active' });
  global.fetch.mockResolvedValue(response({ ok: true, token_type: 'user', access_token: 'new', refresh_token: 'rotated' }));
  expect(await oauth.accessToken(42, 'slack')).toBe('new');
  expect(credentials.updateTokens).toHaveBeenCalledWith('slack-user', expect.objectContaining({ refreshToken: 'rotated' }));
});
test('Jira token exchange uses JSON and the existing state-derived profile', async () => {
  global.fetch.mockResolvedValue(response({ access_token: 'jira', refresh_token: 'refresh' }));
  await oauth.complete('jira', { state: 'state', code: 'code' });
  const [, request] = global.fetch.mock.calls[0];
  expect(request.headers['Content-Type']).toBe('application/json');
  expect(JSON.parse(request.body)).toMatchObject({ code: 'code', grant_type: 'authorization_code' });
  expect(credentials.put).toHaveBeenCalledWith(expect.objectContaining({ profileId: 42, provider: 'jira' }));
});
test('new work grants have no write scopes', () => {
  expect(getProvider('gmail').scopes).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
  expect(getProvider('jira').scopes).toEqual(['read:jira-work', 'offline_access']);
  expect(getProvider('slack').scopes).toEqual(['search:read']);
});
