jest.mock('../../helpers/db', () => ({ query: jest.fn(), getConnection: jest.fn() }));

const shape = require('./shape');
const { rank, forRightNow } = require('./rank');
const { importFile, validate, reviews, toInput } = require('./importFile');
const projects = require('./index');

describe('shape.normalizeProject', () => {
  it('keeps what a patch does not mention, and clears what it nulls', () => {
    const existing = shape.toProject({
      uuid: 'u', title: 'Paint office', goal: 'One room, fully', kind: null, status: 'ready', waiting_on: null,
      priority: 3, starts_on: null, ends_on: null, hard_deadline: '2026-11-30', metric_source: null, metric_start: null,
      metric_target: null, metric_unit: null, effort_min_minutes: 360, effort_max_minutes: 360, effort_note: '1 Saturday',
      indoor: 1, cost_diy_low: 50, cost_diy_high: 150, cost_pro_low: null, cost_pro_high: null, cost_note: null,
      value_note: null, season_months: null, conditions: '[]', serves: '["enjoyment"]', involves_children: 0,
      visibility: 'private', source: 'import', import_key: 'paint-office',
    });
    const f = shape.normalizeProject({ priority: 4, hardDeadline: null, effort: { max: 480 } }, existing);
    expect(f.title).toBe('Paint office');
    expect(f.goal).toBe('One room, fully');
    expect(f.priority).toBe(4);
    expect(f.hard_deadline).toBeNull();
    expect(f.effort_min_minutes).toBe(360);
    expect(f.effort_max_minutes).toBe(480);
    expect(f.indoor).toBe(true);
    expect(f.serves).toEqual(['enjoyment']);
  });

  it('never turns "nobody said" into an answer', () => {
    expect(shape.normalizeProject({ title: 'x' }).indoor).toBeNull();
  });

  it('only keeps a waiting reason while waiting', () => {
    expect(shape.normalizeProject({ title: 'x', status: 'waiting', waitingOn: 'rain' }).waiting_on).toBe('rain');
    expect(shape.normalizeProject({ title: 'x', status: 'ready', waitingOn: 'rain' }).waiting_on).toBeNull();
  });

  it('rejects backwards ranges, bad levels, unknown conditions and household sharing', () => {
    expect(() => shape.normalizeProject({ title: 'x', cost: { diyLow: 500, diyHigh: 100 } })).toThrow(/low end/);
    expect(() => shape.normalizeProject({ title: 'x', priority: 9 })).toThrow(/1 \(low\) to 5/);
    expect(() => shape.normalizeProject({ title: 'x', conditions: ['sunny'] })).toThrow(/unknown sunny/);
    expect(() => shape.normalizeProject({ title: 'x', visibility: 'household' })).toThrow(/not available yet/);
    expect(() => shape.normalizeProject({})).toThrow(/needs a title/);
  });

  it('round-trips season months through the bitmask, and all twelve means any time', () => {
    const f = shape.normalizeProject({ title: 'x', seasonMonths: [10, 9, 11, 9] });
    expect(f.season_months).toEqual([9, 10, 11]);
    expect(shape.maskToMonths(shape.monthsToMask(f.season_months))).toEqual([9, 10, 11]);
    expect(shape.normalizeProject({ title: 'x', seasonMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }).season_months).toBeNull();
  });
});

describe('shape.normalizeAreas', () => {
  it('defaults a new project to Home', () => {
    expect(shape.normalizeAreas({})).toEqual([{ area: 'home', primary: true }]);
  });
  it('has exactly one primary, and adds the primary if it was not listed', () => {
    expect(shape.normalizeAreas({ areas: ['family', 'health'], primaryArea: 'community' })).toEqual([
      { area: 'community', primary: true }, { area: 'family', primary: false }, { area: 'health', primary: false },
    ]);
  });
  it('leaves areas alone on a patch that does not mention them', () => {
    expect(shape.normalizeAreas({}, { areas: [{ area: 'work', primary: true }], primaryArea: 'work' })).toBeNull();
  });
  it('rejects an area that is not a section', () => {
    expect(() => shape.normalizeAreas({ areas: ['garage'] })).toThrow(/unknown garage/);
  });
});

describe('links and derived status', () => {
  it('finds a cycle through the existing edges', () => {
    const edges = [[1, 2], [2, 3]];
    expect(shape.wouldCycle(edges, 3, 1)).toBe(true);
    expect(shape.wouldCycle(edges, 1, 3)).toBe(false);
    expect(shape.wouldCycle(edges, 4, 4)).toBe(true);
  });

  it('is blocked while a dependency is open; a done or dropped one holds nothing up', () => {
    const p = { status: 'ready' };
    expect(shape.effectiveStatus(p, [{ status: 'active' }])).toBe('blocked');
    expect(shape.effectiveStatus(p, [{ status: 'done' }, { status: 'dropped' }])).toBe('ready');
    expect(shape.effectiveStatus({ status: 'done' }, [{ status: 'idea' }])).toBe('done');
  });
});

describe('plan tools (0096)', () => {
  it('keeps code, revision, pin and budget unless mentioned, and refuses a budget above its ceiling', () => {
    const existing = { title: 'Side yard', refCode: 'HOME-SIDEYARD-2026-001', revision: '1.1', pinnedAt: '2026-10-25T00:00:00Z', budget: { working: 3200, ceiling: 4200, note: null } };
    const kept = shape.normalizeProject({ revision: '1.2' }, existing);
    expect(kept).toMatchObject({ ref_code: 'HOME-SIDEYARD-2026-001', revision: '1.2', pinned_at: '2026-10-25T00:00:00Z', budget_working: 3200, budget_ceiling: 4200 });
    expect(shape.normalizeProject({ pinned: false }, existing).pinned_at).toBeNull();
    expect(shape.normalizeProject({ pinned: true }, existing).pinned_at).toBeInstanceOf(Date);
    expect(() => shape.normalizeProject({ budget: { working: '$5,000' } }, existing)).toThrow(/above the approval ceiling/);
  });

  it('normalises specs and materials, and keeps the kind on a patch', () => {
    expect(shape.normalizeItem({ kind: 'material', label: 'Fence posts', value: '5–7', unit: 'posts', costLow: '150', costHigh: 260 }))
      .toMatchObject({ kind: 'material', status: 'pending', value: '5–7', cost_low: 150, cost_high: 260 });
    const existing = shape.toItem({ uuid: 'i', kind: 'spec', ordinal: 0, label: 'Gate location', value: null, unit: null, status: 'pending', cost_low: null, cost_high: null, note: null, confirmed_at: null });
    expect(shape.normalizeItem({ kind: undefined, status: 'confirmed' }, existing)).toMatchObject({ kind: 'spec', label: 'Gate location', status: 'confirmed' });
    expect(() => shape.normalizeItem({ label: 'x', status: 'maybe' })).toThrow(/Item status/);
    expect(() => shape.normalizeItem({ label: ' ' })).toThrow(/label/);
  });

  it('writes the new columns only when a patch mentions them', async () => {
    const pool = require('../../helpers/db');
    const conn = { beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(), query: jest.fn() };
    pool.getConnection.mockResolvedValue(conn);
    const row = { id: 7, uuid: 'p', title: 'Side yard', status: 'planning', priority: 4, conditions: '[]', serves: '[]', visibility: 'private' };
    conn.query.mockImplementation(async (sql) => (sql.startsWith('SELECT * FROM athena_project') ? [[row]] : sql.startsWith('SELECT area') ? [[]] : [{}]));
    await projects.update(1, 'p', { priority: 5 });
    const plain = conn.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE athena_project'))[0];
    expect(plain).not.toMatch(/pinned_at|budget_working|ref_code/);
    conn.query.mockClear();
    await projects.update(1, 'p', { pinned: true, budget: { working: 3200 } });
    const plan = conn.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE athena_project'))[0];
    expect(plan).toMatch(/pinned_at = \?/);
    expect(plan).toMatch(/budget_working = \?, budget_ceiling = \?, budget_note = \?/);
    expect(plan).not.toMatch(/ref_code/);
  });
});

describe('rank', () => {
  const base = { status: 'ready', effectiveStatus: 'ready', priority: 3, primaryArea: 'home', serves: [], hardDeadline: null };
  const now = Date.parse('2026-10-13T12:00:00Z');

  it('puts an open critical concern and a near deadline above a cosmetic job', () => {
    const all = {
      projects: [
        { ...base, uuid: 'paint', serves: ['beautification'] },
        { ...base, uuid: 'crawl', serves: ['health'] },
        { ...base, uuid: 'insulate', hardDeadline: '2026-11-01' },
      ],
      concerns: [{ status: 'open', severity: 5, projects: ['crawl'] }],
      charters: [{ area: 'home', weights: { health: 10, beautification: 6 } }],
    };
    const r = rank(all, now);
    expect(r.get('crawl').score).toBeGreaterThan(r.get('paint').score);
    expect(r.get('insulate').why).toContain('deadline in 19 days');
  });

  it('gives closed work no rank and drops a resolved concern', () => {
    const all = {
      projects: [{ ...base, uuid: 'a', status: 'done', effectiveStatus: 'done' }, { ...base, uuid: 'b' }],
      concerns: [{ status: 'resolved', severity: 5, projects: ['b'] }],
      charters: [],
    };
    const r = rank(all, now);
    expect(r.get('a').score).toBeNull();
    expect(r.get('b').score).toBe(30);
  });

  it('puts a project moved to the front above everything, newest pin first, and not once it is closed', () => {
    const all = {
      projects: [
        { ...base, uuid: 'crit', priority: 5, hardDeadline: '2026-10-14' },
        { ...base, uuid: 'old', priority: 1, pinnedAt: '2026-10-01T00:00:00Z' },
        { ...base, uuid: 'new', priority: 1, pinnedAt: '2026-10-25T00:00:00Z' },
        { ...base, uuid: 'shut', status: 'done', effectiveStatus: 'done', pinnedAt: '2026-10-26T00:00:00Z' },
      ],
      concerns: [], charters: [],
    };
    const r = rank(all, now);
    expect(r.get('new').score).toBeGreaterThan(r.get('old').score);
    expect(r.get('old').score).toBeGreaterThan(r.get('crit').score);
    expect(r.get('new').why[0]).toBe('you moved it to the front');
    expect(r.get('shut').score).toBeNull();
  });

  it('maps for Right Now with the old scorer shape', () => {
    const [m] = forRightNow([{ ...base, uuid: 'x', title: 'X', priority: 5, effort: { min: 60, max: 120 }, indoor: null, conditions: [] }], new Date('2026-10-13'));
    expect(m).toMatchObject({ uuid: 'x', status: 'todo', priority: 'high', effortMinutes: 60, indoor: null });
  });
});

describe('importFile', () => {
  const file = {
    area: 'home',
    charter: { body: 'Safety first.', weights: { safety: 10 } },
    concerns: [{ key: 'c1', title: 'Musty crawlspace', severity: 5, projects: ['inspect'] }],
    projects: [
      { key: 'prog', kind: 'program', title: 'Water', priority: 5, status: 'active' },
      { key: 'inspect', title: 'Inspect', status: 'ready', contributes_to: ['prog'], cost: { diy: [20, 75] }, months: [9, 10], steps: [{ title: 'PPE' }] },
      { key: 'seal', title: 'Encapsulate', depends_on: [{ key: 'inspect', note: 'diagnose first' }] },
    ],
  };

  it('validates the file and maps ranges and months', () => {
    expect(validate(file)).toBe('home');
    const input = toInput(file.projects[1], 'home');
    expect(input.cost).toMatchObject({ diyLow: 20, diyHigh: 75, proLow: null });
    expect(input.seasonMonths).toEqual([9, 10]);
    expect(input.primaryArea).toBe('home');
  });

  it('names every problem, not just the first', () => {
    const broken = { area: 'home', projects: [{ key: 'a', title: 'A', depends_on: [{ key: 'nope' }] }, { key: 'a', title: '' }] };
    expect(() => validate(broken)).toThrow(/duplicate key a[\s\S]*needs a title[\s\S]*needs unknown nope/);
  });

  it('refuses to apply while a review question remains', async () => {
    const withReview = { ...file, projects: [...file.projects, { key: 'q', title: 'Q', review: 'Which one?' }] };
    expect(reviews(withReview)).toEqual(['q: Which one?']);
    await expect(importFile(1, withReview, { apply: true })).rejects.toThrow(/Answer the 1 review/);
  });

  it('dry-runs without writing, and skips what already exists', async () => {
    const db = { query: jest.fn() };
    jest.spyOn(projects, 'withTx').mockImplementation((fn) => fn(db));
    db.query
      .mockResolvedValueOnce([[{ id: 9, uuid: 'u-prog', import_key: 'prog' }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ n: 1 }]]);
    const s = await importFile(1, file, { apply: false });
    expect(s.applied).toBe(false);
    expect(s.projects.skipped).toEqual(['prog']);
    expect(s.projects.created).toEqual(['inspect', 'seal']);
    expect(s.charter).toBe('kept (already set)');
    expect(s.steps).toBe(1);
    expect(db.query).toHaveBeenCalledTimes(3);
  });
});
