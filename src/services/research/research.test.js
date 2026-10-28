jest.mock('../../helpers/db', () => ({ query: jest.fn() }));
jest.mock('../connectors/nest', () => ({ storedDevices: jest.fn(), deviceTitle: (d) => d.displayName || `${d.room} thermostat`, PROVIDER: 'nest' }));
jest.mock('../connectors/whoop', () => ({ sleepHistory: jest.fn() }));
jest.mock('../nestHistory', () => ({ between: jest.fn() }));
jest.mock('../credentials', () => ({ status: jest.fn() }));
const thermostat = require('./thermostatSetpoint');
const pace = require('./projectPace');
const research = require('./index');

const f2c = (f) => ((f - 32) * 5) / 9;
const DAY = 86_400_000;
const H = 3_600_000;

describe('thermostat setpoint study', () => {
  test('the house thermostat is not the bedroom one when there are several', () => {
    const den = { name: 'a', room: 'Den' };
    const bed = { name: 'b', room: 'Primary Bedroom' };
    expect(thermostat.houseDevice([bed, den])).toBe(den);
    expect(thermostat.houseDevice([bed])).toBe(bed);
    expect(thermostat.houseDevice([{ name: 'x', notReporting: true }])).toBeNull();
  });

  test('a day pairs hours of heat with the heat setpoint it ran at', () => {
    const from = new Date('2026-12-01T00:00:00Z');
    const readings = [
      { at: new Date(from.getTime() - H), hvac: 'OFF', mode: 'HEAT', heatC: f2c(68) },
      { at: new Date(from.getTime() + 2 * H), hvac: 'HEATING', mode: 'HEAT', heatC: f2c(68) },
      { at: new Date(from.getTime() + 8 * H), hvac: 'OFF', mode: 'HEAT', heatC: f2c(68) },
    ];
    const [day] = thermostat.pairDays(readings, from, 1);
    expect(day.heatingHours).toBeCloseTo(6, 5);
    expect(day.setpointF).toBeCloseTo(68, 5);
  });

  test('days with no setpoint (mode OFF) or no covering reading drop out', () => {
    const from = new Date('2026-12-01T00:00:00Z');
    const off = [{ at: new Date(from.getTime() - H), hvac: 'OFF', mode: 'OFF', heatC: f2c(68) }];
    expect(thermostat.pairDays(off, from, 1)).toEqual([]);
    expect(thermostat.pairDays([], from, 1)).toEqual([]);
  });

  test('says it is gathering below the minimum, never above low confidence when ready', () => {
    const days = (n, set, hours) => Array.from({ length: n }, () => ({ setpointF: set, heatingHours: hours }));
    expect(thermostat.summarize(days(5, 68, 5))).toMatchObject({ status: 'gathering', have: 5, needed: thermostat.MIN_DAYS });
    expect(thermostat.summarize(days(14, 68, 5))).toMatchObject({ status: 'flat' });
    const ready = thermostat.summarize([...days(8, 68, 5), ...days(8, 72, 8)]);
    expect(ready).toMatchObject({ status: 'ready', confidence: 'low' });
    expect(ready.hoursSaved).toBe(3);
    expect(thermostat.sentence(ready, 'Hall thermostat')).toMatch(/3 fewer hours/);
    expect(thermostat.sentence(ready, 'Hall thermostat')).toMatch(/Outdoor temperature isn't accounted for/);
  });
});

describe('project pace study', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  const ago = (d) => new Date(now.getTime() - d * DAY);

  test('gathers until enough steps are finished', () => {
    const r = pace.summarize({ projects: [], doneSteps: [ago(1), ago(2)], sessions: [] }, now);
    expect(r).toMatchObject({ status: 'gathering', have: 2, needed: pace.MIN_STEPS });
    expect(pace.sentence(r)).toMatch(/2 of the 8/);
  });

  test('gives a finish date only to a project with its own finished steps, and flags quiet ones', () => {
    const doneSteps = Array.from({ length: 16 }, (_, i) => ago(i * 3));
    const r = pace.summarize({
      doneSteps,
      sessions: [{ minutes: 60 }, { minutes: 30 }],
      projects: [
        { uuid: 'a', title: 'Deck', open: 4, doneInWindow: 8, lastProgressAt: ago(2) },
        { uuid: 'b', title: 'Shed', open: 3, doneInWindow: 1, lastProgressAt: ago(30) },
        { uuid: 'c', title: 'Done', open: 0, doneInWindow: 5, lastProgressAt: ago(1) },
      ],
    }, now);
    expect(r.status).toBe('ready');
    expect(r.perWeek).toBe(2);
    expect(r.sessions).toEqual({ count: 2, hours: 1.5 });
    const byId = Object.fromEntries(r.projects.map((p) => [p.uuid, p]));
    expect(byId.a.finishOn).toBe('2026-11-24'); // 4 open at 1/week
    expect(byId.b.finishOn).toBeNull();
    expect(byId.b.stalled).toBe(true);
    expect(byId.c.finishOn).toBeNull();
    expect(r.projects[0].uuid).toBe('b'); // stalled first
    expect(pace.sentence(r)).toMatch(/not a promise/);
  });
});

describe('research registry', () => {
  test('a study that throws is reported unavailable without taking the others down', async () => {
    const db = require('../../helpers/db');
    const credentials = require('../credentials');
    db.query.mockRejectedValue(new Error('db down'));
    credentials.status.mockResolvedValue(null);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const studies = await research.list(1);
    expect(studies.map((s) => s.id)).toEqual(['sleep-climate', 'thermostat-setpoint', 'project-pace']);
    expect(studies.find((s) => s.id === 'project-pace').status).toBe('unavailable');
    expect(studies.find((s) => s.id === 'thermostat-setpoint')).toMatchObject({ status: 'needs_source' });
    expect(studies.find((s) => s.id === 'sleep-climate')).toMatchObject({ status: 'needs_source' });
  });
});
