jest.mock('./llm', () => ({ generateJson: jest.fn() }));
jest.mock('./dashboard', () => ({ cachedDashboard: jest.fn(), getDashboard: jest.fn() }));
jest.mock('./places', () => ({ list: jest.fn(), MAX_PLACES: 25 }));
jest.mock('./homeProjects', () => ({ list: jest.fn() }));
jest.mock('./weather', () => ({ forecast: jest.fn() }));
jest.mock('./pulsepoint/watch', () => ({ listPlaces: jest.fn() }));
jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('./readCache', () => ({ read: (_opts, load) => load(), hash: (parts) => JSON.stringify(parts).length.toString(), invalidate: jest.fn() }));

const llm = require('./llm');
const dashboard = require('./dashboard');
const places = require('./places');
const homeProjects = require('./homeProjects');
const weather = require('./weather');
const incidents = require('./pulsepoint/watch');
const pool = require('../helpers/db');
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
  incidents.listPlaces.mockResolvedValue([]);
  pool.query.mockResolvedValue([[]]);
});

afterEach(() => jest.useRealTimers());

/** A Wednesday at 10am in New York: daylight, and inside working hours. */
const WEDNESDAY_MORNING = new Date('2026-09-23T14:00:00Z');
/** The same Wednesday at 10pm: dark, and nobody wants a ticket. */
const WEDNESDAY_NIGHT = new Date('2026-09-24T02:00:00Z');


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
    expect(result.reason).toMatch(/Tell me a goal/);
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
});

describe('goalCandidates', () => {
  it('names a goal from memory and skips one already on the project list', () => {
    const rows = [
      { uuid: 'g1', memory_key: 'learn_spanish', memory_value: 'Wants to be conversational by summer', updated_at: daysAgo(2) },
      { uuid: 'g2', memory_key: 'rehang the garage shelves', memory_value: '', updated_at: daysAgo(2) },
    ];
    const goals = rightNow.goalCandidates(rows, ['Rehang the garage shelves']);
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({ id: 'goal:g1', kind: 'goal', title: 'Learn spanish', detail: 'Wants to be conversational by summer' });
  });
});

describe('workCandidates', () => {
  const window = { freeMinutes: 120, busyWith: null, nextEvent: null };
  const issues = [
    { key: 'A-1', title: 'Backlog thing', status: 'To Do' },
    { key: 'A-2', title: 'Half done', status: 'In Progress', url: 'https://x.atlassian.net/browse/A-2' },
  ];

  it('puts work in progress first during working hours', () => {
    expect(rightNow.workCandidates(issues, window, { workHours: true })[0].id).toBe('work:A-2');
  });

  it('offers no tickets outside working hours', () => {
    expect(rightNow.workCandidates(issues, window, { workHours: false })).toHaveLength(0);
  });
});

describe('restCandidate', () => {
  it('suggests taking it easy on a red recovery', () => {
    expect(rightNow.restCandidate({ recoveryScore: 22, hoursAsleepLastNight: 7 })).toMatchObject({ kind: 'rest' });
  });

  it('says nothing on a normal day', () => {
    expect(rightNow.restCandidate({ recoveryScore: 70, hoursAsleepLastNight: 7.5 })).toBeNull();
  });
});

describe('getRightNow with no lists at all', () => {
  it('falls back to a goal they told Athena about', async () => {
    pool.query.mockResolvedValue([[{ uuid: 'g1', memory_key: 'learn_spanish', memory_value: 'Conversational by summer', updated_at: daysAgo(1) }]]);
    llm.generateJson.mockRejectedValue(new Error('offline'));

    const result = await rightNow.getRightNow(7, {});
    expect(result.lead).toMatchObject({ kind: 'goal', title: 'Learn spanish' });
  });

  it('leads with rest on a red recovery, ahead of an open place', async () => {
    jest.useFakeTimers({ now: WEDNESDAY_MORNING, doNotFake: ['nextTick', 'setImmediate'] });
    places.list.mockResolvedValue([park()]);
    dashboard.getDashboard.mockResolvedValue({
      calendar: { status: 'ready', data: { events: [], timeZone: 'America/New_York' } },
      recovery: { data: [{ state: 'SCORED', recovery_score: 18 }] },
    });
    llm.generateJson.mockRejectedValue(new Error('offline'));

    const result = await rightNow.getRightNow(7, {});
    expect(result.lead.kind).toBe('rest');
    expect(result.alternates[0].kind).toBe('place');
  });

  it('offers an in-progress ticket on a weekday morning, and not at night', async () => {
    const summary = {
      calendar: { status: 'ready', data: { events: [], timeZone: 'America/New_York' } },
      jira: { data: { issues: [{ key: 'ATH-9', title: 'Ship the thing', status: 'In Progress' }] } },
    };
    dashboard.getDashboard.mockResolvedValue(summary);
    llm.generateJson.mockRejectedValue(new Error('offline'));

    jest.useFakeTimers({ now: WEDNESDAY_MORNING, doNotFake: ['nextTick', 'setImmediate'] });
    expect((await rightNow.getRightNow(7, {})).lead).toMatchObject({ kind: 'work', issueKey: 'ATH-9' });

    jest.setSystemTime(WEDNESDAY_NIGHT);
    expect((await rightNow.getRightNow(7, {})).lead).toBeNull();
  });
});
