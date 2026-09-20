jest.mock('../../helpers/db', () => ({ query: jest.fn() }));
jest.mock('../credentials', () => ({ list: jest.fn() }));
jest.mock('../consent', () => ({ hasConsentForProfile: jest.fn() }));
jest.mock('../audience', () => ({ audienceForProfile: jest.fn() }));
jest.mock('../connectors/whoop', () => ({ getWorkout: jest.fn(), getProfile: jest.fn(), workoutPage: jest.fn() }));
jest.mock('../connectors/googleCalendar', () => ({ eventsInInterval: jest.fn() }));
jest.mock('./store', () => ({ hash: v => JSON.stringify(v), parse: v => v, corrections: jest.fn() }));
const pool = require('../../helpers/db');
const credentials = require('../credentials');
const consent = require('../consent');
const audience = require('../audience');
const whoop = require('../connectors/whoop');
const calendar = require('../connectors/googleCalendar');
const store = require('./store');
const source = require('./whoop');
const ID = '12345678-1234-1234-1234-123456789abc';
const w = { id: 1, enabled: 1, profile_id: 42, credential_uuid: 'whoop-link', external_account_id: '12' };
const activity = { id: ID, user_id: 12, start: '2026-09-19T17:00:00-04:00', end: '2026-09-19T18:00:00-04:00', sport: 'Ultimate frisbee', updated_at: '2026-09-20T00:00:00Z' };
beforeEach(() => {
  jest.resetAllMocks();
  pool.query.mockResolvedValue([[]]); store.corrections.mockResolvedValue([]);
  audience.audienceForProfile.mockResolvedValue('adult'); consent.hasConsentForProfile.mockResolvedValue(true);
  credentials.list.mockResolvedValue([
    { provider: 'whoop', uuid: 'whoop-link', external_account_id: '12', status: 'active' },
    { provider: 'google_calendar', uuid: 'calendar-link', status: 'active' },
  ]);
  whoop.getWorkout.mockResolvedValue(activity);
  whoop.getProfile.mockResolvedValue({ user_id: 12 });
  calendar.eventsInInterval.mockResolvedValue({ events: [] });
});
test('requires explicit preference, adult identity, consent and current account connections', async () => {
  await expect(source.authorize({ ...w, enabled: 0 })).rejects.toMatchObject({ code: 'attention_paused' });
  consent.hasConsentForProfile.mockResolvedValueOnce(false);
  await expect(source.authorize(w)).rejects.toMatchObject({ code: 'health_consent_required' });
  audience.audienceForProfile.mockResolvedValueOnce('child');
  await expect(source.authorize(w)).rejects.toMatchObject({ code: 'adult_required' });
  await expect(source.authorize({ ...w, external_account_id: 'another-user' })).rejects.toMatchObject({ code: 'whoop_connection_changed' });
  expect(await source.authorize(w)).toEqual({ calendarCredential: 'calendar-link' });
});
test('out-of-order delete still fetches current source; another account is never interpreted', async () => {
  expect(await source.observe(w, { resource_id: ID, event_type: 'workout.deleted' })).toMatchObject({ state: 'present', data: activity });
  whoop.getWorkout.mockResolvedValueOnce({ ...activity, user_id: 999 });
  await expect(source.observe(w, { resource_id: ID })).rejects.toMatchObject({ code: 'source_identity_mismatch' });
});
test('missing source and provider outage are different outcomes', async () => {
  whoop.getWorkout.mockRejectedValueOnce({ providerStatus: 404 });
  expect(await source.observe(w, { resource_id: ID, event_type: 'workout.deleted' })).toMatchObject({ state: 'deleted' });
  whoop.getWorkout.mockRejectedValueOnce({ providerStatus: 404 });
  expect(await source.observe(w, { resource_id: ID, event_type: 'reconcile' })).toMatchObject({ state: 'not_found' });
  whoop.getWorkout.mockRejectedValueOnce(new Error('timeout'));
  await expect(source.observe(w, { resource_id: ID })).rejects.toThrow('timeout');
});
test('uses actual historical interval, retains calendar evidence and confirmed corrections', async () => {
  const observation = await source.observe(w, { resource_id: ID });
  calendar.eventsInInterval.mockResolvedValue({ events: [{ id: 'e', calendar_id: 'primary', title: 'Soccer coaching', start: activity.start, end: activity.end }] });
  pool.query.mockResolvedValue([[{ uuid: 'f', memory_key: 'work', memory_value: 'I coach soccer', source: 'user' }]]);
  store.corrections.mockResolvedValue([{ uuid: 'review', resource_id: ID, observation_hash: store.hash(observation), feedback: { label: 'Coaching', note: 'My practice' }, payload: { observation } }]);
  const ctx = await source.context(w, observation, { calendarCredential: 'calendar-link' });
  expect(calendar.eventsInInterval).toHaveBeenCalledWith(42, { start: activity.start, end: activity.end });
  expect(ctx.evidence.map(e => e.id)).toEqual(['observation', 'calendar:primary:e', 'memory:f', 'correction:review']);
  expect(ctx.ownCorrection).toMatchObject({ label: 'Coaching' });
  expect(pool.query.mock.calls[0][1]).toEqual([42]);
});
test('changed source revision does not blindly inherit a prior human confirmation', async () => {
  store.corrections.mockResolvedValue([{ uuid: 'review', resource_id: ID, observation_hash: 'old', feedback: { label: 'Coaching' }, payload: { observation: activity } }]);
  const ctx = await source.context(w, await source.observe(w, { resource_id: ID }), {});
  expect(ctx.ownCorrection).toBeNull();
  expect(ctx.evidence.some(e => e.kind === 'human_correction')).toBe(true);
});
test('reconciliation persists stable paging state rather than dropping page two', async () => {
  whoop.workoutPage.mockResolvedValue({ records: [activity], nextToken: 'page-two' });
  const result = await source.sync(w);
  expect(result.entries).toHaveLength(1);
  expect(result.nextState).toMatchObject({ nextToken: 'page-two' });
  const next = { ...w, sync_state: result.nextState };
  whoop.workoutPage.mockResolvedValue({ records: [], nextToken: null });
  expect((await source.sync(next)).nextState).toBeNull();
  expect(whoop.workoutPage.mock.calls[1][1]).toEqual(result.nextState);
});
