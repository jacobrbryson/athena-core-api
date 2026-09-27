jest.mock('./secrets', () => ({ getSecret: jest.fn() }));

const secrets = require('./secrets');
const { getBilling } = require('./openaiBilling');

const NOW = new Date('2026-09-03T12:00:00Z');
const day = (d) => Math.floor(Date.parse(`2026-09-0${d}T00:00:00Z`) / 1000);

beforeEach(() => {
  secrets.getSecret.mockImplementation(async (name) => (name === 'OPENAI_API_ADMIN_KEY' ? 'sk-admin-test' : null));
  global.fetch = jest.fn(async (url) => {
    const page = new URL(url).searchParams.get('page');
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
  expect(result).toMatchObject({ configured: true, currency: 'USD', monthStart: '2026-09-01', costThisMonth: 1.75, costToday: 0.25 });
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
