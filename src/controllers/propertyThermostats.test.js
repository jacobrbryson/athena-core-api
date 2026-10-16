jest.mock('../helpers/actor', () => ({ requireAdultActor: jest.fn() }));
jest.mock('../services/credentials', () => ({ status: jest.fn() }));
jest.mock('../services/connectors/nest', () => ({ PROVIDER: 'nest', refreshIfStale: jest.fn(), storedDevices: jest.fn() }));
const { requireAdultActor } = require('../helpers/actor');
const credentials = require('../services/credentials');
const nest = require('../services/connectors/nest');
const { list, FRESH_MS } = require('./propertyThermostats');

const device = { name: 'enterprises/p/devices/d', room: 'Downstairs', connectivity: 'OFFLINE' };
function response() {
  const res = {};
  for (const m of ['set', 'status', 'json']) res[m] = jest.fn(() => res);
  return res;
}
beforeEach(() => {
  jest.clearAllMocks();
  requireAdultActor.mockResolvedValue({ profileId: 7 });
  nest.refreshIfStale.mockResolvedValue(false);
  nest.storedDevices.mockResolvedValue([device]);
});

test('no link: not_connected, and stored rows are never read', async () => {
  credentials.status.mockResolvedValue(null);
  const res = response();
  await list({}, res);
  expect(res.json).toHaveBeenCalledWith({ status: 'not_connected', devices: [] });
  expect(nest.storedDevices).not.toHaveBeenCalled();
});

test('a link needing re-authorization shows nothing it holds', async () => {
  credentials.status.mockResolvedValue({ status: 'needs_reauth' });
  const res = response();
  await list({}, res);
  expect(res.json).toHaveBeenCalledWith({ status: 'needs_reauth', devices: [] });
  expect(nest.storedDevices).not.toHaveBeenCalled();
});

test('an active link re-reads Google only past five minutes and returns the devices', async () => {
  credentials.status.mockResolvedValue({ status: 'active' });
  const res = response();
  await list({}, res);
  expect(nest.refreshIfStale).toHaveBeenCalledWith(7, { maxAgeMs: FRESH_MS });
  expect(FRESH_MS).toBe(300000);
  expect(res.json).toHaveBeenCalledWith({ status: 'ready', stale: false, devices: [device] });
});

test('Google unreachable: the last recorded state, flagged stale; a revoked grant reads as reconnect', async () => {
  credentials.status.mockResolvedValue({ status: 'active' });
  nest.refreshIfStale.mockRejectedValueOnce(new Error('timeout'));
  let res = response();
  await list({}, res);
  expect(res.json).toHaveBeenCalledWith({ status: 'ready', stale: true, devices: [device] });

  nest.refreshIfStale.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'not_connected' }));
  res = response();
  await list({}, res);
  expect(res.json).toHaveBeenCalledWith({ status: 'needs_reauth', devices: [] });
});

test('children are refused by the adult gate', async () => {
  requireAdultActor.mockResolvedValue(null);
  const res = response();
  await list({}, res);
  expect(credentials.status).not.toHaveBeenCalled();
});
