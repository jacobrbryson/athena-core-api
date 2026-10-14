jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('../helpers/actor', () => ({ requireAdultActor: jest.fn() }));
jest.mock('../services/propertyWeather', () => ({ read: jest.fn() }));
const db = require('../helpers/db');
const { requireAdultActor } = require('../helpers/actor');
const { normalize, list, save, weather } = require('./properties');
const forecast = require('../services/propertyWeather');
const draft = () => ({ name: 'Our place', address: '', description: '', acreage: '', headerImage: '', mapImage: '', areas: [], boundary: [] });
const response = () => { const r = { set: jest.fn(), json: jest.fn(), status: jest.fn() }; r.status.mockReturnValue(r); return r; };
beforeEach(() => jest.clearAllMocks());
test('rejects invalid positions, acreage, and image URLs', () => {
  expect(normalize(draft()).acreage).toBeNull();
  expect(() => normalize({ ...draft(), acreage: -1 })).toThrow('acreage');
  expect(() => normalize({ ...draft(), boundary: [{ x: 101, y: 20 }] })).toThrow('position');
  expect(() => normalize({ ...draft(), mapImage: 'https://example.org/photo.jpg' })).toThrow('JPEG');
});
test('does not query without an adult actor', async () => {
  requireAdultActor.mockResolvedValue(null);
  await list({}, response());
  expect(db.query).not.toHaveBeenCalled();
});
test('reads only the actor property records', async () => {
  requireAdultActor.mockResolvedValue({ profileId: 42 });
  db.query.mockResolvedValueOnce([[{ uuid: 'p', details: JSON.stringify(draft()) }]]);
  const res = response(); await list({}, res);
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE profile_id = ?'), [42]);
  expect(res.json).toHaveBeenCalledWith({ properties: [{ uuid: 'p', ...draft() }] });
});
test('refuses links outside the actor records before saving', async () => {
  requireAdultActor.mockResolvedValue({ profileId: 42 });
  db.query.mockResolvedValueOnce([[]]);
  const res = response();
  await save({ body: { ...draft(), areas: [{ name: 'House', x: 50, y: 50, projects: ['12345678-1234-1234-1234-123456789abc'], concerns: [] }] } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(db.query).toHaveBeenCalledTimes(1);
  expect(db.query.mock.calls[0][1][0]).toBe(42);
});
test('updates the existing actor property and returns saved details', async () => {
  requireAdultActor.mockResolvedValue({ profileId: 42 });
  const details = normalize(draft());
  db.query.mockResolvedValueOnce([[{ uuid: 'existing' }]])
    .mockResolvedValueOnce([{}])
    .mockResolvedValueOnce([[{ uuid: 'existing', details: JSON.stringify(details) }]]);
  const res = response(); await save({ body: draft() }, res);
  expect(db.query.mock.calls[1][1]).toEqual(['existing', 42, JSON.stringify(details)]);
  expect(res.json).toHaveBeenCalledWith({ properties: [{ uuid: 'existing', ...details }] });
});
test('weather uses only the authenticated actor saved address', async () => {
  requireAdultActor.mockResolvedValue({ profileId: 42 });
  db.query.mockResolvedValueOnce([[{ details: JSON.stringify({ ...draft(), address: 'Saved address' }) }]]);
  forecast.read.mockResolvedValueOnce({ temperatureF: 62 });
  const res = response();
  await weather({ query: { address: 'A different address' } }, res);
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE profile_id = ?'), [42]);
  expect(forecast.read).toHaveBeenCalledWith(42, 'Saved address');
  expect(res.json).toHaveBeenCalledWith({ status: 'ready', weather: { temperatureF: 62 } });
});
test('missing address and unavailable forecast do not invent weather', async () => {
  requireAdultActor.mockResolvedValue({ profileId: 42 });
  db.query.mockResolvedValueOnce([[{ details: JSON.stringify(draft()) }]]);
  const res = response(); await weather({}, res);
  expect(forecast.read).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith({ status: 'no_address', weather: null });
  db.query.mockResolvedValueOnce([[{ details: JSON.stringify({ ...draft(), address: 'Saved address' }) }]]);
  forecast.read.mockResolvedValueOnce(null);
  await weather({}, res);
  expect(res.json).toHaveBeenLastCalledWith({ status: 'unavailable', weather: null });
});
test('weather does not look up an address without an adult actor', async () => {
  requireAdultActor.mockResolvedValue(null);
  await weather({}, response());
  expect(db.query).not.toHaveBeenCalled();
  expect(forecast.read).not.toHaveBeenCalled();
});
