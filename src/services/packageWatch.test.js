jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('./llm', () => ({ generateJson: jest.fn() }));
const pool = require('../helpers/db');
const watch = require('./packageWatch');

const NOW = new Date('2026-12-10T19:00:00Z');
const UUID = '11111111-2222-3333-4444-555555555555';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
const row = (over = {}) => ({
  id: 9, uuid: UUID, device_serial: 'T8213', device_name: 'Front Door', zone: 'Porch', where_text: 'brown box on the doormat',
  first_seen_at: new Date('2026-12-10T17:00:00Z'), frame_uri: 'gs://b/f.jpg', check_at: new Date('2026-12-10T18:00:00Z'),
  checks_done: 0, status: 'waiting', still_there_at: null, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('opening a watch', () => {
  test('a package sighting opens one watch and asks for a look in an hour', async () => {
    pool.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
    const asks = await watch.onSightings([
      { uuid: 's1', kind: 'package', device_serial: 'T8213', device_name: 'Front Door', seen_at: NOW, frame_uri: 'gs://b/f.jpg' },
      { uuid: 's2', kind: 'package', device_serial: 'T8213', seen_at: NOW },
      { uuid: 's3', kind: 'person', device_serial: 'T8213', seen_at: NOW },
    ], { now: NOW });
    expect(asks).toEqual([{ deviceSn: 'T8213', watch: expect.stringMatching(/^[0-9a-f-]{36}$/), afterSeconds: 3600 }]);
    const inserted = pool.query.mock.calls[1][1][0];
    expect(inserted).toMatchObject({ sighting_uuid: 's1', device_serial: 'T8213', check_at: new Date(NOW.getTime() + 3600e3) });
  });

  test('a camera already watching a package today opens no second watch', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 3 }]]);
    expect(await watch.onSightings([{ uuid: 's1', kind: 'package', device_serial: 'T8213', seen_at: NOW }], { now: NOW })).toEqual([]);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('no package, no watch', async () => {
    expect(await watch.onSightings([{ kind: 'animal', device_serial: 'X1234' }], { now: NOW })).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('re-checks', () => {
  const event = { kind: 'recheck', deviceSn: 'T8213', watch: UUID };

  test('still there: marked, and asked again in two hours', async () => {
    pool.query.mockResolvedValueOnce([[row()]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
    const next = await watch.recheck({ event, frame: JPEG }, { now: NOW, compareWith: async () => 'yes', loadFrame: async () => 'first' });
    expect(next).toEqual([{ deviceSn: 'T8213', watch: UUID, afterSeconds: 7200 }]);
    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toMatch(/still_there_at = IF/);
    expect(params.slice(0, 3)).toEqual([1, new Date(NOW.getTime() + 7200e3), 'yes']);
  });

  test('gone: collected, naming the next person the camera saw', async () => {
    pool.query
      .mockResolvedValueOnce([[row()]])
      .mockResolvedValueOnce([[{ label: 'Jacob' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    expect(await watch.recheck({ event, frame: JPEG }, { now: NOW, compareWith: async () => 'no', loadFrame: async () => 'first' })).toEqual([]);
    expect(pool.query.mock.calls[2][0]).toMatch(/status = 'collected'/);
    expect(pool.query.mock.calls[2][1]).toEqual([1, NOW, 'Jacob', 9]);
  });

  test('the third look is the last', async () => {
    pool.query.mockResolvedValueOnce([[row({ checks_done: 2, still_there_at: NOW })]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
    expect(await watch.recheck({ event, frame: JPEG }, { now: NOW, compareWith: async () => 'yes', loadFrame: async () => 'first' })).toEqual([]);
  });

  test('no frame, or not a JPEG, is a check that could not tell — never a guess', async () => {
    const compareWith = jest.fn();
    pool.query.mockResolvedValueOnce([[row()]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
    await watch.recheck({ event, frame: Buffer.from('nope').toString('base64') }, { now: NOW, compareWith, loadFrame: async () => 'first' });
    expect(compareWith).not.toHaveBeenCalled();
    expect(pool.query.mock.calls[1][1][2]).toBe('unsure');
  });

  test('a recheck for another camera, a closed watch or a bad id changes nothing', async () => {
    expect(await watch.recheck({ event: { ...event, watch: 'x' }, frame: JPEG })).toEqual([]);
    pool.query.mockResolvedValueOnce([[]]);
    expect(await watch.recheck({ event: { ...event, deviceSn: 'OTHER1' }, frame: JPEG })).toEqual([]);
    pool.query.mockResolvedValueOnce([[row({ status: 'collected' })]]);
    expect(await watch.recheck({ event, frame: JPEG })).toEqual([]);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});
