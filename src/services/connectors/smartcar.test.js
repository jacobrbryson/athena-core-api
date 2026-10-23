jest.mock('../../helpers/db', () => ({ query: jest.fn() }));
jest.mock('./http', () => ({ providerGet: jest.fn() }));
const pool = require('../../helpers/db');
const { providerGet } = require('./http');
const smartcar = require('./smartcar');

const ID = 'aaaabbbb-1111-2222-3333-444455556666';
const NOW = new Date('2026-10-20T15:00:00Z');

function car({ location = { latitude: 35.123456789, longitude: -80.9 } } = {}) {
  providerGet.mockImplementation(async (_p, _prov, path) => {
    if (path === '/vehicles') return { vehicles: [ID] };
    if (path.endsWith('/vin')) return { vin: '5uxcr6c56kll12345' };
    if (path.endsWith('/odometer')) return { distance: 50000 };
    if (path.endsWith('/fuel')) return { percentRemaining: 0.42, range: 300 };
    if (path.endsWith('/battery')) throw Object.assign(new Error('not capable'), { code: 'provider_error' });
    if (path.endsWith('/security')) return { isLocked: false };
    if (path.endsWith('/location')) return location;
    return { make: 'BMW', model: 'X5', year: 2019 };
  });
}

beforeEach(() => jest.clearAllMocks());

test('a car is read in miles; what it cannot answer reads as nothing', async () => {
  car();
  const out = await smartcar.readCar(1, ID);
  expect(out).toMatchObject({ make: 'BMW', vin: '5UXCR6C56KLL12345', odometerMi: 31069, fuel: { percent: 42, rangeMi: 186 }, battery: null, locked: false, location: null });
  expect(providerGet.mock.calls.some(([, , path]) => path.endsWith('/location'))).toBe(false);
});

test('location is read only when it was turned on for that car', async () => {
  car();
  const out = await smartcar.readCar(1, ID, { location: true });
  expect(out.location).toEqual({ latitude: 35.123457, longitude: -80.9 });
});

test('sync links by VIN, keeps no location for a car without it on, and carries a higher odometer over', async () => {
  car();
  pool.query
    .mockResolvedValueOnce([[]]) // no stored cars yet
    .mockResolvedValueOnce([[{ id: 9, vin: '5UXCR6C56KLL12345', odometer: 30000 }]]) // their vehicles
    .mockResolvedValueOnce([{ affectedRows: 1 }]) // upsert
    .mockResolvedValueOnce([{ affectedRows: 1 }]) // odometer
    .mockResolvedValueOnce([{ affectedRows: 0 }]); // drop ungranted
  expect(await smartcar.sync(1, { now: NOW })).toBe(1);
  const upsert = pool.query.mock.calls[2][1];
  expect(upsert[2]).toBe(9); // linked by VIN
  expect(upsert.slice(11, 14)).toEqual([null, null, null]); // no location kept
  expect(pool.query.mock.calls[3]).toEqual(['UPDATE athena_property_vehicle SET odometer = ?, odometer_on = ? WHERE id = ? AND profile_id = ?', [31069, '2026-10-20', 9, 1]]);
  expect(providerGet.mock.calls.some(([, , path]) => path.endsWith('/location'))).toBe(false);
});

test('a lower car odometer never rolls the vehicle back', async () => {
  car();
  pool.query
    .mockResolvedValueOnce([[{ smartcar_id: ID, vehicle_id: 9, location_enabled: 0 }]])
    .mockResolvedValueOnce([[{ id: 9, vin: '5UXCR6C56KLL12345', odometer: 40000 }]])
    .mockResolvedValueOnce([{ affectedRows: 1 }])
    .mockResolvedValueOnce([{ affectedRows: 0 }]);
  await smartcar.sync(1, { now: NOW });
  expect(pool.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE athena_property_vehicle'))).toBe(false);
});

test('turning location off clears what was kept', async () => {
  pool.query
    .mockResolvedValueOnce([[{ id: 3 }]])
    .mockResolvedValueOnce([{ affectedRows: 1 }])
    .mockResolvedValueOnce([[]]);
  await smartcar.setLink(1, ID, { locationEnabled: false });
  expect(pool.query.mock.calls[1][0]).toMatch(/location_enabled = 0, latitude = NULL, longitude = NULL, location_at = NULL/);
  await expect(smartcar.setLink(1, '../x', { locationEnabled: true })).rejects.toMatchObject({ status: 400 });
});

test('the prompt says read-only, and that an unlocked car is unlocked', () => {
  const line = smartcar.formatCar({ make: 'BMW', model: 'X5', year: 2019, odometerMi: 31069, fuel: { percent: 42, rangeMi: 186 }, battery: null, locked: false, location: null, locationEnabled: false, syncedAt: null });
  expect(line).toMatch(/31,069 mi/);
  expect(line).toMatch(/UNLOCKED/);
  expect(line).toMatch(/location not shared/);
});
