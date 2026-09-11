const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const dbPath = require.resolve('../helpers/db');
let queries, grant, registry, savedEmail, requested, dbFailure, deviceActive;
const identity = { google_id: 'google-123', email: 'guardian@example.test', email_verified: true };
const pool = { query: async (sql, args = []) => {
  queries.push([sql, args]);
  if (dbFailure) throw new Error('database unavailable');
  if (sql.startsWith('SELECT google_id FROM athena_access_grant')) return [grant && args[0] === identity.google_id ? [{ google_id: identity.google_id }] : []];
  if (sql.startsWith('SELECT id FROM guardian_credential')) return [registry && args[0] === '12345678' ? [{ id: 1 }] : []];
  if (sql.startsWith('SELECT g.id')) return [registry && (args[0] || savedEmail) === identity.email ? [{ id: 1 }] : []];
  if (sql.startsWith('SELECT p.google_id FROM paired_device')) return [deviceActive ? [{ google_id: identity.google_id }] : []];
  if (sql.startsWith('SELECT google_id FROM profile')) return [[{ google_id: null }]];
  if (sql.startsWith('INSERT INTO athena_access_identity')) {
    if (args[1]) savedEmail = args[1];
    if (sql.includes('VALUES (?, ?, NOW())')) requested = true;
    return [{ affectedRows: 1 }];
  }
  if (sql.startsWith('SELECT requested_at')) return [[{ requested_at: requested ? new Date() : null }]];
  if (sql.startsWith('INSERT INTO athena_access_audit')) return [{ affectedRows: 1 }];
  throw new Error(`Unexpected query: ${sql}`);
} };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
const access = require('./access');
const gemini = require('../services/llm/adapters/gemini');
const local = require('../services/llm/adapters/openaiCompat');
const { accessBoundary } = require('../middleware/access');
const jwt = require('jsonwebtoken');
const config = require('../config');
config.JWT_SECRET = 'test-only-secret';
const endpoint = { id: 'fake', models: { chat: 'chat', tools: 'tools', embed: 'embed', tts: 'tts' } };
let calls;
beforeEach(() => {
  queries = []; grant = false; registry = false; savedEmail = null; requested = false; dbFailure = false; deviceActive = true; calls = [];
  delete process.env.ATHENA_BACKGROUND_GOOGLE_ID;
  gemini._setClient({ models: {
    generateContent: async (args) => { calls.push(args); return { text: 'OK' }; },
    embedContent: async (args) => { calls.push(args); return { embeddings: [{ values: [1] }] }; },
  } });
});

test('unknown, anonymous, unverified and self-assigned guardian roles do not authorize', async () => {
  assert.equal(await access.allowed(null), false);
  assert.equal(await access.allowed(identity), false);
  registry = true;
  assert.equal(await access.allowed({ ...identity, email_verified: false, is_guardian: true }), false);
  assert.equal(await access.allowed({ google_id: 'unknown', email: identity.email, is_guardian: true }), false);
});

test('verified registry identity and active issued Guardian credentials authorize', async () => {
  registry = true;
  assert.equal(await access.allowed(identity), true);
  assert.equal(await access.allowed({ kind: 'guardian', guardian_id: '12345678' }), true);
  assert.equal(await access.allowed({ kind: 'guardian', guardian_id: '87654321' }), false);
  assert.ok(queries.some(([sql]) => sql.includes("participant_type = 'guardian'") && sql.includes('is_active = 1')));
});

test('explicit grants bind to exact Google subject and are checked live', async () => {
  grant = true;
  assert.equal(await access.allowed(identity), true);
  assert.equal(await access.allowed({ ...identity, google_id: 'different' }), false);
  grant = false;
  assert.equal(await access.allowed(identity), false);
});

test('visits are logged; requesting twice never grants access', async () => {
  assert.deepEqual(await access.recordVisit(identity), { allowed: false, requested: false });
  assert.deepEqual(await access.recordVisit(identity, true), { allowed: false, requested: true });
  assert.deepEqual(await access.recordVisit(identity, true), { allowed: false, requested: true });
  assert.equal(calls.length, 0);
  assert.equal(queries.filter(([sql]) => sql.startsWith('INSERT INTO athena_access_audit')).length, 3);
  assert.equal(queries.some(([sql]) => /INSERT INTO athena_access_grant|UPDATE athena_access_grant/.test(sql)), false);
});

test('paired devices require current owner authorization and are denied after device revocation', async () => {
  const device = { kind: 'device', deviceId: 7, profileId: 42 };
  assert.equal(await access.allowed(device), false);
  grant = true;
  assert.equal(await access.allowed(device), true);
  deviceActive = false;
  assert.equal(await access.allowed(device), false);
  assert.equal(await access.allowed({ kind: 'child', profile_uuid: 'child' }), false);
});

test('every provider operation denies before any SDK or HTTP call', async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => { calls.push('fetch'); throw new Error('must not dispatch'); };
  try {
    for (const operation of [
      () => gemini.generate(endpoint, { task: 'chat', contents: 'hi' }),
      () => gemini.raw(endpoint, []), () => gemini.embed(endpoint, ['hi']), () => gemini.speech(endpoint, 'hi'),
      () => local.generate(endpoint, { task: 'chat', contents: 'hi' }), () => local.embed(endpoint, ['hi']),
    ]) await assert.rejects(operation, { code: 'ACCESS_REQUIRED' });
    assert.equal(calls.length, 0);
  } finally { global.fetch = previousFetch; }
});

test('approved generation carries mission; revocation blocks subsequent calls', async () => {
  grant = true;
  await access.context.run({ identity }, async () => {
    await gemini.generate(endpoint, { task: 'chat', contents: 'hi' });
    assert.equal(calls[0].config.systemInstruction, require('./mission').CORE_MISSION);
    await gemini.raw(endpoint, [], { systemInstruction: 'Replace mission' });
    assert.equal(calls[1].config.systemInstruction, require('./mission').CORE_MISSION);
    grant = false;
    await assert.rejects(() => gemini.embed(endpoint, ['hi']), { code: 'ACCESS_REQUIRED' });
    assert.equal(calls.length, 2);
  });
});

test('database failure fails closed before provider dispatch', async () => {
  dbFailure = true;
  await access.context.run({ identity }, async () => {
    await assert.rejects(() => gemini.generate(endpoint, { task: 'chat', contents: 'hi' }), /database unavailable/);
  });
  assert.equal(calls.length, 0);
});

test('background work needs an approved identity and cannot override denied request context', async () => {
  process.env.ATHENA_BACKGROUND_GOOGLE_ID = identity.google_id;
  await assert.rejects(access.assertModelAccess, { code: 'ACCESS_REQUIRED' });
  grant = true;
  await access.assertModelAccess();
  await access.context.run({ identity: null }, () => assert.rejects(access.assertModelAccess, { code: 'ACCESS_REQUIRED' }));
});

test('simultaneous authorized and unauthorized asynchronous work stays isolated', async () => {
  grant = true;
  const outcomes = await Promise.allSettled([
    access.context.run({ identity }, () => gemini.embed(endpoint, ['allowed'])),
    access.context.run({ identity: { google_id: 'stranger' } }, () => gemini.embed(endpoint, ['denied'])),
  ]);
  assert.deepEqual(outcomes.map((o) => o.status), ['fulfilled', 'rejected']);
  assert.equal(calls.length, 1);
});

async function boundary(path, method = 'GET', claims = identity) {
  const req = { path, method, ip: '127.0.0.1', headers: claims ? { authorization: `Bearer ${jwt.sign({ ...claims, client_ip: '127.0.0.1' }, config.JWT_SECRET)}` } : {} };
  const result = { status: 200, next: false };
  const res = { set() {}, status(s) { result.status = s; return this; }, json(body) { result.body = body; return this; } };
  await accessBoundary(req, res, () => { result.next = true; });
  return result;
}

test('HTTP access requests stay available while alternate protected routes stay locked', async () => {
  assert.equal((await boundary('/access')).body.allowed, false);
  assert.equal((await boundary('/access', 'POST')).body.requested, true);
  for (const path of ['/message', '/speech', '/memory/photos', '/vision/describe', '/devices/pairing-code', '/profile', '/integrations/family-chores/suggest-chores']) {
    const response = await boundary(path, 'POST');
    assert.equal(response.status, 403, path);
    assert.equal(response.next, false, path);
  }
  assert.equal((await boundary('/message', 'POST', null)).status, 401);
  grant = true;
  assert.equal((await boundary('/message', 'POST')).next, true);
  dbFailure = true;
  assert.equal((await boundary('/message', 'POST')).status, 503);
});
