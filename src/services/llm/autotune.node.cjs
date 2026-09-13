const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tune, WINDOW_MS } = require('./autotune');
const now = 1_000_000;
const a = { id: 'a', tier: 'orcwood', models: { chat: 'small', vision: 'vision' } };
const b = { id: 'b', tier: 'orcwood', models: { chat: 'large' } };
const f = { id: 'f', tier: 'frontier', models: { chat: 'remote' } };
const calls = (over = {}) => Array.from({ length: 5 }, () => ({
  at: now - 1, task: 'chat', endpointId: 'a', model: 'small', audience: null,
  outcome: 'ok', latencyMs: 9000, ...over,
}));
const ids = result => result.ordered.map(e => e.id);

test('slow and invalid responses prefer same-tier alternatives', () => {
  assert.deepEqual(ids(tune([a, b, f], 'chat', calls(), { now })), ['b', 'a', 'f']);
  const result = tune([a, b, f], 'chat', calls({ outcome: 'invalid', latencyMs: 50 }), { now });
  assert.deepEqual(ids(result), ['b', 'a', 'f']);
  assert.equal(result.diagnostics[0].reason, 'repeated-errors-or-invalid-output');
});
test('never promotes a different tier or invents a candidate', () => {
  assert.deepEqual(ids(tune([a, f], 'chat', calls(), { now })), ['a', 'f']);
  assert.deepEqual(ids(tune([f, a, b], 'chat', calls(), { now })), ['f', 'b', 'a']);
  assert.deepEqual(ids(tune([], 'chat', calls(), { now })), []);
});
test('few, expired, eval, different model/task/audience observations cannot tune routing', () => {
  for (const entries of [calls().slice(0, 4), calls({ at: now - WINDOW_MS }),
    calls({ task: 'eval' }), calls({ model: 'old-model' }), calls({ task: 'vision' }),
    calls({ audience: 'child' })]) {
    assert.deepEqual(ids(tune([a, b], 'chat', entries, { now })), ['a', 'b']);
  }
});
test('healthy responses restore configured order and ties preserve priority', () => {
  assert.deepEqual(ids(tune([a, b], 'chat', calls({ latencyMs: 100 }), { now })), ['a', 'b']);
  assert.deepEqual(ids(tune([a, b], 'chat', calls(), { now: now + WINDOW_MS })), ['a', 'b']);
});
test('router generation and status use the same automatic order', async () => {
  process.env.LLM_ORCWOOD_ENDPOINTS = JSON.stringify([a, b].map(e => ({ ...e, baseUrl: `http://${e.id}/v1` })));
  process.env.LLM_POLICY = 'local-first';
  delete process.env.GEMINI_API_KEY;
  const observed = [];
  const stub = (name, exports) => {
    const filename = require.resolve(name);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
  };
  stub('./adapters/openaiCompat', { generate: async e => {
    observed.push(e.id); return { text: 'ok', model: e.models.chat };
  } });
  stub('./adapters/gemini', {});
  stub('./telemetry', { recent: () => calls({ at: Date.now() - 1 }), recordCall: () => {} });
  const router = require('./router');
  assert.equal(router.status().serving.chat.endpointId, 'b');
  assert.equal((await router.generate({ contents: 'test' })).endpointId, 'b');
  assert.deepEqual(observed, ['b']);
  // Health still takes precedence over performance tuning.
  const health = require('./health');
  for (let i = 0; i < 3; i++) health.reportFailure('b', new Error('offline'));
  assert.equal(router.servingTier('chat').endpointId, 'a');
});
