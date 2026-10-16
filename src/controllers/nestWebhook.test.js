jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('../services/connectors/nest', () => ({ recordEvent: jest.fn(), sync: jest.fn(), offlineDevices: jest.fn() }));
jest.mock('../services/initiative', () => ({ evaluateProfile: jest.fn() }));
const pool = require('../helpers/db');
const nest = require('../services/connectors/nest');
const initiative = require('../services/initiative');
const access = require('../security/access');
const { receiveWith, decode } = require('./nestWebhook');

const SA = 'nest-push@athena-476423.iam.gserviceaccount.com';
const AUD = 'https://api.example.test/webhooks/nest';
const verifier = (claims) => ({ verifyIdToken: jest.fn(async ({ audience }) => {
  if (audience !== AUD || !claims) throw new Error('bad token');
  return { getPayload: () => claims };
}) });
const goodVerifier = () => verifier({ email: SA, email_verified: true });
const event = { timestamp: '2026-10-16T14:00:00Z', resourceUpdate: { name: 'enterprises/p/devices/d', traits: {} } };
function request(body = { message: { data: Buffer.from(JSON.stringify(event)).toString('base64'), messageId: '1' } }, auth = 'Bearer a.b.c') {
  return { body, get: name => (name === 'Authorization' ? auth : undefined) };
}
function response() {
  const res = {};
  for (const m of ['set', 'status', 'json', 'end']) res[m] = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(process.env, { NEST_PUBSUB_AUDIENCE: AUD, NEST_PUBSUB_SERVICE_ACCOUNT: SA, NEST_DEVICE_ACCESS_PROJECT_ID: 'p' });
  nest.recordEvent.mockResolvedValue({ applied: 1, wentOffline: [], resync: [] });
  pool.query.mockResolvedValue([[{ google_id: 'g-7' }]]);
  initiative.evaluateProfile.mockResolvedValue({ nudges: [] });
});

test('unconfigured endpoint refuses with a retryable 503 and reads nothing', async () => {
  delete process.env.NEST_PUBSUB_SERVICE_ACCOUNT;
  const res = response();
  await receiveWith(request(), res, { verifier: goodVerifier() });
  expect(res.status).toHaveBeenCalledWith(503);
  expect(nest.recordEvent).not.toHaveBeenCalled();
});

test('missing, wrong-audience, wrong-account and unverified tokens are rejected', async () => {
  for (const [req, v] of [
    [request(undefined, ''), goodVerifier()],
    [request(), verifier(null)],
    [request(), verifier({ email: 'someone@else.com', email_verified: true })],
    [request(), verifier({ email: SA, email_verified: false })],
  ]) {
    const res = response();
    await receiveWith(req, res, { verifier: v });
    expect(res.status).toHaveBeenCalledWith(401);
  }
  expect(nest.recordEvent).not.toHaveBeenCalled();
});

test('behind the proxy the push token is read from X-Pubsub-Authorization', async () => {
  const v = goodVerifier();
  const req = request(undefined, 'Bearer proxy.iam.token');
  const get = req.get;
  req.get = name => (name === 'X-Pubsub-Authorization' ? 'Bearer push.oidc.token' : get(name));
  const res = response();
  await receiveWith(req, res, { verifier: v });
  expect(v.verifyIdToken).toHaveBeenCalledWith({ idToken: 'push.oidc.token', audience: AUD });
  expect(res.status).toHaveBeenCalledWith(204);
});

test('a verified push is stored, then the profile that saw an outage is evaluated as itself', async () => {
  nest.recordEvent.mockResolvedValue({ applied: 1, wentOffline: [7], resync: [] });
  let identity;
  initiative.evaluateProfile.mockImplementation(async () => { identity = access.context.getStore()?.identity; return { nudges: [{}] }; });
  const res = response();
  await receiveWith(request(), res, { verifier: goodVerifier() });
  expect(nest.recordEvent).toHaveBeenCalledWith(event);
  expect(initiative.evaluateProfile).toHaveBeenCalledWith(7);
  expect(identity).toEqual({ google_id: 'g-7' });
  expect(res.status).toHaveBeenCalledWith(204);
});

test('a storage failure asks Pub/Sub to retry; a failed evaluation does not', async () => {
  nest.recordEvent.mockRejectedValueOnce(new Error('DB down'));
  let res = response();
  await receiveWith(request(), res, { verifier: goodVerifier() });
  expect(res.status).toHaveBeenCalledWith(503);

  nest.recordEvent.mockResolvedValue({ applied: 1, wentOffline: [7], resync: [] });
  initiative.evaluateProfile.mockRejectedValue(new Error('model down'));
  res = response();
  await receiveWith(request(), res, { verifier: goodVerifier() });
  expect(res.status).toHaveBeenCalledWith(204);
});

test('re-read profiles are evaluated only when something is offline', async () => {
  nest.recordEvent.mockResolvedValue({ applied: 0, wentOffline: [], resync: [7, 9] });
  nest.sync.mockResolvedValue(1);
  nest.offlineDevices.mockImplementation(async id => (id === 9 ? [{ name: 'x' }] : []));
  const res = response();
  await receiveWith(request(), res, { verifier: goodVerifier() });
  expect(initiative.evaluateProfile).toHaveBeenCalledTimes(1);
  expect(initiative.evaluateProfile).toHaveBeenCalledWith(9);
});

test('an undecodable message is acknowledged, since a retry cannot fix it', async () => {
  expect(decode({ message: { data: '!!!' } })).toBeNull();
  const res = response();
  await receiveWith(request({ message: { data: 'bm90IGpzb24=' } }), res, { verifier: goodVerifier() });
  expect(res.status).toHaveBeenCalledWith(204);
  expect(nest.recordEvent).not.toHaveBeenCalled();
});
