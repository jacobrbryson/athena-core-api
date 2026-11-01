const fs = require('node:fs');
const path = require('node:path');

jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('uuid', () => ({ v4: () => 'uuid' }));

/**
 * The service can't require runner.js, so this controller hands it an adapter.
 * Everything else mocks that adapter, which is how Approve shipped calling a
 * function it didn't have: every plan answered "Guardians is unavailable".
 */
describe('the runner handed to the missions service', () => {
  const missions = require('../services/guardianMissions');
  const setRunner = jest.spyOn(missions, 'setRunner');
  require('./guardianMissions');
  const adapter = setRunner.mock.calls[0][0];

  const source = fs.readFileSync(path.join(__dirname, '../services/guardianMissions/index.js'), 'utf8');
  const called = [...new Set([...source.matchAll(/\brunner\.(\w+)\(/g)].map((m) => m[1]))];

  it('finds the calls it checks', () => {
    expect(called).toEqual(expect.arrayContaining(['storyProblems', 'onApproved']));
  });

  it.each(called)('has %s', (name) => {
    expect(typeof adapter[name]).toBe('function');
  });
});
