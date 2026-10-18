jest.mock('../helpers/actor', () => ({ requireAdultActor: jest.fn() }));
jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('../services/securityMedia', () => ({ save: jest.fn(), list: jest.fn(), open: jest.fn(), setImportant: jest.fn(), remove: jest.fn() }));
const media = require('../services/securityMedia');
const { requireAdultActor } = require('../helpers/actor');
const pool = require('../helpers/db');
const controller = require('./propertySecurity');

const response = () => ({ status: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() });
const request = (serial = 'T8171ABC', kind = 'fresh') => ({ params: { serial }, query: { kind } });
const oldEnv = { ...process.env };
beforeEach(() => {
  process.env.EUFY_BRIDGE_URL = 'http://127.0.0.1:8789';
  process.env.EUFY_BRIDGE_TOKEN = 'a'.repeat(40);
  process.env.EUFY_AUTHORIZED_PROFILE_IDS = '12';
  requireAdultActor.mockReset().mockResolvedValue({ profileId: 12, kind: 'parent' });
  pool.query.mockReset().mockResolvedValue([{}]);
  global.fetch = jest.fn();
  for (const fn of Object.values(media)) fn.mockReset();
  media.save.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111' });
});
afterAll(() => { process.env = oldEnv; });

test('unlisted adult is refused before bridge status is read', async () => {
  process.env.EUFY_AUTHORIZED_PROFILE_IDS = '13';
  const res = response();
  await controller.list(request(), res);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(global.fetch).not.toHaveBeenCalled();
});
test('child refusal from existing actor guard makes no bridge call', async () => {
  requireAdultActor.mockResolvedValue(null);
  await controller.snapshot(request(), response());
  expect(global.fetch).not.toHaveBeenCalled();
});
test('paired device token bound to an allowed adult cannot read security', async () => {
  requireAdultActor.mockResolvedValue({ profileId: 12, kind: 'device' });
  const res = response();
  await controller.list(request(), res);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(global.fetch).not.toHaveBeenCalled();
});
test('media audit failure refuses before calling bridge', async () => {
  pool.query.mockRejectedValue(new Error('db unavailable'));
  const res = response();
  await controller.snapshot(request(), res);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(global.fetch).not.toHaveBeenCalled();
});
test('fresh media request uses fixed bridge URL and private bearer token', async () => {
  global.fetch.mockResolvedValue({ ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => Buffer.from('jpeg') });
  const res = response();
  await controller.snapshot(request(), res);
  expect(global.fetch.mock.calls[0][0].toString()).toBe('http://127.0.0.1:8789/v1/devices/T8171ABC/snapshot?kind=fresh');
  expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${process.env.EUFY_BRIDGE_TOKEN}`);
  expect(res.send).toHaveBeenCalled();
});
test('invalid serial and media kind are refused', async () => {
  const res = response();
  await controller.snapshot(request('../other', 'live'), res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(global.fetch).not.toHaveBeenCalled();
});

const ID = '11111111-1111-4111-8111-111111111111';
test('a fresh image is kept in the bucket with the camera name from the last status read', async () => {
  global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ state: 'ready', updatedAt: null, devices: [{ serial: 'T8171ABC', name: 'Backyard' }], events: [] }) });
  await controller.list(request(), response());
  global.fetch.mockResolvedValueOnce({ ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => Buffer.from('jpeg') });
  const res = response();
  await controller.snapshot(request(), res);
  expect(media.save).toHaveBeenCalledWith(expect.objectContaining({ profileId: 12, serial: 'T8171ABC', deviceName: 'Backyard', type: 'image' }));
  expect(res.set).toHaveBeenCalledWith('X-Athena-Kept', ID);
  expect(res.send).toHaveBeenCalled();
});
test('a storage failure still returns the fresh image', async () => {
  media.save.mockRejectedValue(new Error('bucket down'));
  global.fetch.mockResolvedValue({ ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => Buffer.from('jpeg') });
  const res = response();
  await controller.snapshot(request(), res);
  expect(res.set).toHaveBeenCalledWith('X-Athena-Kept', 'no');
  expect(res.send).toHaveBeenCalled();
});
test('a clip is audited, recorded through the bridge and kept', async () => {
  global.fetch.mockResolvedValue({ ok: true, headers: { get: () => 'video/mp4' }, arrayBuffer: async () => Buffer.from('mp4') });
  const res = response();
  await controller.clip({ params: { serial: 'T8171ABC' }, body: { seconds: 10 } }, res);
  expect(pool.query.mock.calls[0][1]).toEqual(['12', 'eufy_clip_media']);
  expect(global.fetch.mock.calls[0][0].toString()).toBe('http://127.0.0.1:8789/v1/devices/T8171ABC/clip?seconds=10');
  expect(media.save).toHaveBeenCalledWith(expect.objectContaining({ type: 'clip', durationSeconds: 10 }));
  expect(res.status).toHaveBeenCalledWith(201);
});
test('clip length outside 5-30 seconds is refused before the bridge', async () => {
  const res = response();
  await controller.clip({ params: { serial: 'T8171ABC' }, body: { seconds: 120 } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(global.fetch).not.toHaveBeenCalled();
});
test('unlisted adult cannot list, open or delete kept media', async () => {
  process.env.EUFY_AUTHORIZED_PROFILE_IDS = '13';
  for (const fn of [controller.listMedia, controller.getMedia, controller.removeMedia]) {
    const res = response();
    await fn({ params: { id: ID }, body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  }
  expect(media.list).not.toHaveBeenCalled();
  expect(media.open).not.toHaveBeenCalled();
  expect(media.remove).not.toHaveBeenCalled();
});
test('opening kept media fails closed when the audit cannot be written', async () => {
  pool.query.mockRejectedValue(new Error('db unavailable'));
  const res = response();
  await controller.getMedia({ params: { id: ID } }, res);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(media.open).not.toHaveBeenCalled();
});
test('starring needs a boolean and a real id', async () => {
  const res = response();
  await controller.updateMedia({ params: { id: 'nope' }, body: { important: true } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
  media.setImportant.mockResolvedValue({ id: ID, important: true });
  const ok = response();
  await controller.updateMedia({ params: { id: ID }, body: { important: true } }, ok);
  expect(ok.json).toHaveBeenCalledWith({ media: { id: ID, important: true } });
});
