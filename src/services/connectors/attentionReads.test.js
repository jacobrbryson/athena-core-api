jest.mock('./http', () => ({ providerGet: jest.fn(), providerRequest: jest.fn(), isNotConnected: () => false }));
const { providerGet } = require('./http');
const whoop = require('./whoop');
const calendar = require('./googleCalendar');
const id = '12345678-1234-1234-1234-123456789abc';
beforeEach(() => jest.resetAllMocks());
test('WHOOP normalization preserves identity, revision and exact interval alongside existing metrics', async () => {
  const raw = { id, user_id: 42, start: '2026-09-01T17:00:00-04:00', end: '2026-09-01T18:00:00-04:00', updated_at: '2026-09-02T00:00:00Z', sport_name: 'ultimate frisbee', score: { strain: 5 } };
  providerGet.mockResolvedValue(raw);
  expect(await whoop.getWorkout(42, id)).toMatchObject({ id, user_id: 42, start: raw.start, end: raw.end, updated_at: raw.updated_at, sport: raw.sport_name, strain: 5 });
  expect(providerGet.mock.calls[0][2]).toBe(`/v2/activity/workout/${id}`);
});
test('historical calendar context follows pagination and includes every overlapping occurrence', async () => {
  const start = '2026-08-01T17:00:00-04:00', end = '2026-08-01T18:00:00-04:00';
  providerGet.mockResolvedValueOnce({ items: [{ id: 'primary', summary: 'Home' }] })
    .mockResolvedValueOnce({ items: [{ id: 'e1', summary: 'Practice', start: { dateTime: start }, end: { dateTime: end } }], nextPageToken: 'next' })
    .mockResolvedValueOnce({ items: [{ id: 'e2', summary: 'Another event', start: { dateTime: start }, end: { dateTime: end } }] });
  const result = await calendar.eventsInInterval(42, { start, end });
  expect(result.events.map(e => e.id)).toEqual(['e1', 'e2']);
  expect(providerGet.mock.calls[1][3].query.timeMin).toBe('2026-08-01T21:00:00.000Z');
  expect(providerGet.mock.calls[2][3].query.pageToken).toBe('next');
});
test('calendar outage does not become an empty schedule', async () => {
  providerGet.mockResolvedValueOnce({ items: [{ id: 'primary' }] }).mockRejectedValueOnce(new Error('timeout'));
  await expect(calendar.eventsInInterval(42, { start: '2026-09-01T10:00:00Z', end: '2026-09-01T11:00:00Z' })).rejects.toThrow('timeout');
});
test('a valid empty calendar page may omit items', async () => {
  providerGet.mockResolvedValueOnce({ items: [{ id: 'primary' }] }).mockResolvedValueOnce({ kind: 'calendar#events' });
  expect((await calendar.eventsInInterval(42, { start: '2026-09-01T10:00:00Z', end: '2026-09-01T11:00:00Z' })).events).toEqual([]);
});
