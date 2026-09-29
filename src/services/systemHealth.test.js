jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('./llm', () => ({ status: jest.fn() }));

const pool = require('../helpers/db');
const llm = require('./llm');
const { getHealth } = require('./systemHealth');

const NOW = new Date('2026-09-28T15:00:00Z');
const endpoint = (health) => ({ id: 'openai', tier: 'frontier', health: { calls: 10, errorRate: 0, ...health } });
const serving = { chat: { endpointId: 'openai', tier: 'frontier', model: 'gpt-5.5' } };

beforeEach(() => {
  pool.query.mockImplementation(async (sql) => (sql.includes('self_review_report') ? [[{ last: '2026-09-28' }]] : [[{ 1: 1 }]]));
  llm.status.mockReturnValue({ serving, orcwood: [], frontier: [endpoint()], recentCalls: [] });
});

const check = (result, id) => result.checks.find((c) => c.id === id);

test('is ok when the database answers, a model serves chat and the nightly review is current', async () => {
  const result = await getHealth(NOW);
  expect(result.status).toBe('ok');
  expect(result.checks.map((c) => c.status)).toEqual(['ok', 'ok', 'ok']);
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
  pool.query.mockImplementation(async (sql) => (sql.includes('self_review_report') ? [[{ last: '2026-09-22' }]] : [[{ 1: 1 }]]));
  const result = await getHealth(NOW);
  expect(result.status).toBe('degraded');
  expect(check(result, 'nightly').detail).toContain('6 days ago');
});
