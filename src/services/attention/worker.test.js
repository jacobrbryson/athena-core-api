jest.mock('../../helpers/db', () => ({ query: jest.fn() }));
jest.mock('../../security/access', () => ({ assertModelAccess: jest.fn(), context: { run: jest.fn((_ctx, fn) => fn()) } }));
jest.mock('./store', () => ({
  hash: value => JSON.stringify(value), latest: jest.fn(), complete: jest.fn(),
  dueWatches: jest.fn(), claim: jest.fn(), nextEvent: jest.fn(), retry: jest.fn(), syncPage: jest.fn(), release: jest.fn(),
}));
jest.mock('./interpret', () => ({ VERSION: 'test', interpret: jest.fn() }));
jest.mock('./whoop', () => ({ authorize: jest.fn(), observe: jest.fn(), context: jest.fn(), sync: jest.fn() }));
const pool = require('../../helpers/db');
const access = require('../../security/access');
const store = require('./store');
const interpreter = require('./interpret');
const source = require('./whoop');
const { processEvent, runOnce } = require('./worker');
const w = { id: 1, profile_id: 42, source: 'whoop_workout', enabled: 1, next_sync_at: new Date(Date.now() + 86400000), lease_token: 'lease' };
const event = { id: 2, resource_id: 'workout-1', event_type: 'workout.updated', attempts: 1 };
const observation = { id: 'workout-1', state: 'present', label: 'Ultimate frisbee' };
const ctx = { evidence: [{ id: 'observation' }, { id: 'calendar:1' }], calendarCredential: 'calendar-1' };

beforeEach(() => {
  jest.resetAllMocks();
  access.context.run.mockImplementation((_ctx, fn) => fn());
  access.assertModelAccess.mockResolvedValue();
  source.authorize.mockResolvedValue({ calendarCredential: 'calendar-1' });
  source.observe.mockResolvedValue(observation); source.context.mockResolvedValue(ctx);
  interpreter.interpret.mockResolvedValue({ label: 'Coaching', status: 'likely', evidence_ids: ['calendar:1'] });
  store.complete.mockResolvedValue(); store.release.mockResolvedValue(); store.retry.mockResolvedValue();
  pool.query.mockResolvedValue([[{ google_id: 'owner-42' }]]);
});
test('preserves provider report separately from inference and source evidence', async () => {
  await processEvent(w, event, source);
  const result = store.complete.mock.calls[0][2];
  expect(result.payload.observation.label).toBe('Ultimate frisbee');
  expect(result.payload.interpretation.label).toBe('Coaching');
  expect(result.payload.context).toEqual(ctx);
});
test('unchanged observation AND context avoids another model call, but changed calendar causes reconsideration', async () => {
  store.latest.mockResolvedValue({ observation_hash: store.hash(observation), context_hash: store.hash({ version: 'test', context: ctx }) });
  await processEvent(w, event, source);
  expect(interpreter.interpret).not.toHaveBeenCalled();
  expect(store.complete).toHaveBeenCalledWith(w, event, { disposition: 'unchanged' });
  source.context.mockResolvedValue({ ...ctx, evidence: [{ id: 'calendar:changed' }] });
  await processEvent(w, event, source);
  expect(interpreter.interpret).toHaveBeenCalledTimes(1);
});
test('human correction of the same source revision is authoritative without a model relabeling it', async () => {
  source.context.mockResolvedValue({ ...ctx, ownCorrection: { uuid: 'correction-1', label: 'Soccer coaching', note: 'I was coaching.' } });
  await processEvent(w, event, source);
  expect(interpreter.interpret).not.toHaveBeenCalled();
  expect(store.complete.mock.calls[0][2].payload.interpretation).toMatchObject({ status: 'confirmed', label: 'Soccer coaching' });
});
test('provider/calendar failure creates no invented interpretation', async () => {
  source.context.mockRejectedValue(new Error('Calendar unavailable'));
  await expect(processEvent(w, event, source)).rejects.toThrow('Calendar');
  expect(interpreter.interpret).not.toHaveBeenCalled(); expect(store.complete).not.toHaveBeenCalled();
});
test('revocation during a model call prevents publication', async () => {
  source.authorize.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Revoked'));
  await expect(processEvent(w, event, source)).rejects.toThrow('Revoked');
  expect(store.complete).not.toHaveBeenCalled();
});
test('source removal is recorded without model invention', async () => {
  source.observe.mockResolvedValue({ id: event.resource_id, state: 'deleted', label: null });
  await processEvent(w, event, source);
  expect(interpreter.interpret).not.toHaveBeenCalled();
  expect(store.complete.mock.calls[0][2]).toMatchObject({ disposition: 'deleted' });
});
test('an expired worker cannot publish after a replacement worker claims the lease', async () => {
  store.complete.mockRejectedValue(Object.assign(new Error('expired'), { code: 'lease_lost' }));
  await expect(processEvent(w, event, source)).rejects.toMatchObject({ code: 'lease_lost' });
});
test('worker attributes model work to the actual profile and retries failed work durably', async () => {
  store.dueWatches.mockResolvedValue([w]); store.claim.mockResolvedValue(w);
  store.nextEvent.mockResolvedValueOnce(event).mockResolvedValueOnce(null);
  source.observe.mockRejectedValue(new Error('provider timeout with private data'));
  const report = await runOnce();
  expect(access.context.run).toHaveBeenCalledWith({ identity: { google_id: 'owner-42' } }, expect.any(Function));
  expect(store.retry).toHaveBeenCalledWith(w, event, 'processing_failed');
  expect(store.release).toHaveBeenCalledWith(w, null);
  expect(report.retried).toBe(1);
});
test('missing/revoked access never falls through to the background owner identity', async () => {
  pool.query.mockResolvedValue([[]]); access.assertModelAccess.mockRejectedValue(new Error('denied'));
  store.dueWatches.mockResolvedValue([w]); store.claim.mockResolvedValue(w);
  await runOnce();
  expect(access.context.run).toHaveBeenCalledWith({ identity: null }, expect.any(Function));
  expect(source.observe).not.toHaveBeenCalled(); expect(interpreter.interpret).not.toHaveBeenCalled();
});
