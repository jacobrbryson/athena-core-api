jest.mock('../llm', () => ({ generateJson: jest.fn() }));
const llm = require('../llm');
const { validate, interpret } = require('./interpret');
const evidence = [{ id: 'observation' }, { id: 'calendar:1' }, { id: 'memory:1' }];
const answer = { status: 'likely', label: 'Coaching', reason: 'Calendar and confirmed history support coaching; attendance is not certain.', evidence_ids: ['observation', 'calendar:1', 'memory:1'], alternatives: ['A different activity during the same time'] };
beforeEach(() => jest.clearAllMocks());

test('rejects invented evidence, claimed human confirmation and executable output', () => {
  expect(validate(answer, evidence)).toBeNull();
  expect(validate({ ...answer, evidence_ids: ['invented'] }, evidence)).toBeTruthy();
  expect(validate({ ...answer, status: 'confirmed' }, evidence)).toBeTruthy();
  expect(validate({ ...answer, action: { id: 'create_calendar_event' } }, evidence)).toBeTruthy();
});
test('changing a source label requires contextual support and passes the guarded adapter contract', async () => {
  llm.generateJson.mockImplementation(async opts => {
    expect(opts.task).toBe('json'); expect(opts.audience).toBe('adult');
    expect(opts.check({ ...answer, evidence_ids: ['observation'] })).toMatch(/contextual/);
    expect(opts.check(answer)).toBeNull();
    return { data: answer, model: 'fake', endpointId: 'test' };
  });
  const observation = { source: 'whoop_workout', label: 'Ultimate frisbee' };
  expect(await interpret(observation, evidence)).toMatchObject({ label: 'Coaching', status: 'likely', model: 'fake' });
  expect(observation.label).toBe('Ultimate frisbee');
});
test('same interpreter contract accepts another domain without a sport-specific rule', async () => {
  const result = { status: 'likely', label: 'School supplies needed Friday', reason: 'The school message names glue and Friday.', evidence_ids: ['observation', 'email:1'], alternatives: [] };
  llm.generateJson.mockImplementation(async opts => { expect(opts.check(result)).toBeNull(); return { data: result, model: 'fake', endpointId: 'test' }; });
  const output = await interpret({ source: 'email', label: 'Class newsletter' }, [{ id: 'observation' }, { id: 'email:1' }]);
  expect(output.label).toBe(result.label);
});
