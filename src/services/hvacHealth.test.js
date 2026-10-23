jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('./credentials', () => ({ status: jest.fn() }));
jest.mock('./connectors/nest', () => ({ storedDevices: jest.fn(), deviceTitle: (d) => d.room, PROVIDER: 'nest' }));
const hvac = require('./hvacHealth');

const NOW = new Date('2026-12-10T12:00:00Z');
const t = (min) => new Date(NOW.getTime() + min * 60_000);
const f2c = (f) => ((f - 32) * 5) / 9;
const r = (min, f, hvacState, heatF = 70) => ({ at: t(min), temperatureC: f2c(f), hvac: hvacState, heatC: f2c(heatF) });

test('a long run that barely moved the room, still short of its setpoint, is not keeping up', () => {
  const runs = hvac.runsOf([r(-90, 64, 'HEATING'), r(-30, 64.2, 'HEATING')], { now: NOW, current: { hvac: 'HEATING', temperatureC: f2c(64.3) } });
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ open: true, hvac: 'HEATING' });
  const [issue] = hvac.judge(runs, { now: NOW });
  expect(issue).toMatchObject({ kind: 'not_keeping_up', stillRunning: true });
  expect(issue.evidence).toMatchObject({ minutes: 90, startF: 64, nowF: 64.3, targetF: 70 });
});

test('a run that reached its setpoint says nothing', () => {
  const runs = hvac.runsOf([r(-90, 66, 'HEATING'), r(-40, 70, 'OFF')], { now: NOW, current: { hvac: 'OFF' } });
  expect(runs[0]).toMatchObject({ minutes: 50 });
  expect(hvac.judge(runs, { now: NOW })).toEqual([]);
});

test('a short run is too short to judge', () => {
  const runs = hvac.runsOf([r(-30, 66, 'HEATING')], { now: NOW, current: { hvac: 'HEATING', temperatureC: f2c(66) } });
  expect(hvac.judge(runs, { now: NOW })).toEqual([]);
});

test('runs far slower than that thermostat usually manages are slower than usual', () => {
  const readings = [];
  // Five older runs at 4°F an hour…
  for (let d = 5; d < 10; d += 1) {
    const s = -d * 24 * 60;
    readings.push(r(s, 66, 'HEATING'), r(s + 30, 68, 'OFF'));
  }
  // …and two recent ones at 1°F an hour that still got there.
  readings.push(r(-600, 67, 'HEATING'), r(-480, 69, 'OFF'), r(-300, 67, 'HEATING'), r(-180, 69, 'OFF'));
  const issues = hvac.judge(hvac.runsOf(readings, { now: NOW, current: { hvac: 'OFF' } }), { now: NOW });
  expect(issues).toEqual([expect.objectContaining({ kind: 'slower_than_usual', hvac: 'HEATING' })]);
  expect(issues[0].evidence).toMatchObject({ usualFPerHour: 4, recentFPerHour: 1, usualRuns: 5, recentRuns: 2 });
  expect(hvac.describe({ ...issues[0], title: 'Den thermostat' })).toMatch(/outdoor temperature isn't accounted for/);
});

test('cooling is judged in its own direction', () => {
  const runs = hvac.runsOf(
    [{ at: t(-120), temperatureC: f2c(80), hvac: 'COOLING', coolC: f2c(74) }],
    { now: NOW, current: { hvac: 'COOLING', temperatureC: f2c(80.2) } }
  );
  expect(hvac.judge(runs, { now: NOW })[0]).toMatchObject({ kind: 'not_keeping_up', hvac: 'COOLING' });
});
