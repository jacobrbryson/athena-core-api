jest.mock('./credentials', () => ({ list: jest.fn() }));
jest.mock('./consent', () => ({ hasConsentForProfile: jest.fn() }));
jest.mock('./connectors/googleCalendar', () => ({ collectEvents: jest.fn(), displayTimeZone: () => 'America/New_York' }));
jest.mock('./connectors/whoop', () => ({ listRecovery: jest.fn(), listSleep: jest.fn(), listCycles: jest.fn() }));
jest.mock('./connectors/strava', () => ({ listActivities: jest.fn() }));
jest.mock('./integration', () => ({ getStatus: jest.fn(), getUsableCredentials: jest.fn(), PROVIDER_FAMILY_CHORES: 'family_chores' }));
jest.mock('./familyChores', () => ({ getChoresToday: jest.fn() }));
jest.mock('./connectors/work', () => ({ jira: jest.fn(), slack: jest.fn() }));
jest.mock('./connectors/context', () => ({ technicalDetail: () => null }));
jest.mock('./emailTriage', () => ({ summary: jest.fn() }));
jest.mock('./familyHealth', () => ({ activeFor: jest.fn().mockResolvedValue([]) }));
const credentials = require('./credentials');
const consent = require('./consent');
const calendar = require('./connectors/googleCalendar');
const whoop = require('./connectors/whoop');
const work = require('./connectors/work');
const integration = require('./integration');
const chores = require('./familyChores');
const emailTriage = require('./emailTriage');
const familyHealth = require('./familyHealth');
const { getDashboard } = require('./dashboard');
beforeEach(() => {
  jest.resetAllMocks();
  credentials.list.mockResolvedValue([]);
  consent.hasConsentForProfile.mockResolvedValue(false);
  integration.getStatus.mockResolvedValue({ connected: false });
  familyHealth.activeFor.mockResolvedValue([]);
});
test('unlinked sources remain explicit and make no provider calls', async () => {
  const result = await getDashboard(42, { googleId: 'caller' });
  expect(result.calendar.status).toBe('not_connected');
  expect(result.emailTriage.status).toBe('not_connected');
  expect(calendar.collectEvents).not.toHaveBeenCalled();
  expect(emailTriage.summary).not.toHaveBeenCalled();
});
test('health data is not read when consent is missing', async () => {
  credentials.list.mockResolvedValue([{ provider: 'whoop', status: 'active' }]);
  const result = await getDashboard(42, {});
  expect(result.recovery.status).toBe('consent_required');
  expect(whoop.listRecovery).not.toHaveBeenCalled();
});
test('one failed health endpoint leaves successful metrics intact', async () => {
  credentials.list.mockResolvedValue([{ provider: 'whoop', status: 'active' }]);
  consent.hasConsentForProfile.mockResolvedValue(true);
  whoop.listRecovery.mockResolvedValue([{ date: '2026-09-18', recovery_score: 0 }]);
  whoop.listSleep.mockRejectedValue(new Error('down'));
  whoop.listCycles.mockResolvedValue([]);
  const result = await getDashboard(42, {});
  expect(result.recovery.data[0].recovery_score).toBe(0);
  expect(result.sleep).toMatchObject({ status: 'error', data: null });
  expect(result.strain).toMatchObject({ status: 'ready', data: [] });
  expect(whoop.listRecovery).toHaveBeenCalledWith(42, expect.anything());
});
test('calendar drops ended events but retains ongoing and all-day events in its own zone', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-09-19T01:00:00Z'));
  credentials.list.mockResolvedValue([{ provider: 'google_calendar', status: 'active' }]);
  calendar.collectEvents.mockResolvedValue({ calendars: [], events: [
    { id: 'ended', start: '2026-09-18T09:00:00-04:00', end: '2026-09-18T10:00:00-04:00' },
    { id: 'ongoing', start: '2026-09-18T20:00:00-04:00', end: '2026-09-18T22:00:00-04:00' },
    { id: 'all-day', allDay: true, start: '2026-09-18', end: '2026-09-19' },
  ] });
  try { const result = await getDashboard(42, {}); expect(result.calendar.data.events.map(e => e.id)).toEqual(['ongoing', 'all-day']); }
  finally { jest.useRealTimers(); }
});
test('credential lookup failure is not represented as disconnected or empty', async () => {
  credentials.list.mockRejectedValue(new Error('database down'));
  expect((await getDashboard(42, {})).calendar.status).toBe('error');
});
test('family chores uses only the resolved caller’s linked player and strips token material', async () => {
  integration.getStatus.mockResolvedValue({ connected: true });
  integration.getUsableCredentials.mockResolvedValue({ token: 'private-token', playerId: 'p42', baseUrl: 'https://chores.example.com', displayName: 'Person' });
  chores.getChoresToday.mockResolvedValue([{ title: 'Walk dog', completedAt: 'date', privateField: 'secret' }]);
  const result = await getDashboard(42, { googleId: 'caller' });
  expect(integration.getUsableCredentials).toHaveBeenCalledWith(42);
  expect(chores.getChoresToday).toHaveBeenCalledWith('p42', expect.anything());
  expect(JSON.stringify(result)).not.toContain('private-token');
  expect(result.familyChores.data.chores[0]).toEqual({ title: 'Walk dog', completed: true, status: null, dueDate: null });
});
