jest.mock('./secrets', () => ({ getSecret: jest.fn() }));

const secrets = require('./secrets');
const { getBilling, _resetCache } = require('./openaiBilling');

const NOW = new Date('2026-09-03T12:00:00Z');
const day = (d) => Math.floor(Date.parse(`2026-09-0${d}T00:00:00Z`) / 1000);

beforeEach(() => {
  _resetCache();
  secrets.getSecret.mockImplementation(async (name) => (name === 'OPENAI_API_ADMIN_KEY' ? 'sk-admin-test' : null));
  global.fetch = jest.fn(async (url) => {
    const params = new URL(url).searchParams;
    // The lifetime read: one ungrouped page.
    if (!params.get('group_by')) return { ok: true, json: async () => ({ data: [{ start_time: day(1), results: [{ amount: { value: 30.004, currency: 'usd' } }] }, { start_time: day(2), results: [{ amount: { value: 2, currency: 'usd' } }] }], has_more: false }) };
    const page = params.get('page');
    const data = page
      ? [{ start_time: day(3), results: [{ amount: { value: 0.25, currency: 'usd' }, line_item: 'gpt-5.5, output' }] }]
      : [
        { start_time: day(1), results: [{ amount: { value: 1.2, currency: 'usd' }, line_item: 'gpt-5.5, output' }, { amount: { value: 0.3, currency: 'usd' }, line_item: 'gpt-5.5, input' }] },
        { start_time: day(2), results: [] },
      ];
    return { ok: true, json: async () => ({ data, has_more: !page, next_page: page ? null : 'next' }) };
  });
});

afterEach(() => { delete global.fetch; });

test('totals month-to-date spend from the Costs API across pages', async () => {
  const result = await getBilling(NOW);
  expect(result).toMatchObject({ configured: true, currency: 'USD', monthStart: '2026-09-01', costThisMonth: 1.75, costToday: 0.25, costAllTime: 32 });
  expect(result.lineItems).toEqual([{ name: 'gpt-5.5, output', cost: 1.45 }, { name: 'gpt-5.5, input', cost: 0.3 }]);
  expect(result.daily.map((d) => d.date)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
  const [url, init] = global.fetch.mock.calls[0];
  expect(url).toContain(`start_time=${day(1)}`);
  expect(init.headers.Authorization).toBe('Bearer sk-admin-test');
});

test('reads only the admin key, and reports unconfigured without calling OpenAI', async () => {
  secrets.getSecret.mockResolvedValue(null);
  expect(await getBilling(NOW)).toMatchObject({ configured: false });
  expect(secrets.getSecret).toHaveBeenCalledWith('OPENAI_API_ADMIN_KEY');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('surfaces an OpenAI error', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid admin key' } }) }));
  await expect(getBilling(NOW)).rejects.toMatchObject({ status: 401, message: 'Invalid admin key' });
});

test('reads the lifetime total from the Athena start date once, then caches it', async () => {
  await getBilling(NOW);
  await getBilling(NOW);
  const lifetime = global.fetch.mock.calls.filter(([url]) => !new URL(url).searchParams.get('group_by'));
  expect(lifetime).toHaveLength(1);
  expect(new URL(lifetime[0][0]).searchParams.get('start_time')).toBe(String(Date.parse('2025-10-27T00:00:00Z') / 1000));
});
