jest.mock('../../helpers/db', () => ({ query: jest.fn() }));

const pool = require('../../helpers/db');
const entries = require('./entries');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString('base64');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString('base64');

const saved = [];
beforeEach(() => {
  jest.resetAllMocks();
  saved.length = 0;
  entries._setStorage({
    bucket: (b) => ({ file: (name) => ({ save: async (buf) => saved.push({ b, name, size: buf.length }), delete: async () => {} }) }),
  });
});

/** project lookup, then the entry count, then the insert and the progress stamp. */
function project({ children = false } = {}) {
  pool.query
    .mockResolvedValueOnce([[{ id: 7, uuid: '11111111-1111-1111-1111-111111111111', involves_children: children ? 1 : 0 }]])
    .mockResolvedValueOnce([[{ n: 0 }]])
    .mockResolvedValue([{ affectedRows: 1 }]);
}

describe('decodeImage', () => {
  it('reads JPEG and PNG, with or without a data URL', () => {
    expect(entries.decodeImage(`data:image/jpeg;base64,${JPEG}`).ext).toBe('jpg');
    expect(entries.decodeImage(PNG).mime).toBe('image/png');
  });
  it('refuses anything that is not really an image', () => {
    expect(() => entries.decodeImage(Buffer.from('hello world').toString('base64'))).toThrow(/Only JPEG, PNG or WebP/);
    expect(() => entries.decodeImage('not base64 !!')).toThrow(/isn't an image/);
  });
});

describe('add', () => {
  it('stores an adult project photo in the bucket', async () => {
    project();
    await entries.add(1, 'p', { type: 'photo', phase: 'before', image: JPEG });
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toMatch(/^projects\/1{8}-1{4}-1{4}-1{4}-1{12}\/[0-9a-f-]{36}\.jpg$/);
    const insert = pool.query.mock.calls.find(([sql]) => sql.startsWith('INSERT'));
    expect(insert[1]).toEqual(expect.arrayContaining(['photo', 'before', 'server']));
  });

  it('refuses image bytes on a project that involves children, and stores nothing', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 7, uuid: 'u', involves_children: 1 }]]);
    await expect(entries.add(1, 'p', { type: 'photo', image: JPEG })).rejects.toThrow(/stay on your device/);
    expect(saved).toHaveLength(0);
  });

  it('refuses image bytes on an entry marked as involving children, even on an adult project', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 7, uuid: 'u', involves_children: 0 }]]);
    await expect(entries.add(1, 'p', { type: 'photo', image: JPEG, involvesChildren: true })).rejects.toThrow(/stay on your device/);
    expect(saved).toHaveLength(0);
  });

  it("keeps a child's photo as a device reference only", async () => {
    project({ children: true });
    await entries.add(1, 'p', { type: 'photo', phase: 'memory', deviceRef: 'photo-abc123', body: 'Team photo' });
    expect(saved).toHaveLength(0);
    const insert = pool.query.mock.calls.find(([sql]) => sql.startsWith('INSERT'));
    expect(insert[1]).toEqual(expect.arrayContaining(['device', 'photo-abc123', 1]));
  });

  it('needs text for a note and a picture for a photo', async () => {
    pool.query.mockResolvedValue([[{ id: 7, uuid: 'u', involves_children: 0 }]]);
    await expect(entries.add(1, 'p', { type: 'note' })).rejects.toThrow(/needs some text/);
    await expect(entries.add(1, 'p', { type: 'photo' })).rejects.toThrow(/needs a picture/);
  });

  it('is scoped to their own project', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await expect(entries.add(1, 'someone-elses', { type: 'note', body: 'x' })).rejects.toMatchObject({ status: 404 });
  });
});
