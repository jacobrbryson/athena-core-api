jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('../services/sightings', () => ({ record: jest.fn(), profilesToAlert: jest.fn() }));
jest.mock('../services/initiative', () => ({ evaluateProfile: jest.fn() }));
const pool = require('../helpers/db');
const sightings = require('../services/sightings');
const initiative = require('../services/initiative');
const controller = require('./eufyEvents');

const TOKEN = 'b'.repeat(40);
const res = () => ({ set: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), end: jest.fn() });
const req = (headers = {}, body = { event: { kind: 'motion' }, frame: 'x' }) => ({ get: h => headers[h.toLowerCase()], body });
beforeEach(() => {
  process.env.EUFY_BRIDGE_TOKEN = TOKEN;
  process.env.EUFY_AUTHORIZED_PROFILE_IDS = '1';
  pool.query.mockReset().mockResolvedValue([[{ google_id: 'g1' }]]);
  sightings.record.mockReset().mockResolvedValue([{ label: 'Wynter' }]);
  sightings.profilesToAlert.mockReset().mockResolvedValue([]);
  initiative.evaluateProfile.mockReset().mockResolvedValue({});
});

test('a wrong or missing bridge token records nothing', async () => {
  for (const headers of [{}, { authorization: 'Bearer nope' }, { 'x-eufy-bridge-authorization': `Bearer ${'c'.repeat(40)}` }]) {
    const r = res();
    await controller.receive(req(headers), r);
    expect(r.status).toHaveBeenCalledWith(401);
  }
  expect(sightings.record).not.toHaveBeenCalled();
});
test('the proxy-forwarded header is accepted and the event recorded', async () => {
  const r = res();
  await controller.receive(req({ 'x-eufy-bridge-authorization': `Bearer ${TOKEN}` }), r);
  expect(sightings.record).toHaveBeenCalledWith({ event: { kind: 'motion' }, frame: 'x' });
  expect(r.json).toHaveBeenCalledWith({ sightings: 1 });
});
test('a matching rule runs that person’s initiative pass at once', async () => {
  sightings.profilesToAlert.mockResolvedValue([1]);
  await controller.receive(req({ authorization: `Bearer ${TOKEN}` }), res());
  expect(initiative.evaluateProfile).toHaveBeenCalledWith(1);
});
test('a short token in the environment fails closed', async () => {
  process.env.EUFY_BRIDGE_TOKEN = 'short';
  const r = res();
  await controller.receive(req({ authorization: 'Bearer short' }), r);
  expect(r.status).toHaveBeenCalledWith(401);
});
test('an alert failure does not fail the recorded event', async () => {
  sightings.profilesToAlert.mockResolvedValue([1]);
  initiative.evaluateProfile.mockRejectedValue(new Error('push down'));
  const r = res();
  await controller.receive(req({ authorization: `Bearer ${TOKEN}` }), r);
  expect(r.status).toHaveBeenCalledWith(200);
});
