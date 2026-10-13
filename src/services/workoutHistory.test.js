jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('./consent', () => ({ hasConsentForProfile: jest.fn() }));
jest.mock('./audience', () => ({ audienceForProfile: jest.fn() }));
jest.mock('./connectors/whoop', () => ({ getWorkout: jest.fn() }));
const pool = require('../helpers/db');
const consent = require('./consent');
const audience = require('./audience');
const whoop = require('./connectors/whoop');
const history = require('./workoutHistory');

const ID = 'ecfc6a15-4661-442f-a9a4-f160dd7afae8';
const workout = {
  id: ID, user_id: 9012, start: '2026-10-12T22:00:00.000Z', end: '2026-10-12T23:05:00.000Z', timezone_offset: '-05:00',
  score_state: 'SCORED', sport: 'weightlifting', sport_id: 45, strain: 9.1, average_heart_rate: 118, max_heart_rate: 162,
  kilojoules: 1200.5, percent_recorded: 100, distance_meter: null, zone_durations: { zone_two_milli: 600000 }, updated_at: '2026-10-12T23:10:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  audience.audienceForProfile.mockResolvedValue('adult');
  consent.hasConsentForProfile.mockResolvedValue(true);
  pool.query.mockResolvedValue([{ affectedRows: 1 }]);
});

test('records an adult\'s workouts with health consent, keyed by profile/provider/id', async () => {
  expect(await history.record(7, [workout])).toBe(1);
  const [sql, [rows]] = pool.query.mock.calls[0];
  expect(sql).toMatch(/INSERT INTO athena_workout/);
  expect(sql).toMatch(/deleted_at = NULL/);
  expect(rows[0].slice(0, 6)).toEqual([7, 'whoop', ID, '9012', 'weightlifting', 45]);
  expect(JSON.parse(rows[0][18])).toEqual({ zone_two_milli: 600000 });
});

test.each([['child', true], ['adult', false]])('never records for audience=%s, consent=%s', async (who, ok) => {
  audience.audienceForProfile.mockResolvedValue(who);
  consent.hasConsentForProfile.mockResolvedValue(ok);
  expect(await history.record(7, [workout])).toBe(0);
  expect(pool.query).not.toHaveBeenCalled();
});

test('skips workouts without an id or valid times, writing nothing for an empty batch', async () => {
  expect(await history.record(7, [{ ...workout, id: null }, { ...workout, start: 'nope' }])).toBe(0);
  expect(pool.query).not.toHaveBeenCalled();
});

test('webhook reads the workout back for each linked profile; a 404 marks it deleted', async () => {
  pool.query.mockResolvedValueOnce([[{ profile_id: 7 }, { profile_id: 8 }]]);
  whoop.getWorkout.mockResolvedValueOnce(workout).mockRejectedValueOnce(Object.assign(new Error('gone'), { providerStatus: 404 }));
  await history.fromWebhook(9012, ID);
  expect(pool.query.mock.calls[1][0]).toMatch(/INSERT INTO athena_workout/);
  expect(pool.query.mock.calls[2][0]).toMatch(/UPDATE athena_workout SET deleted_at/);
  expect(pool.query.mock.calls[2][1]).toEqual([8, 'whoop', ID]);
});

test('webhook ignores a workout that belongs to another account, and swallows provider errors', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  pool.query.mockResolvedValueOnce([[{ profile_id: 7 }, { profile_id: 8 }]]);
  whoop.getWorkout.mockResolvedValueOnce({ ...workout, user_id: 1 }).mockRejectedValueOnce(new Error('WHOOP down'));
  await expect(history.fromWebhook(9012, ID)).resolves.toBe(0);
  expect(pool.query).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

test('list reads only this profile, escapes the sport filter and reports zone minutes', async () => {
  pool.query.mockResolvedValueOnce([[{ external_id: ID, sport_name: 'weightlifting', started_at: new Date(workout.start), ended_at: new Date(workout.end),
    strain: '9.1000', zone_durations: '{"zone_two_milli":600000}' }]]);
  const [row] = await history.list(7, { days: 99999, sport: '50%_lift' });
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/WHERE profile_id = \? AND deleted_at IS NULL/);
  expect(params[0]).toBe(7);
  expect(params[2]).toBe('%50\\%\\_lift%');
  expect(row).toMatchObject({ sport: 'weightlifting', minutes: 65, strain: 9.1, minutes_in_zone: { zone_two: 10 } });
});

test('the date is the local day the workout started, not the UTC one', async () => {
  pool.query.mockResolvedValueOnce([[{ sport_name: 'weightlifting', started_at: new Date('2026-10-13T02:30:00Z'), ended_at: new Date('2026-10-13T03:00:00Z'), timezone_offset: '-04:00' }]]);
  expect((await history.list(7))[0].date).toBe('2026-10-12');
});
