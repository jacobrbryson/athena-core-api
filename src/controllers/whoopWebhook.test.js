jest.mock('../services/secrets', () => ({ getSecret: jest.fn() }));
jest.mock('../services/attention/store', () => ({ receive: jest.fn() }));
const crypto = require('node:crypto');
const secrets = require('../services/secrets');
const store = require('../services/attention/store');
const { validSignature, receive } = require('./whoopWebhook');

const SECRET = 'test-only-webhook-secret';
const payload = { user_id: 42, id: '12345678-1234-1234-1234-123456789abc', trace_id: '98765432-1234-1234-1234-123456789abc', type: 'workout.updated' };
const sign = (raw, ts) => crypto.createHmac('sha256', SECRET).update(ts).update(raw).digest('base64');
function request(value = payload) {
  const body = Buffer.from(JSON.stringify(value));
  const ts = String(Date.now());
  return { body, get: name => name === 'X-WHOOP-Signature-Timestamp' ? ts : sign(body, ts) };
}
function response() {
  const res = {};
  for (const method of ['set', 'status', 'json', 'end']) res[method] = jest.fn(() => res);
  return res;
}
beforeEach(() => { jest.clearAllMocks(); secrets.getSecret.mockResolvedValue(SECRET); store.receive.mockResolvedValue(); });

test('signature covers exact bytes and timestamp; changed bytes, stale time and missing secrets fail closed', () => {
  const ts = String(Date.now()), raw = Buffer.from('{ "x": 1 }');
  expect(validSignature(SECRET, raw, ts, sign(raw, ts))).toBe(true);
  expect(validSignature(SECRET, Buffer.from('{"x":1}'), ts, sign(raw, ts))).toBe(false);
  expect(validSignature(SECRET, raw, ts, sign(raw, ts), +ts + 301000)).toBe(false);
  expect(validSignature(null, raw, ts, sign(raw, ts))).toBe(false);
  expect(validSignature(SECRET, { x: 1 }, ts, sign(raw, ts))).toBe(false);
});
test('acknowledges only after durable persistence and derives account from signed payload', async () => {
  let finish;
  store.receive.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const req = request(), res = response();
  req.headers = { 'x-profile-id': '999' };
  const pending = receive(req, res);
  await new Promise(resolve => setImmediate(resolve));
  expect(res.status).not.toHaveBeenCalled();
  expect(store.receive).toHaveBeenCalledWith('42', expect.objectContaining({ resourceId: payload.id, type: 'workout.updated' }));
  finish(); await pending;
  expect(res.status).toHaveBeenCalledWith(204);
});
test('database failure returns a retryable failure, never a successful acknowledgment', async () => {
  store.receive.mockRejectedValue(new Error('DB down'));
  const res = response(); await receive(request(), res);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.status).not.toHaveBeenCalledWith(204);
});
test('tampered payload never resolves ownership or writes work', async () => {
  const req = request(), res = response(); const get = req.get;
  const signature = get('X-WHOOP-Signature'); req.get = name => name === 'X-WHOOP-Signature' ? signature : get(name);
  req.body = Buffer.from(JSON.stringify({ ...payload, user_id: 999 }));
  await receive(req, res);
  expect(res.status).toHaveBeenCalledWith(401); expect(store.receive).not.toHaveBeenCalled();
});
test.each([null, { ...payload, id: 123 }, { ...payload, user_id: '42' }])('malformed v2 event is rejected: %p', async value => {
  const res = response(); await receive(request(value), res);
  expect(res.status).toHaveBeenCalledWith(400); expect(store.receive).not.toHaveBeenCalled();
});
test('unrelated signed event is acknowledged without starting interpretation', async () => {
  const res = response(); await receive(request({ ...payload, type: 'sleep.updated' }), res);
  expect(res.status).toHaveBeenCalledWith(204); expect(store.receive).not.toHaveBeenCalled();
});
