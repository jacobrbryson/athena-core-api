jest.mock('../helpers/actor', () => ({ requireAdultActor: jest.fn() }));
jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('../services/guardianEngine', () => ({
  overview: jest.fn(), saveConfig: jest.fn(), runNow: jest.fn(), recheck: jest.fn(), acknowledge: jest.fn(), dismiss: jest.fn(), assign: jest.fn(), runDue: jest.fn(),
}));
const { requireAdultActor } = require('../helpers/actor');
const engine = require('../services/guardianEngine');
const controller = require('./guardian');

const response = () => ({ status: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), end: jest.fn().mockReturnThis() });
const ID = '11111111-1111-4111-8111-111111111111';
const oldEnv = { ...process.env };
beforeEach(() => {
  process.env.EUFY_AUTHORIZED_PROFILE_IDS = '12';
  delete process.env.EUFY_BRIDGE_URL;
  requireAdultActor.mockReset().mockResolvedValue({ profileId: 12, kind: 'parent' });
  for (const fn of Object.values(engine)) fn.mockReset();
  engine.overview.mockResolvedValue({ status: 'secure' });
});
afterAll(() => { process.env = oldEnv; });

test('an adult outside the household allowlist sees nothing and can run nothing', async () => {
  process.env.EUFY_AUTHORIZED_PROFILE_IDS = '13';
  for (const route of [controller.overview, controller.runNow, controller.saveProtocol, controller.acknowledge, controller.dismiss]) {
    const res = response();
    await route({ params: { id: 'nightly_sweep' }, body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  }
  for (const fn of Object.values(engine)) expect(fn).not.toHaveBeenCalled();
});

test('a paired device bound to an allowed adult is refused', async () => {
  requireAdultActor.mockResolvedValue({ profileId: 12, kind: 'device' });
  const res = response();
  await controller.runNow({ params: { id: 'nightly_sweep' }, body: {} }, res);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(engine.runNow).not.toHaveBeenCalled();
});

test('a child is refused by the adult guard before anything runs', async () => {
  requireAdultActor.mockResolvedValue(null);
  await controller.overview({ params: {}, body: {} }, response());
  expect(engine.overview).not.toHaveBeenCalled();
});

test('actions act as the signed-in adult, never a profile from the body', async () => {
  await controller.acknowledge({ params: { id: ID }, body: { profileId: 99 } }, response());
  expect(engine.acknowledge).toHaveBeenCalledWith(12, ID);
  await controller.dismiss({ params: { id: ID }, body: { reason: 'painters' } }, response());
  expect(engine.dismiss).toHaveBeenCalledWith(12, ID, 'painters');
  const bad = response();
  await controller.recheck({ params: { id: 'not-a-uuid' }, body: {} }, bad);
  expect(bad.status).toHaveBeenCalledWith(400);
});

test('a simulation scenario keeps only known checks and states', () => {
  expect(controller.cleanScenario({ garage_door: { main: 'open', 'x y': 'open', side: 'exploded' }, lights: { a: 'on' } })).toEqual({ garage_door: { main: 'open' } });
  expect(controller.cleanScenario('open')).toBeNull();
});

test('an engine error with a status is the person\'s to read; anything else is a 503', async () => {
  engine.runNow.mockRejectedValue(Object.assign(new Error('Unknown protocol.'), { status: 404 }));
  const res = response();
  await controller.runNow({ params: { id: 'nightly_sweep' }, body: {} }, res);
  expect(res.status).toHaveBeenCalledWith(404);
  engine.runNow.mockRejectedValue(new Error('ER_NO_SUCH_TABLE'));
  const res2 = response();
  await controller.runNow({ params: { id: 'nightly_sweep' }, body: {} }, res2);
  expect(res2.status).toHaveBeenCalledWith(503);
});

test('dispatch answers only a verified caller', async () => {
  const run = jest.fn().mockResolvedValue({ planned: { due: 1 }, ran: [{ run: 'r' }] });
  const refused = response();
  await controller.dispatchWith({ get: () => '' }, refused, { verify: async () => false, run });
  expect(refused.status).toHaveBeenCalledWith(401);
  expect(run).not.toHaveBeenCalled();
  const ok = response();
  await controller.dispatchWith({ get: () => 'Bearer t' }, ok, { verify: async () => true, run });
  expect(ok.json).toHaveBeenCalledWith({ ran: 1, due: 1, runs: [{ run: 'r' }] });
});

test('the outage check runs only for an outage dispatch, and its failure never fails the dispatch', async () => {
  const run = jest.fn().mockResolvedValue({ planned: { due: 0 }, ran: [] });
  const outage = jest.fn().mockResolvedValue({ verdict: 'quiet' });
  const plain = response();
  await controller.dispatchWith({ get: () => 'Bearer t', body: { reason: 'incidents job' } }, plain, { verify: async () => true, run, outage });
  expect(outage).not.toHaveBeenCalled();
  const woken = response();
  await controller.dispatchWith({ get: () => 'Bearer t', body: { reason: 'outage:nest_offline' } }, woken, { verify: async () => true, run, outage });
  expect(outage).toHaveBeenCalledWith({ reason: 'nest_offline' });
  expect(woken.json).toHaveBeenCalledWith(expect.objectContaining({ outage: { verdict: 'quiet' } }));
  const failing = response();
  await controller.dispatchWith({ get: () => 'Bearer t', body: { reason: 'outage backstop' } }, failing, { verify: async () => true, run, outage: jest.fn().mockRejectedValue(new Error('boom')) });
  expect(failing.json).toHaveBeenCalledWith(expect.objectContaining({ outage: { error: 'boom' } }));
});

test('dispatch token verification needs the configured audience and account', async () => {
  const { verifyCaller } = require('../services/guardianEngine/dispatch');
  const req = { get: () => 'Bearer abc.def.ghi' };
  const verify = { verifyIdToken: jest.fn(async () => ({ getPayload: () => ({ email: 'job@p.iam.gserviceaccount.com', email_verified: true }) })) };
  delete process.env.GUARDIAN_DISPATCH_AUDIENCE;
  expect(await verifyCaller(req, { verify })).toBe(false);
  process.env.GUARDIAN_DISPATCH_AUDIENCE = 'https://core.example';
  process.env.GUARDIAN_DISPATCH_SERVICE_ACCOUNTS = 'other@p.iam.gserviceaccount.com';
  expect(await verifyCaller(req, { verify })).toBe(false);
  process.env.GUARDIAN_DISPATCH_SERVICE_ACCOUNTS = 'other@p.iam.gserviceaccount.com, JOB@p.iam.gserviceaccount.com';
  expect(await verifyCaller(req, { verify })).toBe(true);
  expect(verify.verifyIdToken).toHaveBeenCalledWith({ idToken: 'abc.def.ghi', audience: 'https://core.example' });
  verify.verifyIdToken.mockRejectedValue(new Error('bad signature'));
  expect(await verifyCaller(req, { verify })).toBe(false);
});
