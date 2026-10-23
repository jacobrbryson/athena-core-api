jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('./connectors/gmail', () => ({ getMessage: jest.fn(), plainTextBody: jest.fn() }));
jest.mock('./llm', () => ({ generateJson: jest.fn() }));
const pool = require('../helpers/db');
const deliveries = require('./deliveries');

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('shipping notices from Walmart, Amazon and the carriers are read; newsletters are not', () => {
  const m = (from, subject, category = 'notification') => ({ from, subject, category });
  expect(deliveries.looksLikeDelivery(m('Walmart <help@walmart.com>', 'Your order is out for delivery'))).toBe(true);
  expect(deliveries.looksLikeDelivery(m('Walmart <help@walmart.com>', 'Delivered: 3 items', 'receipt'))).toBe(true);
  expect(deliveries.looksLikeDelivery(m('UPS <mcinfo@ups.com>', 'UPS Update: Package Scheduled for Delivery Today'))).toBe(true);
  expect(deliveries.looksLikeDelivery(m('USPS <auto-reply@usps.com>', 'USPS® Expected Delivery on Tuesday'))).toBe(true);
  expect(deliveries.looksLikeDelivery(m('Walmart <news@walmart.com>', 'Rollbacks you will love', 'promo'))).toBe(false);
  expect(deliveries.looksLikeDelivery(m('Jane <jane@example.com>', 'Lunch?', 'needs_reply'))).toBe(false);
});

test('only a real delivery in a known state is kept, bounded', () => {
  expect(deliveries.clean({ is_delivery: false, status: 'delivered' })).toBeNull();
  expect(deliveries.clean({ is_delivery: true, status: 'lost in space' })).toBeNull();
  expect(deliveries.clean({ is_delivery: true, status: 'delivered', merchant: 'Walmart', delivered_at: '2026-12-10T14:05:00-05:00', expected_date: 'soon' }))
    .toEqual({ merchant: 'Walmart', carrier: null, status: 'delivered', expected_on: null, delivered_at: new Date('2026-12-10T19:05:00Z'), items_summary: null });
});

test('an order only moves forward: a late "shipped" never undoes "delivered"', async () => {
  pool.query.mockResolvedValueOnce([[{ status: 'delivered' }]]);
  const item = { id: 'm2', threadId: 't1', date: 'Wed, 10 Dec 2026 12:00:00 -0500' };
  expect(await deliveries.fromEmail(7, item, { read: { is_delivery: true, status: 'shipped' } })).toBeNull();
  expect(pool.query).toHaveBeenCalledTimes(1);
});

test('a delivered notice with no time is dated by the email', async () => {
  pool.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
  const item = { id: 'm1', threadId: 't1', date: 'Wed, 10 Dec 2026 14:05:00 -0500' };
  const out = await deliveries.fromEmail(7, item, { read: { is_delivery: true, status: 'delivered', merchant: 'Walmart' } });
  expect(out.delivered_at).toEqual(new Date('2026-12-10T19:05:00Z'));
  expect(pool.query.mock.calls[1][0]).toMatch(/INSERT INTO athena_delivery/);
});

test('a delivery the cameras saw is matched, not reported', async () => {
  pool.query
    .mockResolvedValueOnce([[{ id: 1, uuid: 'd1', delivered_at: new Date(), sighting_uuid: null }, { id: 2, uuid: 'd2', delivered_at: new Date() }]])
    .mockResolvedValueOnce([{ affectedRows: 1 }]);
  const sightingsNear = jest.fn().mockResolvedValueOnce([{ uuid: 's1' }]).mockResolvedValueOnce([]);
  const out = await deliveries.unseen(7, { sightingsNear });
  expect(out.map((d) => d.uuid)).toEqual(['d2']);
  expect(pool.query.mock.calls[1]).toEqual(['UPDATE athena_delivery SET sighting_uuid = ? WHERE id = ?', ['s1', 1]]);
});

test('a failed read never throws into triage', async () => {
  require('./connectors/gmail').getMessage.mockRejectedValueOnce(new Error('boom'));
  await expect(deliveries.fromEmail(7, { id: 'm', threadId: 't' })).resolves.toBeNull();
});
