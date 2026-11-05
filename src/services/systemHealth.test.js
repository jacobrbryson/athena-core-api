jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('./llm', () => ({ status: jest.fn() }));

const pool = require('../helpers/db');
const llm = require('./llm');
const { getHealth } = require('./systemHealth');

const NOW = new Date('2026-09-28T15:00:00Z');
const endpoint = (health) => ({ id: 'openai', tier: 'frontier', health: { calls: 10, errorRate: 0, ...health } });
const serving = { chat: { endpointId: 'openai', tier: 'frontier', model: 'gpt-5.5' } };

// Answers each check's query; a test overrides one table with `tables`.
let tables = {};
function route(sql) {
  if (sql.includes('FROM llm_call_log') && sql.includes('48 HOUR')) return [tables.calls || []];
  if (sql.includes('FROM llm_call_log')) return [tables.refusals || []];
  if (sql.includes('user_credential_audit')) return [tables.audit || []];
  if (sql.includes('metrics FROM self_review_report')) return [tables.report || []];
  if (sql.includes('self_review_report')) return [[{ last: tables.last || '2026-09-28' }]];
  return [[{ 1: 1 }]];
}

beforeEach(() => {
  tables = {};
  pool.query.mockImplementation(async (sql) => route(sql));
  llm.status.mockReturnValue({ serving, orcwood: [], frontier: [endpoint()], recentCalls: [] });
});

const check = (result, id) => result.checks.find((c) => c.id === id);

test('is ok when the database answers, a model serves chat and the nightly review is current', async () => {
  const result = await getHealth(NOW);
  expect(result.status).toBe('ok');
  expect(result.checks.every((c) => c.status === 'ok')).toBe(true);
});

test('is down when no model can answer chat', async () => {
  llm.status.mockReturnValue({ serving: { chat: null }, orcwood: [], frontier: [], recentCalls: [] });
  const result = await getHealth(NOW);
  expect(result.status).toBe('down');
  expect(check(result, 'models').detail).toMatch(/No model/);
});

test('is down when the database is unreachable, and says why', async () => {
  pool.query.mockRejectedValue(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }));
  const result = await getHealth(NOW);
  expect(result.status).toBe('down');
  expect(check(result, 'database').detail).toContain('ECONNREFUSED');
});

test('is degraded when the serving model is failing', async () => {
  llm.status.mockReturnValue({ serving, orcwood: [], frontier: [endpoint({ errorRate: 0.5 })], recentCalls: [] });
  const result = await getHealth(NOW);
  expect(result.status).toBe('degraded');
  expect(check(result, 'models').detail).toContain('50%');
});

test('is degraded when the nightly review has stalled', async () => {
  tables.last = '2026-09-22';
  const result = await getHealth(NOW);
  expect(result.status).toBe('degraded');
  expect(check(result, 'nightly').detail).toContain('6 days ago');
});

const call = (endpoint_id, task, outcome, error, at) => ({ endpoint_id, task, outcome, error, created_at: new Date(at) });
const KEY_401 = 'openai /chat/completions -> HTTP 401 {"error":{"message":"Incorrect API key provided"}}';

test('is down when a provider rejects its key on the latest call, naming the provider and what fails', async () => {
  tables.calls = [
    call('openai', 'dream', 'ok', null, '2026-11-03T08:30:00Z'),
    call('openai', 'dream', 'error', KEY_401, '2026-11-04T08:30:00Z'),
    call('openai', 'image', 'error', KEY_401.replace('chat/completions', 'images/generations'), '2026-11-04T08:31:00Z'),
  ];
  const result = await getHealth(NOW);
  expect(result.status).toBe('down');
  expect(check(result, 'keys').detail).toMatch(/OpenAI is rejecting Athena's API key \(HTTP 401\) since Nov 4: dream and image calls fail/);
});

test('a key that works again on the latest call is ok, and a rate limit is not a key problem', async () => {
  tables.calls = [
    call('openai', 'dream', 'error', KEY_401, '2026-11-04T08:30:00Z'),
    call('openai', 'dream', 'ok', null, '2026-11-05T08:30:00Z'),
    call('gemini', 'chat', 'error', 'gemini -> HTTP 429 quota', '2026-11-05T09:00:00Z'),
  ];
  expect(check(await getHealth(NOW), 'keys').status).toBe('ok');
});

test('is down when most of a task is refused by the access gate, and points at the job identity', async () => {
  tables.refusals = [{ task: 'embed', calls: 54, refused: 37 }, { task: 'chat', calls: 10, refused: 1 }];
  const c = check(await getHealth(NOW), 'identity');
  expect(c.status).toBe('down');
  expect(c.detail).toMatch(/37 of 54 embed calls/);
  expect(c.detail).not.toMatch(/chat/);
  expect(c.detail).toContain('ATHENA_BACKGROUND_GOOGLE_ID');
});

test('a few refusals (a signed-out visitor) are not an outage', async () => {
  tables.refusals = [{ task: 'chat', calls: 4, refused: 4 }];
  expect(check(await getHealth(NOW), 'identity').status).toBe('ok');
});

test('is down while a saved sign-in cannot be decrypted, until it is read successfully again', async () => {
  tables.audit = [
    { provider: 'webull', failed_at: '2026-11-05T08:31:00Z', ok_at: null, why: 'decrypt failed: No key k3 on the keyring; cannot decrypt' },
    { provider: 'google_keep', failed_at: '2026-11-05T08:31:00Z', ok_at: '2026-11-05T10:00:00Z', why: 'decrypt failed: x' },
  ];
  const c = check(await getHealth(NOW), 'credentials');
  expect(c.status).toBe('down');
  expect(c.detail).toMatch(/saved Webull sign-in \(No key k3 on the keyring; cannot decrypt\)/);
  expect(c.detail).not.toMatch(/Keep/);
});

test('flags a nightly step that ran but reported failures, as degraded', async () => {
  tables.report = [{ d: '2026-11-05', metrics: JSON.stringify({ maintenance: {
    news: { ok: true, added: 3 },
    keepGroceries: { ok: true, profiles: 1, failed: 1 },
    dream: { ok: false, error: 'ChatGPT: HTTP 401' },
  } }) }];
  const c = check(await getHealth(NOW), 'nightlySteps');
  expect(c.status).toBe('degraded');
  expect(c.detail).toBe('On 2026-11-05: keepGroceries (1 failed); dream (ChatGPT: HTTP 401).');
});

describe('notifyOwner', () => {
  const { notifyOwner } = require('./systemHealth');
  jest.mock('./notifications/inbox', () => ({ record: jest.fn(async () => ({ created: true })) }));
  const inbox = require('./notifications/inbox');
  const health = { checkedAt: '2026-11-05T15:00:00Z', checks: [
    { id: 'database', label: 'Database', status: 'ok', detail: 'Reachable' },
    { id: 'keys', label: 'Provider keys', status: 'down', detail: 'OpenAI is rejecting…' },
    { id: 'nightlySteps', label: 'Nightly steps', status: 'degraded', detail: 'On …' },
  ] };

  beforeEach(() => inbox.record.mockClear());

  test('records each problem in the inbox, keyed per check per day, linking to /system', async () => {
    pool.query.mockImplementation(async () => [[]]);
    expect(await notifyOwner(health, { profileIds: [7] })).toBe(2);
    expect(inbox.record).toHaveBeenCalledWith(7, expect.objectContaining({
      title: 'Something is broken: Provider keys',
      data: expect.objectContaining({ kind: 'system_health', check: 'keys', uuid: 'health:keys:2026-11-05', url: '/system' }),
    }));
    expect(inbox.record).toHaveBeenCalledWith(7, expect.objectContaining({ title: 'Something needs a look: Nightly steps' }));
  });

  test('does not add a second one while the first is still unacknowledged', async () => {
    pool.query.mockImplementation(async () => [[{ c: 'keys' }]]);
    await notifyOwner(health, { profileIds: [7] });
    expect(inbox.record).toHaveBeenCalledTimes(1);
    expect(inbox.record.mock.calls[0][1].data.check).toBe('nightlySteps');
  });

  test('records nothing when everything is ok', async () => {
    expect(await notifyOwner({ checks: [{ id: 'database', status: 'ok' }] }, { profileIds: [7] })).toBe(0);
    expect(inbox.record).not.toHaveBeenCalled();
  });
});
