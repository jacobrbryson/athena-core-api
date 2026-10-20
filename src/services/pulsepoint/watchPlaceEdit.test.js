jest.mock('../../helpers/db', () => ({ query: jest.fn(), getConnection: jest.fn() }));

const pool = require('../../helpers/db');
const watch = require('./watch');

const input = {
  name: 'Grandma’s house', kind: 'family', address: '10 Main St, Troutman, NC',
  notes: 'Front porch', latitude: 35.7, longitude: -80.9, radiusMiles: 5, enabled: true,
};

beforeEach(() => jest.clearAllMocks());

test('an edit keeps the owned place UUID and saves its picture for that profile', async () => {
  const image = Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]);
  pool.query.mockImplementation(async (sql) => {
    if (sql.startsWith('SELECT uuid FROM athena_watch_place WHERE profile_id = ? AND uuid = ?')) return [[{ uuid: 'place-1' }]];
    if (sql.startsWith('SELECT uuid FROM athena_watch_place WHERE profile_id = ? AND name = ?')) return [[]];
    if (sql.includes('FROM athena_watch_place p')) return [[{ uuid: 'place-1', name: input.name, kind: input.kind, address: input.address, notes: input.notes, latitude: input.latitude, longitude: input.longitude, radius_miles: 5, enabled: 1, image }]];
    throw new Error(`Unexpected query: ${sql}`);
  });
  const connection = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() };
  pool.getConnection.mockResolvedValue(connection);

  const places = await watch.updatePlace(42, 'place-1', { ...input, photoBase64: image.toString('base64') });

  expect(connection.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE athena_watch_place SET name'), expect.arrayContaining([42, 'place-1']));
  expect(connection.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO athena_watch_place_photo'), [42, 'place-1', image]);
  expect(connection.commit).toHaveBeenCalledTimes(1);
  expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('photo.place_uuid = p.uuid COLLATE utf8mb4_unicode_ci'), [42]);
  expect(places[0]).toMatchObject({ uuid: 'place-1', photoUrl: `data:image/jpeg;base64,${image.toString('base64')}` });
});

test('a place outside the caller’s profile cannot be edited', async () => {
  pool.query.mockResolvedValue([[]]);
  await expect(watch.updatePlace(42, 'someone-elses-place', input)).rejects.toMatchObject({ status: 404 });
  expect(pool.getConnection).not.toHaveBeenCalled();
});
