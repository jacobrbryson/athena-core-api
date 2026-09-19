jest.mock('./oauth', () => ({ accessToken: jest.fn(), invalidate: jest.fn() }));
jest.mock('../readCache', () => ({ read: jest.fn(), invalidate: jest.fn(async () => {}), hash: jest.fn(() => 'fingerprint') }));
const oauth = require('./oauth');
const cache = require('../readCache');
const { providerGet, providerRequest } = require('./http');
beforeEach(() => {
  jest.clearAllMocks();
  oauth.accessToken.mockResolvedValue('secret-token');
  cache.read.mockImplementation((_opts, load) => load());
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => '{"items":[]}' }));
});
test('cached GET still resolves the live credential; a disconnected user gets no cached data', async () => {
  cache.read.mockResolvedValue({ cached: true });
  expect(await providerGet(42, 'google_calendar', '/users/me/calendarList')).toEqual({ cached: true });
  expect(oauth.accessToken).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
  expect(cache.read.mock.calls[0][0].key).not.toContain('secret-token');
  oauth.accessToken.mockResolvedValue(null);
  await expect(providerGet(42, 'google_calendar', '/users/me/calendarList')).rejects.toMatchObject({ code: 'not_connected' });
  expect(cache.read).toHaveBeenCalledTimes(1);
});
test('writes bypass cache and invalidate before and after a provider failure', async () => {
  fetch.mockRejectedValue(new Error('timeout'));
  await expect(providerRequest(42, 'google_calendar', '/calendars/primary/events', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'provider_error' });
  expect(cache.read).not.toHaveBeenCalled();
  expect(cache.invalidate).toHaveBeenCalledTimes(2);
  expect(cache.invalidate.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[0]);
  expect(cache.invalidate.mock.invocationCallOrder[1]).toBeGreaterThan(fetch.mock.invocationCallOrder[0]);
});
test('new GET endpoints remain uncached until explicitly opted in', async () => {
  await providerGet(42, 'google_calendar', '/new-sensitive-resource');
  expect(cache.read).not.toHaveBeenCalled();
  expect(cache.invalidate).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('Slack application errors and malformed JSON are returned without filling cache', async () => {
  fetch.mockResolvedValue({ ok: true, status: 200, text: async () => '{"ok":false,"error":"missing_scope"}' });
  expect(await providerGet(42, 'slack', '/auth.test')).toEqual({ ok: false, error: 'missing_scope' });
  fetch.mockResolvedValue({ ok: true, status: 200, text: async () => 'not json' });
  expect(await providerGet(42, 'slack', '/auth.test')).toBeNull();
});
