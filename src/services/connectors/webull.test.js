jest.mock('../credentials', () => ({ get: jest.fn(), markNeedsReauth: jest.fn(), updateTokens: jest.fn() }));
jest.mock('../../helpers/db', () => ({ query: jest.fn() }));
const credentials = require('../credentials');
const pool = require('../../helpers/db');
const webull = require('./webull');

const ok = body => ({ ok: true, status: 200, json: async () => body });
const link = over => ({ uuid: 'cred-1', kind: 'api_key', accessToken: 'secret', refreshToken: 'tok', externalAccountId: 'appkey', tokenType: 'production', ...over });

let profile = 500;
beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers();
  global.fetch = jest.fn();
  credentials.markNeedsReauth.mockResolvedValue({});
  profile += 1; // the snapshot cache is per profile
});
afterEach(() => jest.useRealTimers());

test('signature reproduces the worked example in Webull\'s docs', () => {
  const sig = webull.signature({
    path: '/trade/place_order',
    query: { a1: 'webull', a2: '123', a3: 'xxx', q1: 'yyy' },
    headers: {
      'x-app-key': '776da210ab4a452795d74e726ebd74b6', 'x-timestamp': '2022-01-04T03:55:31Z',
      'x-signature-version': '1.0', 'x-signature-algorithm': 'HMAC-SHA1',
      'x-signature-nonce': '48ef5afed43d4d91ae514aaeafbc29ba', host: 'api.webull.com',
    },
    body: '{"k1":123,"k2":"this is the api request body","k3":true,"k4":{"foo":[1,2]}}',
    secret: '0f50a2e853334a9aae1a783bee120c1f',
    algorithm: 'HMAC-SHA1',
  });
  expect(sig).toBe('kvlS6opdZDhEBo5jq40nHYXaLvM=');
});

test('a signed request carries the headers Webull wants and never the secret', async () => {
  fetch.mockResolvedValue(ok([]));
  await webull.request({ appKey: 'k', appSecret: 's3cret', token: 't', environment: 'sandbox' }, 'GET', '/trading/assets/balances/get', { query: { account_id: 'A1' } });
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('https://api.sandbox.webull.com/trading/assets/balances/get?account_id=A1');
  expect(init.headers).toMatchObject({ 'x-app-key': 'k', 'x-access-token': 't', 'x-version': 'v3', 'x-signature-algorithm': 'HMAC-SHA256' });
  expect(init.headers['x-timestamp']).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  expect(JSON.stringify(init.headers)).not.toContain('s3cret');
});

test('only read paths can be signed — order placement is unreachable', async () => {
  const l = { appKey: 'k', appSecret: 's', environment: 'production' };
  for (const path of ['/trading/orders/place', '/trading/orders/cancel', '/trading/orders/replace', '/trading/orders/batch-place']) {
    await expect(webull.request(l, 'POST', path, { body: {} })).rejects.toMatchObject({ code: 'forbidden_path' });
  }
  expect(fetch).not.toHaveBeenCalled();
  expect([...webull.READ_PATHS].some(p => /place|cancel|replace/.test(p))).toBe(false);
  expect(webull.READ_PATHS.has('/openapi/auth/token/refresh')).toBe(true);
});

describe('2FA token renewal', () => {
  const NOW = Date.parse('2026-11-05T03:00:00Z');
  const DAY = 86400_000;
  const settle = async promise => { const p = promise; await jest.runAllTimersAsync(); return p; };
  const byPath = routes => fetch.mockImplementation(async url => {
    const hit = Object.keys(routes).find(p => url.endsWith(p));
    if (!hit) throw new Error(`unexpected ${url}`);
    return routes[hit]();
  });
  const paths = () => fetch.mock.calls.map(([url]) => new URL(url).pathname);
  beforeEach(() => credentials.updateTokens.mockResolvedValue({}));

  test('a token more than three days from lapsing is left alone, with no call to Webull', async () => {
    credentials.get.mockResolvedValue(link({ expiresAt: new Date(NOW + 10 * DAY) }));
    await expect(settle(webull.renew(profile, { now: NOW }))).resolves.toMatchObject({ renewed: false, reason: 'not_due' });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('a link stored without an expiry gets it from a token check, and is not refreshed early', async () => {
    credentials.get.mockResolvedValue(link({ expiresAt: null }));
    const expires = NOW + 12 * DAY;
    byPath({ '/auth/tokens/check': () => ok({ token: 'tok', status: 'NORMAL', expires: String(expires) }) });
    await expect(settle(webull.renew(profile, { now: NOW }))).resolves.toMatchObject({ reason: 'not_due', expiresAt: expires });
    expect(paths()).toEqual(['/auth/tokens/check']);
    expect(credentials.updateTokens).toHaveBeenCalledWith('cred-1', expect.objectContaining({ accessToken: 'secret', refreshToken: 'tok', expiresAt: new Date(expires) }));
  });

  test('inside three days it refreshes and keeps the new token and expiry', async () => {
    credentials.get.mockResolvedValue(link({ expiresAt: new Date(NOW + 2.5 * DAY) }));
    const expires = NOW + 17 * DAY;
    byPath({ '/openapi/auth/token/refresh': () => ok({ token: 'tok2', status: 'NORMAL', expires_at: expires }) });
    await expect(settle(webull.renew(profile, { now: NOW }))).resolves.toMatchObject({ renewed: true, expiresAt: expires });
    const [, init] = fetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ token: 'tok' });
    expect(init.headers['x-access-token']).toBe('tok');
    // The App Secret stays in access_token_enc; only the 2FA token changes.
    expect(credentials.updateTokens).toHaveBeenCalledWith('cred-1', expect.objectContaining({ accessToken: 'secret', refreshToken: 'tok2', expiresAt: new Date(expires) }));
    expect(credentials.markNeedsReauth).not.toHaveBeenCalled();
  });

  test('a refresh reply without a status is confirmed with a check before it is kept', async () => {
    credentials.get.mockResolvedValue(link({ expiresAt: new Date(NOW + DAY * 2) }));
    byPath({
      '/openapi/auth/token/refresh': () => ok({ token: 'tok2' }),
      '/auth/tokens/check': () => ok({ token: 'tok2', status: 'NORMAL', expires: NOW + 15 * DAY }),
    });
    await expect(settle(webull.renew(profile, { now: NOW }))).resolves.toMatchObject({ renewed: true });
    expect(paths()).toEqual(['/openapi/auth/token/refresh', '/auth/tokens/check']);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ token: 'tok2' });
  });

  test('if Webull wants a new SMS approval, nothing is stored and the working link is not cut off early', async () => {
    credentials.get.mockResolvedValue(link({ expiresAt: new Date(NOW + 2 * DAY) }));
    byPath({
      '/openapi/auth/token/refresh': () => ok({ token: 'tok2', status: 'PENDING', expires: NOW + 15 * DAY }),
      '/auth/tokens/check': () => ok({ token: 'tok2', status: 'PENDING', expires: NOW + 15 * DAY }),
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(settle(webull.renew(profile, { now: NOW }))).resolves.toMatchObject({ renewed: false, reason: 'needs_approval' });
    warn.mockRestore();
    expect(credentials.updateTokens).not.toHaveBeenCalled();
    expect(credentials.markNeedsReauth).not.toHaveBeenCalled();
  });

  test('on the last night before it lapses, an unrenewable token marks the link needs_reauth with the reason', async () => {
    credentials.get.mockResolvedValue(link({ expiresAt: new Date(NOW + 20 * 3600_000) }));
    byPath({
      '/openapi/auth/token/refresh': () => ok({ token: 'tok2', status: 'PENDING' }),
      '/auth/tokens/check': () => ok({ token: 'tok2', status: 'PENDING' }),
    });
    await expect(settle(webull.renew(profile, { now: NOW }))).resolves.toMatchObject({ flagged: true });
    expect(credentials.updateTokens).not.toHaveBeenCalled();
    const [uuid, { detail }] = credentials.markNeedsReauth.mock.calls[0];
    expect(uuid).toBe('cred-1');
    expect(detail).toMatch(/text-message approval/);
    expect(detail).toMatch(/addWebullLogin/);
  });

  test('a refused refresh with days left is retried tomorrow, not treated as a dead link', async () => {
    credentials.get.mockResolvedValue(link({ expiresAt: new Date(NOW + 2 * DAY) }));
    byPath({ '/openapi/auth/token/refresh': () => ({ ok: false, status: 403, json: async () => ({ message: 'no permission' }) }) });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(settle(webull.renew(profile, { now: NOW }))).resolves.toMatchObject({ reason: 'needs_approval' });
    warn.mockRestore();
    expect(credentials.markNeedsReauth).not.toHaveBeenCalled();
  });

  test('an account without 2FA has nothing to renew', async () => {
    credentials.get.mockResolvedValue(link({ refreshToken: null }));
    await expect(settle(webull.renew(profile, { now: NOW }))).resolves.toMatchObject({ reason: 'no_2fa' });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('renewEveryone walks every active Webull link and one failure does not stop the rest', async () => {
    pool.query.mockResolvedValue([[{ profile_id: 1 }, { profile_id: 2 }]]);
    credentials.get.mockImplementation(async id => (id === 1 ? link({ expiresAt: new Date(Date.now() + DAY) }) : null));
    byPath({ '/openapi/auth/token/refresh': () => ok({ token: 'tok2', status: 'NORMAL', expires: Date.now() + 15 * DAY }) });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(settle(webull.renewEveryone())).resolves.toEqual({ profiles: 2, renewed: 1, waiting: 0, flagged: 0, failed: 1 });
    warn.mockRestore();
    expect(pool.query.mock.calls[0][0]).toMatch(/provider = 'webull' AND status = 'active'/);
  });
});

test('balances and positions normalize Webull\'s string numbers', () => {
  const b = webull.normalizeBalance({
    total_asset_currency: 'USD', total_net_liquidation_value: '12500.50', total_market_value: '10000', total_cash_balance: '2500.5',
    total_day_profit_loss: '-42.1', total_unrealized_profit_loss: '900', day_trades_left: '3',
    account_currency_assets: [{ currency: 'USD', buying_power: '2400', settled_cash: '2500.5' }],
  });
  expect(b).toMatchObject({ net_value: 12500.5, cash: 2500.5, buying_power: 2400, day_pl: -42.1, open_pl: 900, day_trades_left: '3' });
  const p = webull.normalizePosition({ symbol: 'AAPL', instrument_type: 'STOCK', quantity: '10', last_price: '200', cost_price: '150', unrealized_profit_loss: '500' });
  expect(p).toMatchObject({ symbol: 'AAPL', market_value: 2000, unrealized_pl: 500, unrealized_pl_percent: 33.33 });
  expect(webull.normalizeAccount({ account_id: 'X', account_number: '10010048', account_label: 'Individual Cash' })).toEqual({ id: 'X', label: 'Individual Cash', type: null, class: null, number_tail: '0048' });
});

test('snapshot reads every account and totals them', async () => {
  credentials.get.mockResolvedValue(link());
  fetch.mockImplementation(async url => {
    if (url.includes('/accounts/list')) return ok([{ account_id: 'A', account_number: '1111', account_label: 'Cash' }]);
    if (url.includes('/balances/get')) return ok({ total_asset_currency: 'USD', total_net_liquidation_value: '100', account_currency_assets: [{ currency: 'USD', buying_power: '40' }] });
    if (url.includes('/positions/list')) return ok([{ symbol: 'VTI', quantity: '1', last_price: '60', cost_price: '50', unrealized_profit_loss: '10' }]);
    return ok({ data: [{ orders: [{ order_id: 'o1', symbol: 'VTI', side: 'BUY', status: 'FILLED', total_quantity: '1', place_time_at: '2026-10-01T14:00:00.000Z' }] }] });
  });
  // The reads are spaced for Webull's 2-per-2s limit; run those pauses out.
  const pending = webull.snapshot(profile);
  await jest.runAllTimersAsync();
  const snap = await pending;
  expect(snap.accounts).toHaveLength(1);
  expect(snap.accounts[0].positions[0]).toMatchObject({ symbol: 'VTI', market_value: 60 });
  expect(snap.accounts[0].recent_orders[0]).toMatchObject({ id: 'o1', status: 'FILLED' });
  expect(snap.totals).toMatchObject({ net_value: 100, buying_power: 40 });
  // A second read inside five minutes is served from cache.
  const calls = fetch.mock.calls.length;
  await webull.snapshot(profile);
  expect(fetch.mock.calls.length).toBe(calls);
});

test('a refused key marks the link needs_reauth', async () => {
  credentials.get.mockResolvedValue(link());
  fetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ message: 'signature invalid' }) });
  await expect(webull.snapshot(profile)).rejects.toMatchObject({ code: 'not_connected', reason: 'rejected' });
  expect(credentials.markNeedsReauth).toHaveBeenCalledWith('cred-1', expect.objectContaining({ actor: 'connector' }));
});

test('no link means not_connected without a network call', async () => {
  credentials.get.mockResolvedValue(null);
  await expect(webull.snapshot(profile)).rejects.toMatchObject({ code: 'not_connected' });
  expect(fetch).not.toHaveBeenCalled();
});

test('keyword gate catches portfolio questions, not dinner', () => {
  expect(webull.matches('how is my portfolio doing today?')).toBe(true);
  expect(webull.matches('what is my buying power on webull')).toBe(true);
  expect(webull.matches('what should we make for dinner')).toBe(false);
});
