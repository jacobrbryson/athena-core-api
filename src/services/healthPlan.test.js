jest.mock('../helpers/db', () => ({ query: jest.fn(), getConnection: jest.fn() }));
jest.mock('./workoutHistory', () => ({ list: jest.fn() }));
const db = require('../helpers/db');
const workoutHistory = require('./workoutHistory');
const healthPlan = require('./healthPlan');

beforeEach(() => jest.clearAllMocks());

test('weeks run Monday to Sunday', () => {
  const { weekdayOf, mondayOf } = healthPlan._test;
  expect(weekdayOf('2026-10-12')).toBe(0); // Monday
  expect(weekdayOf('2026-10-18')).toBe(6); // Sunday
  expect(mondayOf('2026-10-14')).toBe('2026-10-12');
  expect(mondayOf('2026-10-18')).toBe('2026-10-12');
});

test('a recorded workout of the matching kind ticks the session; a mark wins over it', async () => {
  db.query
    .mockResolvedValueOnce([[{ id: 7, uuid: 'prog', name: 'Hypertrophy', goal: null, starts_on: '2026-10-05', weeks: 22 }]])
    .mockResolvedValueOnce([[
      { id: 1, uuid: 'mon', weekday: 0, kind: 'gym', title: 'Gym A', focus: 'Upper', detail: null, exercises: '[]' },
      { id: 2, uuid: 'tue', weekday: 1, kind: 'recovery', title: 'Recovery', focus: 'Active', detail: null, exercises: null },
      { id: 3, uuid: 'wed', weekday: 2, kind: 'gym', title: 'Gym B', focus: 'Lower', detail: null, exercises: '["Leg press","RDL"]' },
      { id: 4, uuid: 'thu', weekday: 3, kind: 'run', title: 'Run', focus: null, detail: '3–5 miles', exercises: null },
    ]])
    .mockResolvedValueOnce([[{ session_id: 4, done_on: '2026-10-15', status: 'skipped' }]]);
  workoutHistory.list.mockResolvedValue([
    { date: '2026-10-12', sport: 'weightlifting_msk', minutes: 60, strain: 11 },
    { date: '2026-10-15', sport: 'running', minutes: 30, strain: 9 },
  ]);
  const p = await healthPlan.program(42, { today: '2026-10-13' });
  expect(p.week_number).toBe(2);
  expect(p.sessions.map(s => [s.uuid, s.date, s.status])).toEqual([
    ['mon', '2026-10-12', 'done'],
    ['tue', '2026-10-13', 'today'],
    ['wed', '2026-10-14', 'planned'],
    ['thu', '2026-10-15', 'skipped'],
  ]);
  expect(p.sessions[2].exercises).toEqual(['Leg press', 'RDL']);
  // Every read is the caller's own rows.
  expect(db.query.mock.calls[0][1]).toEqual([42]);
  expect(db.query.mock.calls[2][1][1]).toBe(42);
});

test('marking a session checks it belongs to the caller before writing', async () => {
  db.query.mockResolvedValueOnce([[]]);
  await expect(healthPlan.markSession(42, 'someone-elses', { date: '2026-10-13', status: 'done' })).resolves.toBe(false);
  expect(db.query).toHaveBeenCalledTimes(1);
  expect(db.query.mock.calls[0][0]).toContain('p.profile_id = ?');
  await expect(healthPlan.markSession(42, 'x', { date: 'soon', status: 'done' })).rejects.toThrow('date');
  await expect(healthPlan.markSession(42, 'x', { date: '2026-10-13', status: 'crushed' })).rejects.toThrow('Status');
});

test('a program is validated before anything is written', async () => {
  await expect(healthPlan.saveProgram(42, { name: 'X', weeks: 8, sessions: [] })).rejects.toThrow('at least one session');
  await expect(healthPlan.saveProgram(42, { name: 'X', weeks: 8, sessions: [{ weekday: 7, kind: 'gym', title: 'A' }] })).rejects.toThrow('weekday');
  await expect(healthPlan.saveProgram(42, { name: 'X', weeks: 8, sessions: [{ weekday: 0, kind: 'nap', title: 'A' }] })).rejects.toThrow('kind');
  await expect(healthPlan.saveProgram(42, { name: '', weeks: 8, sessions: [{ weekday: 0, kind: 'gym', title: 'A' }] })).rejects.toThrow('name');
  expect(db.getConnection).not.toHaveBeenCalled();
});

test('saving a program ends the old one inside the same transaction', async () => {
  const conn = { beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(), query: jest.fn() };
  conn.query.mockResolvedValueOnce([[{ id: 3 }]]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([{ insertId: 9 }]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]);
  db.getConnection.mockResolvedValue(conn);
  await healthPlan.saveProgram(42, { name: 'Hypertrophy', weeks: 22, starts_on: '2026-10-05', sessions: [{ weekday: 0, kind: 'gym', title: 'Gym A', exercises: ['Bench', 5] }] });
  expect(conn.query.mock.calls[1][0]).toContain('SET ended_at');
  expect(conn.query.mock.calls[1][1]).toEqual([42]);
  const rows = conn.query.mock.calls[3][1][0];
  expect(rows[0][1]).toBe(9);
  expect(JSON.parse(rows[0][7])).toEqual(['Bench']);
  // This week's ticks follow the edit onto the new sessions, the caller's only.
  expect(conn.query.mock.calls[4][0]).toContain('INSERT IGNORE INTO training_log');
  expect(conn.query.mock.calls[4][1]).toEqual([9, [3], 42]);
  expect(conn.commit).toHaveBeenCalled();
  expect(conn.release).toHaveBeenCalled();
});

test('food entries are bounded, and a water-only entry names itself', async () => {
  await expect(healthPlan.addEntry(42, { label: 'Shake' })).rejects.toThrow('calories');
  await expect(healthPlan.addEntry(42, { label: 'Feast', calories: 90000 })).rejects.toThrow('calories must be');
  db.query.mockResolvedValueOnce([{}]);
  const water = await healthPlan.addEntry(42, { eaten_on: '2026-10-13', water_oz: 16 });
  expect(water.label).toBe('Water');
  expect(db.query.mock.calls[0][1].slice(1, 4)).toEqual([42, '2026-10-13', 'Water']);
});

test('nutrition totals sum the day and fill the week with empty days', async () => {
  db.query.mockResolvedValueOnce([[
    { uuid: 'a', eaten_on: '2026-10-13', label: 'Eggs', calories: 300, protein_g: '24.0', carbs_g: '2.0', fat_g: '20.0', water_oz: null, created_at: new Date() },
    { uuid: 'b', eaten_on: '2026-10-13', label: 'Shake', calories: 200, protein_g: '40.5', carbs_g: null, fat_g: null, water_oz: '12.0', created_at: new Date() },
    { uuid: 'c', eaten_on: '2026-10-10', label: 'Pasta', calories: 800, protein_g: null, carbs_g: null, fat_g: null, water_oz: null, created_at: new Date() },
  ]]).mockResolvedValueOnce([[{ uuid: 'fav-1', label: 'shake', calories: 200, protein_g: '40.5', carbs_g: null, fat_g: null, water_oz: null, serving: null, barcode: null }]]);
  const n = await healthPlan.nutrition(42, { today: '2026-10-13' });
  expect(n.totals).toEqual({ calories: 500, protein_g: 64.5, carbs_g: 2, fat_g: 20, water_oz: 12 });
  expect(n.entries).toHaveLength(2);
  expect(n.days).toHaveLength(7);
  expect(n.days[0].date).toBe('2026-10-07');
  expect(n.days.find(d => d.date === '2026-10-10').totals.calories).toBe(800);
  expect(n.days.find(d => d.date === '2026-10-11').logged).toBe(false);
  // A favorite with the same name (any case) stars the entry; an entry without one isn't.
  expect(n.entries.map(e => [e.label, e.favorite, e.source])).toEqual([['Eggs', null, 'manual'], ['Shake', 'fav-1', 'manual']]);
  expect(n.favorites.map(f => f.uuid)).toEqual(['fav-1']);
});

test('the manual form\'s favorite box stars the food as it logs it', async () => {
  db.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([[]]);
  const e = await healthPlan.addEntry(42, { eaten_on: '2026-10-13', label: 'Greek yogurt', calories: 150, protein_g: 20, source: 'nonsense', favorite: true });
  expect(e.source).toBe('manual');
  expect(db.query.mock.calls[0][1].slice(-3)).toEqual(['manual', null, null]);
  expect(db.query.mock.calls[1][0]).toContain('INSERT INTO nutrition_favorite');
  expect(db.query.mock.calls[1][1].slice(1, 4)).toEqual([42, 'Greek yogurt', 150]);
});

test('correcting an entry is the caller\'s own, and carries to its favorite', async () => {
  db.query.mockResolvedValueOnce([[]]);
  await expect(healthPlan.updateEntry(42, 'someone-elses', { label: 'X', calories: 1 })).resolves.toBe(false);
  expect(db.query.mock.calls[0][1]).toEqual(['someone-elses', 42]);
  db.query.mockReset();
  db.query
    .mockResolvedValueOnce([[{ id: 5, label: 'Granola bar', barcode: '0123456789012' }]])
    .mockResolvedValueOnce([{}])
    .mockResolvedValueOnce([[{ uuid: 'fav-9', label: 'granola bar', calories: 900 }]])
    .mockResolvedValueOnce([{}]);
  await expect(healthPlan.updateEntry(42, 'mine', { label: 'Granola bar', calories: 190, protein_g: 4 })).resolves.toBe(true);
  expect(db.query.mock.calls[1][1]).toEqual(['Granola bar', 190, 4, null, null, null, null, 5]);
  expect(db.query.mock.calls[3][0]).toContain('UPDATE IGNORE nutrition_favorite');
  expect(db.query.mock.calls[3][1].slice(-2)).toEqual(['fav-9', 42]);
});

test('a favorite logs one serving only for its owner', async () => {
  db.query.mockResolvedValueOnce([[]]);
  await expect(healthPlan.logFavorite(42, 'not-mine')).resolves.toBeNull();
  db.query.mockResolvedValueOnce([[{ uuid: 'fav-1', label: 'Shake', calories: 200, protein_g: '40', carbs_g: null, fat_g: null, water_oz: null, serving: '1 scoop', barcode: null }]]).mockResolvedValueOnce([{}]);
  const e = await healthPlan.logFavorite(42, 'fav-1', { eaten_on: '2026-10-13' });
  expect(e).toMatchObject({ label: 'Shake', calories: 200, protein_g: 40, serving: '1 scoop', source: 'favorite' });
});

test('targets reject an upside-down weight range', async () => {
  await expect(healthPlan.saveTargets(42, { target_weight_low_kg: 91, target_weight_high_kg: 88 })).rejects.toThrow('low end');
  await expect(healthPlan.saveTargets(42, { protein_g: 5000 })).rejects.toThrow('protein g');
  expect(db.query).not.toHaveBeenCalled();
});

test('a server without the tables reads as nothing set up', async () => {
  db.query.mockRejectedValue(Object.assign(new Error('no table'), { code: 'ER_NO_SUCH_TABLE' }));
  await expect(healthPlan.overview(42, { today: '2026-10-13' })).resolves.toEqual({ program: null, targets: null, nutrition: null });
});

test('chat grounding is adult-only and topic-gated', async () => {
  await expect(healthPlan.buildContext(42, { message: 'how much protein today?', audience: 'child' })).resolves.toBeNull();
  await expect(healthPlan.buildContext(42, { message: 'tell me a joke', audience: 'adult' })).resolves.toBeNull();
  expect(db.query).not.toHaveBeenCalled();
  expect(healthPlan.matches("what's tomorrow's workout")).toBe(true);
});
