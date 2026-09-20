jest.mock('./llm', () => ({ generateJson: jest.fn() }));
jest.mock('./dashboard', () => ({ cachedDashboard: jest.fn(), getDashboard: jest.fn() }));
jest.mock('./places', () => ({ list: jest.fn(), MAX_PLACES: 25 }));
jest.mock('./homeProjects', () => ({ list: jest.fn() }));
jest.mock('./weather', () => ({ forecast: jest.fn() }));
jest.mock('./connectors/strava', () => ({ listActivities: jest.fn() }));
jest.mock('./consent', () => ({ hasConsentForProfile: jest.fn() }));
jest.mock('./credentials', () => ({ list: jest.fn() }));
jest.mock('./readCache', () => ({ read: (_opts, load) => load(), hash: (parts) => JSON.stringify(parts).length.toString(), invalidate: jest.fn() }));

const llm = require('./llm');
const dashboard = require('./dashboard');
const places = require('./places');
const homeProjects = require('./homeProjects');
const weather = require('./weather');
const strava = require('./connectors/strava');
const consent = require('./consent');
const credentials = require('./credentials');
const rightNow = require('./rightNow');

const MINUTE = 60_000;
const inMinutes = (n) => new Date(Date.now() + n * MINUTE).toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

/** An open park, 3 miles away, of the kind this feature was built for. */
const park = (over = {}) => ({
  uuid: 'park-1', label: 'Lake Norman State Park', url: 'https://www.ncparks.gov/x', host: 'ncparks.gov',
  activity: 'mountain biking', distanceMi: 3, latitude: 35.6, longitude: -80.9, enabled: true,
  state: 'open', statusText: 'Open', weatherDependent: true, hours: { sun: [['07:00', '19:30']] },
  lastCheckedAt: new Date().toISOString(), consecutiveFailures: 0, lastError: null,
  now: { openNow: true, why: 'Open', closesAt: '7:30 PM', closesInMinutes: 300, todaysHours: ['7:00 AM – 7:30 PM'] },
  ...over,
});

const project = (over = {}) => ({
  uuid: 'proj-1', title: 'Rehang the garage shelves', detail: null, area: 'Garage',
  status: 'todo', priority: 'normal', effortMinutes: 120, indoor: true, costEstimate: null,
  dueDate: null, blockedOn: null, source: 'manual', ...over,
});

beforeEach(() => {
  jest.resetAllMocks();
  dashboard.cachedDashboard.mockReturnValue(null);
  dashboard.getDashboard.mockResolvedValue({ calendar: { status: 'ready', data: { events: [], timeZone: 'America/New_York' } } });
  places.list.mockResolvedValue([]);
  homeProjects.list.mockResolvedValue([]);
  weather.forecast.mockResolvedValue(null);
  credentials.list.mockResolvedValue([]);
  consent.hasConsentForProfile.mockResolvedValue(false);
});

describe('openWindow', () => {
  it('runs to the next timed event', () => {
    const w = rightNow.openWindow([{ title: 'Piano', start: inMinutes(240), end: inMinutes(300), allDay: false }]);
    expect(w.freeMinutes).toBeGreaterThan(235);
    expect(w.nextEvent.title).toBe('Piano');
  });

  it('ignores all-day entries, which do not stop anyone riding', () => {
    const w = rightNow.openWindow([
      { title: "Someone's birthday", start: '2026-09-20', end: '2026-09-21', allDay: true },
      { title: 'Piano', start: inMinutes(120), end: inMinutes(180), allDay: false },
    ]);
    expect(w.nextEvent.title).toBe('Piano');
  });

  it('closes the window while an event is under way', () => {
    const w = rightNow.openWindow([{ title: 'Standup', start: inMinutes(-10), end: inMinutes(20), allDay: false }]);
    expect(w.freeMinutes).toBe(0);
    expect(w.busyWith).toBe('Standup');
  });

  it('is open-ended when nothing is scheduled', () => {
    expect(rightNow.openWindow([]).freeMinutes).toBeNull();
  });
});

describe('rhythmFor', () => {
  const sundays = (weeks) =>
    Array.from({ length: weeks }, (_, i) => {
      const at = new Date();
      at.setDate(at.getDate() - at.getDay() - i * 7);
      return { type: 'MountainBikeRide', name: 'Trail ride', start: at.toISOString() };
    });

  it('counts a weekly habit and notices it has not happened this week', () => {
    const matcher = rightNow.matcherFor('mountain biking');
    // Skip the current week so the most recent ride is eight days back.
    const rhythm = rightNow.rhythmFor(sundays(9).slice(1), matcher);
    expect(rhythm.activity).toBe('mountain biking');
    expect(rhythm.perWeek).toBeGreaterThan(0.5);
    expect(rhythm.thisWeek).toBe(0);
    expect(rhythm.daysSince).toBeGreaterThanOrEqual(6);
  });

  it('does not claim a usual day from two rides', () => {
    const matcher = rightNow.matcherFor('mountain biking');
    expect(rightNow.rhythmFor(sundays(2), matcher).usualDay).toBeNull();
  });

  it('is null for an activity with no history', () => {
    expect(rightNow.rhythmFor([{ type: 'Run', start: daysAgo(2) }], rightNow.matcherFor('mountain biking'))).toBeNull();
  });
});

describe('placeCandidates', () => {
  const window = { freeMinutes: 300, busyWith: null, nextEvent: { title: 'Piano', inMinutes: 300 } };

  it('offers an open place that fits the window', () => {
    const { candidates, ruledOut } = rightNow.placeCandidates([park()], window, new Map(), new Map());
    expect(ruledOut).toHaveLength(0);
    expect(candidates[0].id).toBe('place:park-1');
    // 300 minus the round trip. Three miles is under the ten-minute floor the
    // drive estimate never goes below, so it is 20 minutes, not six.
    expect(candidates[0].usableMinutes).toBe(280);
  });

  it('never offers a place whose status is unknown', () => {
    const unknown = park({ state: 'unknown', now: { openNow: null, why: 'Hours unknown', todaysHours: [] } });
    const { candidates, ruledOut } = rightNow.placeCandidates([unknown], window, new Map(), new Map());
    expect(candidates).toHaveLength(0);
    expect(ruledOut[0].reason).toMatch(/doesn't say/);
  });

  it('rules out a weather-dependent place when the forecast is wet, and says so', () => {
    const forecasts = new Map([['park-1', { outdoorOutlook: 'wet', now: { shortForecast: 'Heavy Rain' } }]]);
    const { candidates, ruledOut } = rightNow.placeCandidates([park()], window, forecasts, new Map());
    expect(candidates).toHaveLength(0);
    expect(ruledOut[0].reason).toMatch(/weather dependent/);
  });

  it('keeps a weather-dependent place when the forecast is fine', () => {
    const forecasts = new Map([['park-1', { outdoorOutlook: 'fine', now: { shortForecast: 'Sunny' } }]]);
    const { candidates } = rightNow.placeCandidates([park()], window, forecasts, new Map());
    expect(candidates).toHaveLength(1);
  });

  it('rules out a place there is no longer time to reach', () => {
    const closing = park({ now: { openNow: true, why: 'Open', closesAt: '7:30 PM', closesInMinutes: 40, todaysHours: [] } });
    const { candidates, ruledOut } = rightNow.placeCandidates([closing], window, new Map(), new Map());
    expect(candidates).toHaveLength(0);
    expect(ruledOut[0].reason).toMatch(/on the ground/);
  });

  it('scores an overdue habit above one already kept this week', () => {
    const overdue = new Map([['mountain biking', { activity: 'mountain biking', perWeek: 1, thisWeek: 0, daysSince: 9, isUsualDayToday: true }]]);
    const kept = new Map([['mountain biking', { activity: 'mountain biking', perWeek: 1, thisWeek: 2, daysSince: 1, isUsualDayToday: false }]]);
    const high = rightNow.placeCandidates([park()], window, new Map(), overdue).candidates[0].score;
    const low = rightNow.placeCandidates([park()], window, new Map(), kept).candidates[0].score;
    expect(high).toBeGreaterThan(low);
  });
});

describe('projectCandidates', () => {
  const window = { freeMinutes: 120, busyWith: null, nextEvent: null };

  it('prefers indoor work when it is wet', () => {
    const list = [project({ uuid: 'in', indoor: true }), project({ uuid: 'out', title: 'Stain the deck', indoor: false })];
    const ranked = rightNow.projectCandidates(list, window, true);
    expect(ranked[0].id).toBe('project:in');
  });

  it('marks a project that does not fit the window', () => {
    const ranked = rightNow.projectCandidates([project({ effortMinutes: 480 })], window, false);
    expect(ranked[0].fitsWindow).toBe(false);
  });

  it('leaves finished and blocked work out', () => {
    const list = [project({ uuid: 'a', status: 'done' }), project({ uuid: 'b', status: 'blocked' })];
    expect(rightNow.projectCandidates(list, window, false)).toHaveLength(0);
  });
});

describe('getRightNow', () => {
  it('asks for nothing when there is nothing to suggest', async () => {
    const result = await rightNow.getRightNow(7, {});
    expect(result.lead).toBeNull();
    expect(result.reason).toMatch(/Add a place/);
    expect(llm.generateJson).not.toHaveBeenCalled();
  });

  it('leads with the park, and says why, when Athena answers', async () => {
    places.list.mockResolvedValue([park()]);
    homeProjects.list.mockResolvedValue([project()]);
    dashboard.getDashboard.mockResolvedValue({
      calendar: { status: 'ready', data: { timeZone: 'America/New_York', events: [{ title: 'Piano lessons', start: inMinutes(280), end: inMinutes(340), allDay: false }] } },
    });
    llm.generateJson.mockResolvedValue({
      data: {
        headline: 'Ride Lake Norman before piano',
        lead: { id: 'place:park-1', why: "You ride most Sundays and haven't this week; gates close at 7:30." },
        alternate: { id: 'project:proj-1', why: 'Two hours would clear the garage shelves.' },
      },
      model: 'test-model',
    });

    const result = await rightNow.getRightNow(7, {});
    expect(result.source).toBe('athena');
    expect(result.lead.id).toBe('place:park-1');
    expect(result.lead.url).toBe('https://www.ncparks.gov/x');
    expect(result.alternates[0].id).toBe('project:proj-1');
    expect(result.window.nextEvent.title).toBe('Piano lessons');
  });

  it('falls back to its own ranking when the model is down', async () => {
    places.list.mockResolvedValue([park()]);
    homeProjects.list.mockResolvedValue([project()]);
    llm.generateJson.mockRejectedValue(new Error('no model available'));

    const result = await rightNow.getRightNow(7, {});
    expect(result.source).toBe('default');
    expect(result.lead).not.toBeNull();
    expect(result.headline).toContain('Lake Norman State Park');
  });

  it('discards a suggestion the model invented', async () => {
    places.list.mockResolvedValue([park()]);
    llm.generateJson.mockImplementation(async ({ check }) => {
      // The router rejects a failed check; this stands in for that contract.
      const problem = check({ headline: 'Go to the beach', lead: { id: 'place:made-up', why: '' } });
      if (problem !== true) throw new Error(String(problem));
      return { data: {}, model: 'test-model' };
    });

    const result = await rightNow.getRightNow(7, {});
    expect(result.source).toBe('default');
    expect(result.lead.id).toBe('place:park-1');
  });

  it('says what ruled the park out rather than going quiet', async () => {
    places.list.mockResolvedValue([park({ state: 'closed', statusText: 'Closed for storm damage', now: { openNow: false, why: 'Closed for storm damage', todaysHours: [] } })]);
    const result = await rightNow.getRightNow(7, {});
    expect(result.lead).toBeNull();
    expect(result.reason).toMatch(/storm damage/);
    expect(result.ruledOut[0].title).toBe('Lake Norman State Park');
  });

  it('stays out of the way while they are in a meeting', async () => {
    places.list.mockResolvedValue([park()]);
    dashboard.getDashboard.mockResolvedValue({
      calendar: { status: 'ready', data: { timeZone: 'America/New_York', events: [{ title: 'Piano lessons', start: inMinutes(-5), end: inMinutes(40), allDay: false }] } },
    });
    const result = await rightNow.getRightNow(7, {});
    expect(result.lead).toBeNull();
    expect(result.reason).toMatch(/Piano lessons/);
  });

  it('never reads Strava without an active link and health consent', async () => {
    places.list.mockResolvedValue([park()]);
    credentials.list.mockResolvedValue([{ provider: 'strava', status: 'active' }]);
    consent.hasConsentForProfile.mockResolvedValue(false);
    llm.generateJson.mockRejectedValue(new Error('offline'));

    await rightNow.getRightNow(7, {});
    expect(strava.listActivities).not.toHaveBeenCalled();
  });

  it('reads Strava once the link and consent are both there', async () => {
    places.list.mockResolvedValue([park()]);
    credentials.list.mockResolvedValue([{ provider: 'strava', status: 'active' }]);
    consent.hasConsentForProfile.mockResolvedValue(true);
    strava.listActivities.mockResolvedValue([{ type: 'MountainBikeRide', name: 'Trail ride', start: daysAgo(8) }]);
    llm.generateJson.mockRejectedValue(new Error('offline'));

    await rightNow.getRightNow(7, {});
    expect(strava.listActivities).toHaveBeenCalledWith(7, expect.objectContaining({ days: 90 }));
  });
});
