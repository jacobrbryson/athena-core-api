jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('../helpers/actor', () => ({ requireAdultActor: jest.fn() }));
const db = require('../helpers/db');
const { requireAdultActor } = require('../helpers/actor');
const { normalize, list, create, update, remove, photos, addNote, removeNote, openIssues } = require('./propertyIssues');

const today = new Date().toISOString().slice(0, 10);
const draft = (over = {}) => ({ location: 'Downstairs HVAC', description: 'No cool air.', severity: 'high', noticedOn: today, notes: '', ...over });
const response = () => { const r = { set: jest.fn(), json: jest.fn(), status: jest.fn() }; r.status.mockReturnValue(r); return r; };
const row = { id: 7, uuid: 'issue-1', location: 'Downstairs HVAC', description: 'No cool air.', severity: 'high', noticed_on: today, notes: null, status: 'open', resolved_at: null };
beforeEach(() => { jest.clearAllMocks(); requireAdultActor.mockResolvedValue({ profileId: 42 }); });

test('requires a place, a description, a severity and a past date', () => {
  expect(normalize(draft())).toMatchObject({ location: 'Downstairs HVAC', severity: 'high', notes: null, status: 'open', addPhotos: [] });
  expect(() => normalize(draft({ location: '  ' }))).toThrow('Add where');
  expect(() => normalize(draft({ description: '' }))).toThrow('Add what');
  expect(() => normalize(draft({ severity: 'urgent' }))).toThrow('severity');
  expect(() => normalize(draft({ noticedOn: '2999-01-01' }))).toThrow('future');
  expect(() => normalize(draft({ noticedOn: 'yesterday' }))).toThrow('noticed');
});

test('accepts only JPEG data photos, at most four', () => {
  expect(() => normalize(draft({ photos: ['https://example.org/a.jpg'] }))).toThrow('JPEG');
  expect(() => normalize(draft({ photos: Array(5).fill('data:image/jpeg;base64,AAAA') }))).toThrow('up to 4');
  expect(normalize(draft({ photos: ['data:image/jpeg;base64,AAAA'] })).addPhotos).toHaveLength(1);
});

test('a patch keeps unspecified fields and ignores the listed photo uuids', () => {
  const existing = { location: 'Pool', description: 'Pump loud', severity: 'low', noticedOn: today, notes: null, status: 'open' };
  expect(normalize({ status: 'resolved', photos: ['abc'] }, existing)).toMatchObject({ ...existing, status: 'resolved', addPhotos: [] });
});

test('does not query without an adult actor', async () => {
  requireAdultActor.mockResolvedValue(null);
  await list({}, response());
  await create({ body: draft() }, response());
  expect(db.query).not.toHaveBeenCalled();
});

test('lists only the actor issues', async () => {
  db.query.mockResolvedValueOnce([[]]);
  const res = response(); await list({}, res);
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE profile_id = ?'), [42]);
  expect(res.json).toHaveBeenCalledWith({ issues: [] });
});

test('creates an issue for the actor with its photos', async () => {
  db.query.mockResolvedValueOnce([[{ n: 0 }]]).mockResolvedValueOnce([{ insertId: 9 }])
    .mockResolvedValueOnce([[{ n: 0 }]]).mockResolvedValueOnce([{}])
    .mockResolvedValueOnce([[]]);
  const res = response(); await create({ body: draft({ photos: ['data:image/jpeg;base64,AAAA'] }) }, res);
  const insert = db.query.mock.calls[1];
  expect(insert[0]).toContain('INSERT INTO athena_property_issue');
  expect(insert[1].slice(1)).toEqual([42, 'Downstairs HVAC', 'No cool air.', 'high', today, null, 'open']);
  expect(db.query.mock.calls[3][1]).toEqual([expect.any(String), 9, 'data:image/jpeg;base64,AAAA']);
  expect(res.json).toHaveBeenCalledWith({ issues: [] });
});

test('an unknown or foreign issue is a 404, never another person’s row', async () => {
  db.query.mockResolvedValueOnce([[]]);
  const res = response(); await update({ params: { uuid: 'issue-1' }, body: { status: 'resolved' } }, res);
  expect(db.query.mock.calls[0][1]).toEqual([42, 'issue-1']);
  expect(res.status).toHaveBeenCalledWith(404);
  db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
  const gone = response(); await remove({ params: { uuid: 'issue-1' } }, gone);
  expect(gone.status).toHaveBeenCalledWith(404);
});

test('resolving stamps resolved_at; other edits keep it', async () => {
  db.query.mockResolvedValueOnce([[row]]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([[]]);
  await update({ params: { uuid: 'issue-1' }, body: { status: 'resolved' } }, response());
  expect(db.query.mock.calls[1][0]).toContain('resolved_at=UTC_TIMESTAMP()');
  db.query.mockResolvedValueOnce([[row]]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([[]]);
  await update({ params: { uuid: 'issue-1' }, body: { notes: 'Filter changed' } }, response());
  expect(db.query.mock.calls[4][0]).toContain('resolved_at=resolved_at');
});

test('photos are read only through the actor’s issue', async () => {
  db.query.mockResolvedValueOnce([[row]]).mockResolvedValueOnce([[{ uuid: 'ph', image: 'data:image/jpeg;base64,AAAA' }]]);
  const res = response(); await photos({ params: { uuid: 'issue-1' } }, res);
  expect(db.query.mock.calls[1][1]).toEqual([7]);
  expect(res.json).toHaveBeenCalledWith({ photos: [{ uuid: 'ph', image: 'data:image/jpeg;base64,AAAA' }] });
});

test('a missing migration is a 503, and the prompt read stays quiet', async () => {
  db.query.mockRejectedValueOnce(new Error("Table doesn't exist"));
  const res = response(); await list({}, res);
  expect(res.status).toHaveBeenCalledWith(503);
  db.query.mockRejectedValueOnce(new Error("Table doesn't exist"));
  await expect(openIssues(42)).resolves.toEqual([]);
});

test('notes are added only to the actor’s issue and come back oldest first', async () => {
  const listed = { ...row, created_at: new Date(), updated_at: new Date() };
  db.query.mockResolvedValueOnce([[row]]).mockResolvedValueOnce([[{ n: 0 }]]).mockResolvedValueOnce([{}])
    .mockResolvedValueOnce([[listed]]).mockResolvedValueOnce([[]])
    .mockResolvedValueOnce([[{ issue_id: 7, uuid: 'n1', body: 'Left a voicemail at 8:45', created_at: new Date('2026-10-16T12:45:00Z') }]]);
  const res = response(); await addNote({ params: { uuid: 'issue-1' }, body: { body: '  Left a voicemail at 8:45 ' } }, res);
  expect(db.query.mock.calls[0][1]).toEqual([42, 'issue-1']);
  expect(db.query.mock.calls[2][1]).toEqual([expect.any(String), 7, 'Left a voicemail at 8:45']);
  expect(res.json.mock.calls[0][0].issues[0].log).toEqual([{ uuid: 'n1', body: 'Left a voicemail at 8:45', createdAt: '2026-10-16T12:45:00.000Z' }]);
});

test('an empty note is refused and a foreign note is a 404', async () => {
  db.query.mockResolvedValueOnce([[row]]);
  const empty = response(); await addNote({ params: { uuid: 'issue-1' }, body: { body: '  ' } }, empty);
  expect(empty.status).toHaveBeenCalledWith(400);
  db.query.mockResolvedValueOnce([[row]]).mockResolvedValueOnce([{ affectedRows: 0 }]);
  const gone = response(); await removeNote({ params: { uuid: 'issue-1', noteUuid: 'other' } }, gone);
  expect(db.query.mock.calls[2][1]).toEqual([7, 'other']);
  expect(gone.status).toHaveBeenCalledWith(404);
});

test('issues still list before the notes migration is installed', async () => {
  const listed = { ...row, created_at: new Date(), updated_at: new Date() };
  db.query.mockResolvedValueOnce([[listed]]).mockResolvedValueOnce([[]])
    .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ER_NO_SUCH_TABLE' }));
  const res = response(); await list({}, res);
  expect(res.json.mock.calls[0][0].issues[0].log).toEqual([]);
});
