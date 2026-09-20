jest.mock('./secrets', () => ({ getSecret: jest.fn() }));

const secrets = require('./secrets');
const { getBilling } = require('./twilioBilling');

const ACCOUNT = `AC${'1'.repeat(32)}`;

beforeEach(() => {
  jest.restoreAllMocks();
  secrets.getSecret.mockImplementation(async (name) => ({
    TWILIO_ACCOUNT_SID: ACCOUNT,
    TWILIO_SID: `SK${'2'.repeat(32)}`,
    TWILIO_CLIENT_SECRET: 'secret',
  }[name] || null));
  global.fetch = jest.fn(async (url) => {
    if (url.endsWith('/Balance.json')) return { ok: true, json: async () => ({ balance: '12.34', currency: 'USD' }) };
    if (url.endsWith('/Today.json')) return { ok: true, json: async () => ({ usage_records: [{ category: 'sms', count: '4', count_unit: 'messages', price: '0.03', price_unit: 'USD' }] }) };
    return { ok: true, json: async () => ({ usage_records: [] }) };
  });
});

afterEach(() => { delete global.fetch; });

test('reads live balance and today/month usage from Twilio', async () => {
  const result = await getBilling();
  expect(result.configured).toBe(true);
  expect(result.balance).toEqual({ amount: '12.34', currency: 'USD' });
  expect(result.today[0]).toMatchObject({ category: 'sms', count: '4', price: '0.03' });
  expect(global.fetch).toHaveBeenCalledTimes(3);
});

test('reports an unconfigured account without calling Twilio', async () => {
  secrets.getSecret.mockResolvedValue(null);
  expect(await getBilling()).toMatchObject({ configured: false });
  expect(global.fetch).not.toHaveBeenCalled();
});
