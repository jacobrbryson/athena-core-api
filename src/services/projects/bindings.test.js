jest.mock('../../helpers/db', () => ({ query: jest.fn() }));

const b = require('./bindings');

describe('normalizeSelector', () => {
  it('accepts the three sources and nothing else', () => {
    expect(b.normalizeSelector('health_metric', { metric: 'Weight' })).toEqual({ metric: 'weight' });
    expect(b.normalizeSelector('whoop_sport', { sports: ['Weightlifting', ' running ', 'Weightlifting'] })).toEqual({ sports: ['weightlifting', 'running'] });
    expect(b.normalizeSelector('calendar_match', { titleAny: ['U10', 'U12'] })).toEqual({ titleAny: ['U10', 'U12'] });
    expect(() => b.normalizeSelector('jira_epic', {})).toThrow(/Source must be/);
    expect(() => b.normalizeSelector('health_metric', { metric: 'heart rate' })).toThrow(/Metric must be/);
    expect(() => b.normalizeSelector('calendar_match', { titleAny: [] })).toThrow(/at least one/);
  });
});

describe('weight progress', () => {
  // +20 lb over five months: 2026-10-05 → 2027-03-05.
  const project = { metric_unit: 'lb', metric_start: 180, metric_target: 200, starts_on: '2026-10-05', ends_on: '2027-03-05' };
  const lb = (v) => v * 0.45359237;
  const weighIns = [ // newest first, as vesync returns them
    { at: '2026-10-13T07:00:00Z', weight_kg: lb(182.4) },
    { at: '2026-10-12T07:00:00Z', weight_kg: lb(181.6) },
    { at: '2026-10-12T06:00:00Z', weight_kg: lb(185) }, // a second reading that day — the newer one wins
    { at: '2026-10-10T07:00:00Z', weight_kg: lb(181.0) },
    { at: '2026-09-20T07:00:00Z', weight_kg: lb(179.0) }, // before the project started
  ];

  it('keeps one value per day in the project unit, oldest first', () => {
    const series = b.dailyWeights(weighIns, 'lb');
    expect(series.map((p) => p.date)).toEqual(['2026-09-20', '2026-10-10', '2026-10-12', '2026-10-13']);
    expect(series.find((p) => p.date === '2026-10-12').value).toBe(181.6);
  });

  it('draws the straight line from start to target across the dates', () => {
    expect(b.planned({ start: 180, target: 200, startsOn: '2026-10-05', endsOn: '2027-03-05' }, '2026-10-05')).toBe(180);
    expect(b.planned({ start: 180, target: 200, startsOn: '2026-10-05', endsOn: '2027-03-05' }, '2027-06-01')).toBe(200);
    expect(b.planned({ start: 180, target: null, startsOn: '2026-10-05', endsOn: '2027-03-05' }, '2026-11-01')).toBeNull();
  });

  it('compares the last week against the plan', () => {
    const p = b.weightProgress(project, b.dailyWeights(weighIns, 'lb'), '2026-10-13');
    expect(p.actual).toBe(181.7); // mean of 181.0, 181.6, 182.4
    expect(p.planned).toBe(181.1); // 8 days into 151
    expect(p.gap).toBe(0.6);
    expect(p.verdict).toBe('on_track');
    expect(p.change).toBe(1.7);
    expect(p.series[0].date).toBe('2026-10-10'); // nothing from before the start
  });

  it('calls it behind for a gain goal that is lagging, and ahead for a cut that is ahead', () => {
    const lagging = b.weightProgress({ ...project, metric_start: 178 }, [{ date: '2026-12-01', value: 180 }], '2026-12-01');
    expect(lagging.verdict).toBe('behind');
    const cut = b.weightProgress({ ...project, metric_start: 200, metric_target: 180 }, [{ date: '2026-12-01', value: 185 }], '2026-12-01');
    expect(cut.verdict).toBe('ahead');
  });
});

describe('workouts and calendar', () => {
  it('counts the bound sports per week', () => {
    const today = new Date().toISOString().slice(0, 10);
    const w = b.workoutProgress([
      { date: today, sport: 'Weightlifting', minutes: 60, strain: 9 },
      { date: today, sport: 'Mountain Biking', minutes: 90, strain: 14 },
      { date: today, sport: 'Yoga', minutes: 30, strain: 3 },
    ], ['weightlifting', 'mountain'], '2026-10-05');
    expect(w.total).toBe(2);
    expect(w.thisWeek).toBe(2);
    expect(w.weekly).toHaveLength(8);
    expect(w.bySport).toEqual({ Weightlifting: 1, 'Mountain Biking': 1 });
  });

  it('matches calendar events by any word in the title', () => {
    const events = [{ title: 'U10 vs Hawks', start: 's' }, { title: 'Dentist', start: 's' }, { title: 'u12 practice', start: 's' }];
    expect(b.calendarMatches(events, ['U10', 'U12']).map((e) => e.title)).toEqual(['U10 vs Hawks', 'u12 practice']);
  });

  it('puts Monday at the start of the week', () => {
    expect(b.weekKey('2026-10-14')).toBe('2026-10-12');
    expect(b.weekKey('2026-10-12')).toBe('2026-10-12');
    expect(b.weekKey('2026-10-18')).toBe('2026-10-12');
  });
});
