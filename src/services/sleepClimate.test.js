jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('./connectors/nest', () => ({ storedDevices: jest.fn(), deviceTitle: (d) => d.displayName || `${d.room} thermostat`, PROVIDER: 'nest' }));
jest.mock('./connectors/whoop', () => ({ sleepHistory: jest.fn() }));
jest.mock('./nestHistory', () => ({ between: jest.fn() }));
jest.mock('./credentials', () => ({ status: jest.fn() }));
const nest = require('./connectors/nest');
const whoop = require('./connectors/whoop');
const history = require('./nestHistory');
const credentials = require('./credentials');
const sc = require('./sleepClimate');

const f2c = (f) => ((f - 32) * 5) / 9;
const H = 3_600_000;

test('the bedroom is the chosen thermostat, else one named for it, else the only one', () => {
  const den = { name: 'a', room: 'Den' };
  const bed = { name: 'b', room: 'Primary Bedroom' };
  expect(sc.bedroomDevice([den, bed])).toBe(bed);
  expect(sc.bedroomDevice([den, bed, { name: 'c', room: 'Up', sleepDevice: true }]).name).toBe('c');
  expect(sc.bedroomDevice([den])).toBe(den);
  expect(sc.bedroomDevice([den, { name: 'x', room: 'Kitchen' }])).toBeNull();
});

test('the night mean is time-weighted: each reading holds until the next', () => {
  const s = new Date('2026-12-10T04:00:00Z');
  const e = new Date(s.getTime() + 8 * H);
  const readings = [
    { at: new Date(s.getTime() - H), temperatureC: 20 },
    { at: new Date(s.getTime() + 6 * H), temperatureC: 18 },
  ];
  expect(sc.windowMean(readings, s, e, 'temperatureC')).toBeCloseTo((20 * 6 + 18 * 2) / 8);
  // Nothing describing the start of the night: dropped, not guessed.
  expect(sc.windowMean([{ at: new Date(s.getTime() + 4 * H), temperatureC: 20 }], s, e, 'temperatureC')).toBeNull();
});

function nightsAt(temps, recoveryFor) {
  const sleeps = [];
  const recoveries = [];
  const readings = [];
  temps.forEach((f, i) => {
    const start = new Date(Date.UTC(2026, 10, 1 + i, 4));
    sleeps.push({ id: `s${i}`, date: start.toISOString().slice(0, 10), start: start.toISOString(), end: new Date(start.getTime() + 8 * H).toISOString(), nap: false, sleep_performance_percent: 80 });
    recoveries.push({ sleep_id: `s${i}`, recovery_score: recoveryFor(f) });
    readings.push({ at: new Date(start.getTime() - 30 * 60_000), temperatureC: f2c(f) });
  });
  return { sleeps, recoveries, readings };
}

test('fewer than fourteen paired nights is still gathering', () => {
  const { sleeps, recoveries, readings } = nightsAt([66, 67, 70], () => 60);
  const out = sc.summarize(sc.pairNights(sleeps, recoveries, readings));
  expect(out).toEqual({ status: 'gathering', nights: 3, needed: 14 });
  expect(sc.sentence(out, 'Bedroom thermostat')).toMatch(/3 of the 14 nights/);
});

test('the best band is found and worded as a pattern, never a cause', () => {
  const temps = [66, 66, 67, 67, 66, 67, 70, 70, 71, 71, 70, 71, 72, 72, 73, 73];
  const { sleeps, recoveries, readings } = nightsAt(temps, (f) => (f < 68 ? 80 : 60));
  const out = sc.summarize(sc.pairNights(sleeps, recoveries, readings));
  expect(out.status).toBe('ready');
  expect(out.metric).toBe('avgRecovery');
  expect(out.best).toMatchObject({ fromF: 66, toF: 67, nights: 6, avgRecovery: 80, delta: 20 });
  expect(sc.sentence(out, 'Bedroom thermostat')).toMatch(/66–67°F.*20 points higher.*not proof of cause/);
});

test('naps never count as nights', () => {
  const { sleeps, recoveries, readings } = nightsAt([66], () => 70);
  sleeps[0].nap = true;
  expect(sc.pairNights(sleeps, recoveries, readings)).toEqual([]);
});

test('nothing is read unless both Nest and WHOOP are linked', async () => {
  sc._reset();
  credentials.status.mockImplementation(async (_p, provider) => (provider === 'nest' ? { status: 'active' } : null));
  expect(await sc.analyze(1)).toEqual({ status: 'not_linked' });
  expect(nest.storedDevices).not.toHaveBeenCalled();
  expect(whoop.sleepHistory).not.toHaveBeenCalled();
  expect(history.between).not.toHaveBeenCalled();
});
