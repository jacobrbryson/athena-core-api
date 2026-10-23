jest.mock('../../helpers/db', () => ({ query: jest.fn() }));
jest.mock('../credentials', () => ({ get: jest.fn() }));
jest.mock('../secrets', () => ({ getSecret: jest.fn() }));
const pool = require('../../helpers/db');
const credentials = require('../credentials');
const { getSecret } = require('../secrets');
const smartcar = require('./smartcar');
const registry = require('./registry');

const CAR = 'v_123abc456def';
const USER = 'user_789xyz';
const NOW = new Date('2026-10-20T15:00:00Z');

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const signal = (body, status = 'SUCCESS') => ({ data: { attributes: { status: { value: status }, body } } });

/** A fake Smartcar: one connected BMW, 50,000 km, 42% fuel, unlocked. */
function smartcarApi({ location = { latitude: 35.123456789, longitude: -80.9 } } = {}) {
  return jest.fn(async (url, init = {}) => {
    if (url.startsWith('https://iam.smartcar.com/')) return json(200, { access_token: 'app-token', expires_in: 3600 });
    expect(init.headers['sc-user-id']).toBe(USER);
    expect(init.headers.Authorization).toBe('Bearer app-token');
    if (url.includes('/connections?')) return json(200, { data: [{ relationships: { vehicle: { data: { id: CAR } } }, attributes: { vehicle: { make: 'BMW', model: 'X5', year: 2019 } } }] });
    const code = url.split('/signals/')[1];
    const bodies = {
      'odometer-traveleddistance': signal({ value: 50000, unit: 'km' }),
      'internalcombustionengine-fuellevel': signal({ value: 42, unit: 'percent' }),
      'internalcombustionengine-range': signal({ value: 300, unit: 'km' }),
      'tractionbattery-stateofcharge': signal(null, 'UNAVAILABLE'),
      'tractionbattery-range': json(404, {}),
      'closure-islocked': signal({ value: false }),
      'location-preciselocation': signal(location),
      'vehicleidentification-vin': signal({ value: '5uxcr6c56kll12345' }),
    };
    const b = bodies[code];
    return b && b.status ? b : json(200, b);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  smartcar._resetToken();
  getSecret.mockImplementation(async (n) => ({ SMARTCAR_CLIENT_ID: 'client_01ABC', SMARTCAR_CLIENT_SECRET: 's3cret', SMARTCAR_APPLICATION_ID: 'app-uuid' }[n] || null));
  credentials.get.mockResolvedValue({ accessToken: USER });
});

describe('connecting', () => {
  const provider = registry.getProvider('smartcar');

  test('Connect is sent the application id with no code to exchange, and the state', async () => {
    const url = new URL(await provider.buildAuthorize({ state: 'st8', redirectUri: 'https://api.example/integrations/smartcar/callback' }));
    expect(url.origin + url.pathname).toBe('https://connect.smartcar.com/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ application_id: 'app-uuid', response_type: 'none', state: 'st8', mode: 'live' });
    expect(url.searchParams.has('client_id')).toBe(false);
  });

  test('without an application id it says Smartcar is not configured', async () => {
    getSecret.mockResolvedValue(null);
    await expect(provider.buildAuthorize({ state: 's', redirectUri: 'r' })).rejects.toMatchObject({ code: 'provider_unconfigured' });
  });

  test('the user_id that comes back is what is kept; anything else is refused', async () => {
    expect(await provider.completeLink({ userId: USER })).toEqual({ externalAccountId: `smartcar:${USER}`, displayName: 'Smartcar', accessToken: USER });
    await expect(provider.completeLink({ userId: undefined })).rejects.toMatchObject({ code: 'user_missing' });
    await expect(provider.completeLink({ userId: '../x?y' })).rejects.toMatchObject({ code: 'user_missing' });
  });
});

test('one application token is used for every read, from the M2M client credentials', async () => {
  const fetchImpl = smartcarApi();
  await smartcar.listCars(1, { fetchImpl });
  await smartcar.listCars(1, { fetchImpl });
  const tokenCalls = fetchImpl.mock.calls.filter(([u]) => u.startsWith('https://iam.smartcar.com/'));
  expect(tokenCalls).toHaveLength(1);
  expect(Object.fromEntries(tokenCalls[0][1].body)).toEqual({ grant_type: 'client_credentials', client_id: 'client_01ABC', client_secret: 's3cret' });
});

test('a person who never connected is not connected, and nothing is fetched', async () => {
  credentials.get.mockResolvedValue(null);
  const fetchImpl = smartcarApi();
  await expect(smartcar.listCars(1, { fetchImpl })).rejects.toMatchObject({ code: 'not_connected' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('a car is read in miles; what it cannot answer reads as nothing; no location unless asked', async () => {
  const fetchImpl = smartcarApi();
  const out = await smartcar.readCar(1, CAR, { fetchImpl, info: { make: 'BMW', model: 'X5', year: 2019 } });
  expect(out).toEqual({
    make: 'BMW', model: 'X5', year: 2019, vin: '5UXCR6C56KLL12345', odometerMi: 31069,
    fuel: { percent: 42, rangeMi: 186 }, battery: null, locked: false, location: null,
  });
  expect(fetchImpl.mock.calls.some(([u]) => u.includes('location-preciselocation'))).toBe(false);
});

test('location is read only when it was turned on for that car', async () => {
  const out = await smartcar.readCar(1, CAR, { location: true, fetchImpl: smartcarApi() });
  expect(out.location).toEqual({ latitude: 35.123457, longitude: -80.9 });
});

test('sync links by VIN, keeps no location for a car without it on, and carries a higher odometer over', async () => {
  global.fetch = smartcarApi();
  pool.query
    .mockResolvedValueOnce([[]]) // no stored cars yet
    .mockResolvedValueOnce([[{ id: 9, vin: '5UXCR6C56KLL12345', odometer: 30000 }]]) // their vehicles
    .mockResolvedValueOnce([{ affectedRows: 1 }]) // upsert
    .mockResolvedValueOnce([{ affectedRows: 1 }]) // odometer
    .mockResolvedValueOnce([{ affectedRows: 0 }]); // drop ungranted
  expect(await smartcar.sync(1, { now: NOW })).toBe(1);
  const upsert = pool.query.mock.calls[2][1];
  expect(upsert.slice(1, 7)).toEqual([CAR, 9, 'BMW', 'X5', 2019, '5UXCR6C56KLL12345']);
  expect(upsert.slice(11, 14)).toEqual([null, null, null]);
  expect(pool.query.mock.calls[3]).toEqual(['UPDATE athena_property_vehicle SET odometer = ?, odometer_on = ? WHERE id = ? AND profile_id = ?', [31069, '2026-10-20', 9, 1]]);
});

test('turning location off clears what was kept', async () => {
  pool.query
    .mockResolvedValueOnce([[{ id: 3 }]])
    .mockResolvedValueOnce([{ affectedRows: 1 }])
    .mockResolvedValueOnce([[]]);
  await smartcar.setLink(1, CAR, { locationEnabled: false });
  expect(pool.query.mock.calls[1][0]).toMatch(/location_enabled = 0, latitude = NULL, longitude = NULL, location_at = NULL/);
  await expect(smartcar.setLink(1, '../x', { locationEnabled: true })).rejects.toMatchObject({ status: 400 });
});

test('the prompt says read-only, and that an unlocked car is unlocked', () => {
  const line = smartcar.formatCar({ make: 'BMW', model: 'X5', year: 2019, odometerMi: 31069, fuel: { percent: 42, rangeMi: 186 }, battery: null, locked: false, location: null, locationEnabled: false, syncedAt: null });
  expect(line).toMatch(/31,069 mi/);
  expect(line).toMatch(/UNLOCKED/);
  expect(line).toMatch(/location not shared/);
});
