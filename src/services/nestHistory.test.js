jest.mock('../helpers/db', () => ({ query: jest.fn() }));
const pool = require('../helpers/db');
const history = require('./nestHistory');

const D = 'enterprises/p/devices/den';
const at = (iso) => new Date(iso);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('placeholder readings from a thermostat that is not reporting are never kept', () => {
  expect(history.rowOf({ temperatureC: 0, humidityPercent: 0, notReporting: true })).toBeNull();
  expect(history.rowOf({})).toBeNull();
  expect(history.rowOf({ temperatureC: 20.456, humidityPercent: 41.6, hvac: 'HEATING', mode: 'HEAT', heatC: 21 }))
    .toEqual({ temperature_c: 20.46, humidity: 42, hvac: 'HEATING', mode: 'HEAT', heat_c: 21, cool_c: null, eco: null });
});

test('the first reading is always written', async () => {
  pool.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
  expect(await history.record(7, D, { temperatureC: 20, hvac: 'OFF' }, at('2026-12-10T03:00:00Z'))).toBe(true);
  expect(pool.query.mock.calls[1][0]).toMatch(/INSERT IGNORE INTO athena_nest_reading/);
});

test('within ten minutes only a change in what the system is doing is written', async () => {
  const prev = { at: at('2026-12-10T03:00:00Z'), hvac: 'OFF', mode: 'HEAT', eco: null, heat_c: '21.00', cool_c: null };
  pool.query.mockResolvedValueOnce([[prev]]);
  expect(await history.record(7, D, { temperatureC: 20.5, hvac: 'OFF', mode: 'HEAT', heatC: 21 }, at('2026-12-10T03:05:00Z'))).toBe(false);
  expect(pool.query).toHaveBeenCalledTimes(1);

  pool.query.mockResolvedValueOnce([[prev]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
  expect(await history.record(7, D, { temperatureC: 20.5, hvac: 'HEATING', mode: 'HEAT', heatC: 21 }, at('2026-12-10T03:05:00Z'))).toBe(true);
});

test('after ten minutes a plain temperature reading is written', async () => {
  pool.query
    .mockResolvedValueOnce([[{ at: at('2026-12-10T03:00:00Z'), hvac: 'OFF', mode: 'HEAT', eco: null, heat_c: null, cool_c: null }]])
    .mockResolvedValueOnce([{ affectedRows: 1 }]);
  expect(await history.record(7, D, { temperatureC: 19, hvac: 'OFF', mode: 'HEAT' }, at('2026-12-10T03:11:00Z'))).toBe(true);
});

test('an event older than the newest stored reading is dropped', async () => {
  pool.query.mockResolvedValueOnce([[{ at: at('2026-12-10T03:00:00Z'), hvac: 'OFF', mode: 'HEAT' }]]);
  expect(await history.record(7, D, { temperatureC: 19, hvac: 'HEATING' }, at('2026-12-10T02:00:00Z'))).toBe(false);
});

test('a failed write never throws into the device update', async () => {
  pool.query.mockRejectedValueOnce(new Error('ER_NO_SUCH_TABLE'));
  await expect(history.record(7, D, { temperatureC: 19 }, at('2026-12-10T03:00:00Z'))).resolves.toBe(false);
});
