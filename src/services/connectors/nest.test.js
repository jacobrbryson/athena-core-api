jest.mock('../../helpers/db', () => ({ query: jest.fn() }));
jest.mock('./http', () => ({ providerGet: jest.fn(), providerRequest: jest.fn() }));
const pool = require('../../helpers/db');
const { providerGet, providerRequest } = require('./http');
const nest = require('./nest');

const P = 'proj-123';
const NAME = `enterprises/${P}/devices/AVPHwEu-abc_1`;
const at = iso => new Date(iso);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEST_DEVICE_ACCESS_PROJECT_ID = P;
});

test('device names must belong to our project and carry no path tricks', () => {
  expect(nest.isDeviceName(NAME, P)).toBe(true);
  expect(nest.isDeviceName(`enterprises/other/devices/x`, P)).toBe(false);
  expect(nest.isDeviceName(`enterprises/${P}/devices/../structures/x`, P)).toBe(false);
  expect(nest.isDeviceName(`enterprises/${P}/structures/x`, P)).toBe(false);
  expect(nest.isDeviceName(null, P)).toBe(false);
});

test('transition keeps the instant a device went offline and clears it on return', () => {
  const t1 = at('2026-10-16T14:00:00Z'), t2 = at('2026-10-16T14:30:00Z'), t3 = at('2026-10-16T15:00:00Z');
  const off = nest.transition({ connectivity: 'ONLINE' }, 'OFFLINE', t1);
  expect(off).toEqual({ connectivity: 'OFFLINE', offline_since: t1, online_since: null });
  // Still offline: the occurrence the trigger dedupes on must not move.
  expect(nest.transition(off, 'OFFLINE', t2).offline_since).toBe(t1);
  // A report with no connectivity trait changes nothing.
  expect(nest.transition(off, null, t2)).toEqual(off);
  expect(nest.transition(off, 'ONLINE', t3)).toEqual({ connectivity: 'ONLINE', offline_since: null, online_since: t3 });
});

test('normalizes a thermostat, naming it by its room when it has no custom name', () => {
  const d = nest.normalizeDevice({
    name: NAME, type: 'sdm.devices.types.THERMOSTAT',
    traits: {
      'sdm.devices.traits.Info': { customName: '' },
      'sdm.devices.traits.Connectivity': { status: 'OFFLINE' },
      'sdm.devices.traits.Temperature': { ambientTemperatureCelsius: 21 },
      'sdm.devices.traits.ThermostatMode': { mode: 'HEAT' },
      'sdm.devices.traits.ThermostatTemperatureSetpoint': { heatCelsius: 20 },
      'sdm.devices.traits.Settings': { temperatureScale: 'FAHRENHEIT' },
    },
    parentRelations: [{ parent: 'x', displayName: 'Downstairs' }],
  });
  expect(d).toMatchObject({ type: 'thermostat', room: 'Downstairs', connectivity: 'OFFLINE', displayName: null });
  expect(nest.deviceTitle(d)).toBe('Downstairs thermostat');
  const line = nest.formatDevice({ ...d, offlineSince: '2026-10-16T18:14:00Z' });
  expect(line).toMatch(/OFFLINE since/);
  expect(line).toMatch(/70°F inside/);
  expect(line).toMatch(/mode heat set to 68°F/);
});

test('an offline event moves stored rows and reports who to evaluate', async () => {
  pool.query
    .mockResolvedValueOnce([[{ id: 1, profile_id: 7, connectivity: 'ONLINE', offline_since: null, online_since: null, readings: '{"temperatureC":20}', event_at: at('2026-10-16T13:00:00Z') }]])
    .mockResolvedValueOnce([{ affectedRows: 1 }]);
  const out = await nest.recordEvent({
    timestamp: '2026-10-16T14:00:00Z',
    resourceUpdate: { name: NAME, traits: { 'sdm.devices.traits.Connectivity': { status: 'OFFLINE' } } },
  }, { project: P });
  expect(out).toEqual({ applied: 1, wentOffline: [7], resync: [] });
  const [sql, params] = pool.query.mock.calls[1];
  expect(sql).toMatch(/UPDATE athena_nest_device/);
  expect(params[0]).toBe('OFFLINE');
  expect(JSON.parse(params[3])).toMatchObject({ temperatureC: 20, google: 'OFFLINE', notReporting: false }); // earlier readings kept
});

test('an event older than the stored state is ignored, so redelivery cannot rewind', async () => {
  pool.query.mockResolvedValueOnce([[{ id: 1, profile_id: 7, connectivity: 'ONLINE', event_at: at('2026-10-16T15:00:00Z') }]]);
  const out = await nest.recordEvent({
    timestamp: '2026-10-16T14:00:00Z',
    resourceUpdate: { name: NAME, traits: { 'sdm.devices.traits.Connectivity': { status: 'OFFLINE' } } },
  }, { project: P });
  expect(out.applied).toBe(0);
  expect(pool.query).toHaveBeenCalledTimes(1);
});

test('foreign devices are refused; unknown ones and relation changes re-read linked profiles', async () => {
  expect(await nest.recordEvent({ timestamp: '2026-10-16T14:00:00Z', resourceUpdate: { name: 'enterprises/evil/devices/x', traits: {} } }, { project: P }))
    .toEqual({ applied: 0, wentOffline: [], resync: [] });
  expect(pool.query).not.toHaveBeenCalled();

  pool.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ profile_id: 7 }, { profile_id: 9 }]]);
  const unknown = await nest.recordEvent({ timestamp: '2026-10-16T14:00:00Z', resourceUpdate: { name: NAME, traits: {} } }, { project: P });
  expect(unknown.resync).toEqual([7, 9]);

  pool.query.mockResolvedValueOnce([[{ profile_id: 7 }]]);
  const relation = await nest.recordEvent({ timestamp: '2026-10-16T14:00:00Z', relationUpdate: { type: 'CREATED', subject: NAME } }, { project: P });
  expect(relation.resync).toEqual([7]);
});

test('sync stores each shared device and drops ones no longer shared', async () => {
  providerGet.mockResolvedValue({ devices: [{ name: NAME, type: 'sdm.devices.types.THERMOSTAT', traits: { 'sdm.devices.traits.Connectivity': { status: 'OFFLINE' } } }] });
  pool.query.mockResolvedValueOnce([[]]).mockResolvedValue([{ affectedRows: 1 }]);
  const now = at('2026-10-16T14:00:00Z');
  expect(await nest.sync(7, { now })).toBe(1);
  expect(providerGet).toHaveBeenCalledWith(7, 'nest', `/enterprises/${P}/devices`);
  const insert = pool.query.mock.calls[1][1];
  expect(insert.slice(0, 2)).toEqual([7, NAME]);
  expect(insert[5]).toBe('OFFLINE');
  expect(insert[6]).toBe(now); // first seen offline: since now
  expect(pool.query.mock.calls[2][0]).toMatch(/DELETE .* NOT IN/);
});

test('refreshIfStale reads Google only when the rows are an hour old or missing', async () => {
  const now = at('2026-10-16T14:00:00Z');
  pool.query.mockResolvedValueOnce([[{ oldest: at('2026-10-16T13:30:00Z'), n: 1 }]]);
  expect(await nest.refreshIfStale(7, { now })).toBe(false);
  expect(providerGet).not.toHaveBeenCalled();

  providerGet.mockResolvedValue({ devices: [] });
  pool.query.mockResolvedValueOnce([[{ oldest: null, n: 0 }]]).mockResolvedValue([[]]);
  expect(await nest.refreshIfStale(7, { now })).toBe(true);
  expect(providerGet).toHaveBeenCalled();
});

test('a missing project id fails loudly rather than reading another project', () => {
  delete process.env.NEST_DEVICE_ACCESS_PROJECT_ID;
  expect(() => nest.projectId()).toThrow(/NEST_DEVICE_ACCESS_PROJECT_ID/);
});

test('0 °C with 0 % humidity is not reporting: offline by our reading, Google\'s flag kept beside it', () => {
  const silent = nest.assess({ temperatureC: 0, humidityPercent: 0, coolC: 25 }, 'ONLINE');
  expect(silent.status).toBe('OFFLINE');
  expect(silent.readings).toMatchObject({ google: 'ONLINE', notReporting: true, coolC: 25 });
  // Either zero alone is a reading, not a placeholder.
  expect(nest.assess({ temperatureC: 0, humidityPercent: 40 }, 'ONLINE').status).toBe('ONLINE');
  expect(nest.assess({ temperatureC: 21, humidityPercent: 0 }, 'ONLINE').status).toBe('ONLINE');
  // Reporting again, with no connectivity trait in the event: back to what Google last said.
  const back = nest.assess({ temperatureC: 20.5, humidityPercent: 44 }, null, { google: 'ONLINE', notReporting: true });
  expect(back).toMatchObject({ status: 'ONLINE', readings: { google: 'ONLINE', notReporting: false } });
  // No flag from Google at all, but it was only "offline" because it was silent: online.
  expect(nest.assess({ temperatureC: 20 , humidityPercent: 44 }, null, { notReporting: true }).status).toBe('ONLINE');
  // A real Google OFFLINE stays offline whatever the readings.
  expect(nest.assess({ temperatureC: 20, humidityPercent: 44 }, 'OFFLINE').status).toBe('OFFLINE');
});

test('a silent thermostat listed online is stored offline from the sync that sees it', async () => {
  providerGet.mockResolvedValue({ devices: [{ name: NAME, type: 'sdm.devices.types.THERMOSTAT', traits: {
    'sdm.devices.traits.Connectivity': { status: 'ONLINE' },
    'sdm.devices.traits.Temperature': { ambientTemperatureCelsius: 0 },
    'sdm.devices.traits.Humidity': { ambientHumidityPercent: 0 },
  } }] });
  pool.query.mockResolvedValueOnce([[{ device_name: NAME, connectivity: 'ONLINE', offline_since: null, online_since: at('2026-10-16T19:16:14Z'), readings: '{}' }]])
    .mockResolvedValue([{ affectedRows: 1 }]);
  const now = at('2026-10-16T20:00:00Z');
  await nest.sync(7, { now });
  const insert = pool.query.mock.calls[1][1];
  expect(insert[5]).toBe('OFFLINE');
  expect(insert[6]).toBe(now);
  expect(JSON.parse(insert[8])).toMatchObject({ google: 'ONLINE', notReporting: true });
});

test('a reading arriving for a silent thermostat brings it back online', async () => {
  pool.query
    .mockResolvedValueOnce([[{ id: 1, profile_id: 7, connectivity: 'OFFLINE', offline_since: at('2026-10-16T20:00:00Z'), online_since: null,
      readings: { temperatureC: 0, humidityPercent: 0, google: 'ONLINE', notReporting: true }, event_at: at('2026-10-16T20:00:00Z') }]])
    .mockResolvedValueOnce([{ affectedRows: 1 }]);
  const out = await nest.recordEvent({ timestamp: '2026-10-16T21:00:00Z', resourceUpdate: { name: NAME, traits: {
    'sdm.devices.traits.Temperature': { ambientTemperatureCelsius: 19.5 },
    'sdm.devices.traits.Humidity': { ambientHumidityPercent: 47 },
  } } }, { project: P });
  expect(out.wentOffline).toEqual([]);
  const params = pool.query.mock.calls[1][1];
  expect(params[0]).toBe('ONLINE');
  expect(params[1]).toBeNull();
});

test('a not-reporting device never shows its placeholder numbers', () => {
  const line = nest.formatDevice({ displayName: null, room: 'Den', type: 'thermostat', connectivity: 'OFFLINE', notReporting: true,
    offlineSince: '2026-10-16T20:00:00Z', readings: { mode: 'COOL', coolC: 25, scale: 'FAHRENHEIT' } });
  expect(line).toMatch(/NOT REPORTING since/);
  expect(line).not.toMatch(/32°F|humidity 0%/);
  expect(line).toMatch(/set to 77°F/);
});

test('commands go only to the person\'s own stored device, only from the allowlist, in order', async () => {
  const cmd = { command: 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool', params: { coolCelsius: 23.3 } };
  // Not theirs: nothing is sent.
  pool.query.mockResolvedValueOnce([[]]);
  await expect(nest.executeCommands(7, NAME, [cmd])).rejects.toThrow(/no longer shared/);
  expect(providerRequest).not.toHaveBeenCalled();
  // Foreign project or unlisted command: refused before any call.
  await expect(nest.executeCommands(7, 'enterprises/other/devices/x', [cmd])).rejects.toThrow(/Not a Nest device/);
  pool.query.mockResolvedValueOnce([[{ 1: 1 }]]);
  await expect(nest.executeCommands(7, NAME, [{ command: 'sdm.devices.commands.CameraLiveStream.GenerateRtspStream' }])).rejects.toThrow(/Unsupported/);
  expect(providerRequest).not.toHaveBeenCalled();
  // Theirs: posted to the device's executeCommand, then re-read.
  providerRequest.mockResolvedValue({});
  providerGet.mockResolvedValue({ devices: [] });
  pool.query.mockResolvedValueOnce([[{ 1: 1 }]]).mockResolvedValue([[]]);
  await nest.executeCommands(7, NAME, [cmd]);
  expect(providerRequest).toHaveBeenCalledWith(7, 'nest', `/${NAME}:executeCommand`, expect.objectContaining({ method: 'POST', body: cmd, invalidateOnAuthFailure: false }));
  expect(providerGet).toHaveBeenCalled();
});
