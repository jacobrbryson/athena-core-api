jest.mock('../helpers/db', () => ({ query: jest.fn() }));
const pool = require('../helpers/db');
const recalls = require('./vehicleRecalls');

const ok = (body) => ({ ok: true, json: async () => body });
const NHTSA = {
  results: [
    { NHTSACampaignNumber: '18V918000', Component: 'EQUIPMENT:OTHER:LABELS', Summary: 'Sun visor air bag label.', Consequence: 'Injury risk.', Remedy: 'Dealers replace.', ReportReceivedDate: '19/12/2018', parkIt: false, parkOutSide: false },
    { NHTSACampaignNumber: '20V123000', Component: 'ELECTRICAL', Summary: 'Fire risk.', ReportReceivedDate: '02/03/2020', parkIt: false, parkOutSide: true },
    { Component: 'no campaign number' },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test("NHTSA's day/month/year dates and its park flags are read", () => {
  expect(recalls.reportedOn('19/12/2018')).toBe('2018-12-19');
  expect(recalls.reportedOn('2018-12-19T00:00:00Z')).toBe('2018-12-19');
  expect(recalls.reportedOn('soon')).toBeNull();
  expect(recalls.recallOf(NHTSA.results[1])).toMatchObject({ campaign: '20V123000', park_outside: 1, park_it: 0, reported_on: '2020-03-02' });
  expect(recalls.recallOf(NHTSA.results[2])).toBeNull();
});

test('a VIN is decoded first, and only a well-formed one is sent', async () => {
  const fetchImpl = jest.fn(async () => ok({ Results: [{ Make: 'BMW', Model: 'X5', ModelYear: '2019' }] }));
  expect(await recalls.decodeVin('5UXCR6C56KLL12345', { fetchImpl })).toEqual({ make: 'BMW', model: 'X5', year: 2019 });
  expect(fetchImpl.mock.calls[0][0]).toMatch(/vpic\.nhtsa\.dot\.gov\/api\/vehicles\/DecodeVinValues\/5UXCR6C56KLL12345\?format=json$/);
  expect(await recalls.decodeVin('../../etc', { fetchImpl })).toBeNull();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('refresh looks up by the decoded car and counts only new recalls', async () => {
  const fetchImpl = jest.fn(async (url) => (url.includes('vpic') ? ok({ Results: [{ Make: 'BMW', Model: 'X5', ModelYear: '2019' }] }) : ok(NHTSA)));
  pool.query
    .mockResolvedValueOnce([{ affectedRows: 1 }]) // store the decode
    .mockResolvedValueOnce([[{ campaign: '20V123000' }]]) // already stored
    .mockResolvedValueOnce([{ affectedRows: 1 }]) // first recall: new
    // Second: already known and unchanged. mysql2's FOUND_ROWS makes that
    // report 1, same as an insert — it must still not count as added.
    .mockResolvedValueOnce([{ affectedRows: 1 }])
    .mockResolvedValueOnce([{ affectedRows: 1 }]); // checked_at
  const out = await recalls.refreshVehicle({ id: 4, vin: '5UXCR6C56KLL12345', make: 'Bimmer', model: 'x5', year: 2019 }, { fetchImpl });
  expect(out).toEqual({ skipped: false, added: 1 });
  expect(fetchImpl.mock.calls[1][0]).toContain('make=BMW&model=X5&modelYear=2019');
});

test('without a VIN the vehicle row says what it is; without either it is skipped', async () => {
  const fetchImpl = jest.fn(async () => ok({ results: [] }));
  pool.query.mockResolvedValue([[]]);
  await recalls.refreshVehicle({ id: 4, vin: null, make: 'Honda', model: 'Odyssey', year: 2021 }, { fetchImpl });
  expect(fetchImpl.mock.calls[0][0]).toContain('make=Honda&model=Odyssey&modelYear=2021');
  fetchImpl.mockClear();
  expect(await recalls.refreshVehicle({ id: 5, vin: null, make: 'Honda', model: null, year: null }, { fetchImpl })).toEqual({ skipped: true, added: 0 });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('only the owner can mark a recall, and only with a known status', async () => {
  await expect(recalls.setStatus(1, 'v', '18V918000', 'ignored')).rejects.toThrow(/acknowledged, repaired, not applicable, or open/);
  pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
  await recalls.setStatus(1, 'v', '18V918000', 'acknowledged');
  expect(pool.query.mock.calls[0][1][0]).toBe('acknowledged');
  pool.query.mockClear();
  pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
  await expect(recalls.setStatus(1, 'someone-elses', '18V918000', 'done')).rejects.toMatchObject({ status: 404 });
  expect(pool.query.mock.calls[0][1]).toEqual(['done', 1, 'someone-elses', '18V918000']);
});
