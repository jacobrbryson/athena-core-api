jest.mock('../credentials', () => ({ get: jest.fn(), updateTokens: jest.fn(), markNeedsReauth: jest.fn() }));
jest.mock('../consent', () => ({ hasConsentForProfile: jest.fn() }));
jest.mock('../bodyCalibration', () => ({ list: jest.fn() }));
const bodyCalibration = require('../bodyCalibration');
const credentials = require('../credentials');
const consent = require('../consent');
const vesync = require('./vesync');

const ok = result => ({ ok: true, status: 200, json: async () => ({ code: 0, msg: 'request success', result }) });
const refused = (code, msg) => ({ ok: true, status: 200, json: async () => ({ code, msg }) });
const link = over => ({ uuid: 'cred-1', kind: 'api_key', accessToken: 'tok', refreshToken: 'hunter2', displayName: 'me@example.com', externalAccountId: '123', tokenType: 'US', ...over });
const devices = ok({ list: [{ deviceType: 'LV-PUR131S', configModule: 'purifier' }, { deviceType: 'ESF551', deviceName: 'Bathroom scale', configModule: 'scaleModule' }] });
const now = Math.floor(Date.now() / 1000);

let profile = 100;
beforeEach(() => {
  jest.resetAllMocks();
  global.fetch = jest.fn();
  consent.hasConsentForProfile.mockResolvedValue(true);
  credentials.updateTokens.mockResolvedValue({});
  credentials.markNeedsReauth.mockResolvedValue({});
  bodyCalibration.list.mockResolvedValue([]);
  profile += 1; // the read cache is per profile, so each test starts cold
});

test('weigh-ins are paged to the end, since VeSync sends the oldest first', async () => {
  const page = (from, n) => ok({ weightDatas: Array.from({ length: n }, (_, i) => ({ weightG: 80000, timestamp: from + i })) });
  fetch.mockResolvedValueOnce(page(1000, 100)).mockResolvedValueOnce(page(2000, 100)).mockResolvedValueOnce(page(3000, 7));
  const rows = await vesync.fetchWeighIns({ token: 't', accountID: '1', region: 'US' }, 1, 'scaleModule');
  expect(rows).toHaveLength(207);
  expect(JSON.parse(fetch.mock.calls[2][1].body).data.page).toBe(3);
  // A server that ignores `page` and repeats itself stops after one copy.
  fetch.mockReset();
  fetch.mockResolvedValue(page(1000, 100));
  expect(await vesync.fetchWeighIns({ token: 't', accountID: '1', region: 'US' }, 1, 'scaleModule')).toHaveLength(100);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('normalize turns a VeSync weigh-in into metric body composition', () => {
  const w = vesync.normalize({ weightG: 80500, bfr: 21.46, heightCm: 180, muscleRate: 0.4, water: 55.2, visceralFat: 9, boneMass: 3.1, bmr: 1750, heartRate: 62, timestamp: now });
  expect(w).toMatchObject({ weight_kg: 80.5, body_fat_percent: 21.5, bmi: 24.8, muscle_mass_kg: 32.2, body_water_percent: 55.2, visceral_fat: 9, bone_mass_kg: 3.1, bmr_kcal: 1750, heart_rate: 62, manual: false });
  expect(w.at).toBe(new Date(now * 1000).toISOString());
});

test('a weigh-in without body composition keeps weight and leaves the rest null', () => {
  const w = vesync.normalize({ weigh_lb: 180, timestamp: now * 1000 });
  expect(w.weight_kg).toBe(81.65);
  expect(w.body_fat_percent).toBeNull();
  expect(w.bmi).toBeNull();
  expect(vesync.normalize({ timestamp: now })).toBeNull();
  expect(vesync.normalize({ weightG: 80000 })).toBeNull();
});

test('reads the scale with the stored session, newest weigh-in first', async () => {
  credentials.get.mockResolvedValue(link());
  fetch.mockResolvedValueOnce(devices).mockResolvedValueOnce(ok({ weightDatas: [
    { weightG: 81000, timestamp: now - 86400 * 3 },
    { weightG: 80000, bfr: 20, timestamp: now - 3600 },
    { weightG: 90000, timestamp: now - 86400 * 200 },
  ] }));
  const summary = await vesync.bodySummary(profile);
  expect(summary.latest).toMatchObject({ weight_kg: 80, body_fat_percent: 20 });
  expect(summary.weighIns).toHaveLength(2); // the 200-day-old one is outside 90 days
  const weighBody = JSON.parse(fetch.mock.calls[1][1].body);
  expect(fetch.mock.calls[1][0]).toBe('https://smartapi.vesync.com/iot/api/fitnessScale/getWeighingDataV4');
  expect(weighBody.data.configModule).toBe('scaleModule');
  expect(weighBody.context.token).toBe('tok');
  expect(credentials.updateTokens).not.toHaveBeenCalled();
});

test('a lapsed session logs in again with the stored password and saves the new token', async () => {
  credentials.get.mockResolvedValue(link());
  fetch
    .mockResolvedValueOnce(refused(-11012022, 'token expired'))
    .mockResolvedValueOnce(ok({ authorizeCode: 'code', accountID: '123' }))
    .mockResolvedValueOnce(ok({ token: 'fresh', accountID: '123', currentRegion: 'US' }))
    .mockResolvedValueOnce(devices)
    .mockResolvedValueOnce(ok({ weightDatas: [{ weightG: 80000, timestamp: now }] }));
  const weighIns = await vesync.listWeighIns(profile);
  expect(weighIns).toHaveLength(1);
  const auth = JSON.parse(fetch.mock.calls[1][1].body);
  expect(auth.email).toBe('me@example.com');
  expect(auth.password).toBe(require('crypto').createHash('md5').update('hunter2').digest('hex'));
  expect(credentials.updateTokens).toHaveBeenCalledWith('cred-1', expect.objectContaining({ accessToken: 'fresh', tokenType: 'US' }));
});

test('a refused password marks the link needs_reauth instead of looking broken', async () => {
  credentials.get.mockResolvedValue(link({ accessToken: null }));
  fetch.mockResolvedValueOnce(refused(-11201000, 'password error'));
  await expect(vesync.listWeighIns(profile)).rejects.toMatchObject({ code: 'not_connected' });
  expect(credentials.markNeedsReauth).toHaveBeenCalledWith('cred-1', expect.objectContaining({ detail: expect.stringContaining('password error') }));
});

test('no health consent, no read; no link, not_connected', async () => {
  consent.hasConsentForProfile.mockResolvedValueOnce(false);
  await expect(vesync.listWeighIns(profile)).rejects.toMatchObject({ code: 'consent_required' });
  expect(fetch).not.toHaveBeenCalled();
  credentials.get.mockResolvedValueOnce(null);
  await expect(vesync.listWeighIns(profile)).rejects.toMatchObject({ code: 'not_connected' });
});

test('an EU-homed account is retried against the EU host with the bizToken', async () => {
  fetch
    .mockResolvedValueOnce(ok({ authorizeCode: 'code', accountID: '9' }))
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ code: -11260022, msg: 'cross region', result: { bizToken: 'biz', currentRegion: 'EU', countryCode: 'DE' } }) })
    .mockResolvedValueOnce(ok({ token: 'eu-tok', accountID: '9', currentRegion: 'EU' }));
  const session = await vesync.login({ profileId: 1, email: 'a@b.c', password: 'x' });
  expect(session).toEqual({ token: 'eu-tok', accountID: '9', region: 'EU' });
  expect(fetch.mock.calls[2][0]).toBe('https://smartapi.vesync.eu/user/api/accountManage/v1/loginByAuthorizeCode4Vesync');
  expect(JSON.parse(fetch.mock.calls[2][1].body)).toMatchObject({ bizToken: 'biz', userCountryCode: 'DE' });
});

test('chat keywords catch weight questions but not every number', () => {
  expect(vesync.matches('how much do I weigh?')).toBe(true);
  expect(vesync.matches("what's my body fat now")).toBe(true);
  expect(vesync.matches('on a scale of 1 to 10')).toBe(false);
  expect(vesync.matches('buy 5 pounds of flour')).toBe(false);
});

test('weigh-ins carry Athena estimates from impedance, without leaking the raw inputs', async () => {
  credentials.get.mockResolvedValue(link());
  fetch.mockResolvedValueOnce(devices).mockResolvedValueOnce(ok({ weightDatas: [
    { weightG: 82000, bfr: 15, impedance: 480, heightCm: 191, age: 40, gender: 1, heartRate: 60, timestamp: now },
  ] }));
  const { latest } = await vesync.bodySummary(profile);
  expect(latest.body_fat_percent).toBe(15);
  expect(latest.skeletal_muscle_kg).toBeGreaterThan(30);
  expect(latest.estimated).toEqual(expect.arrayContaining(['skeletal_muscle_kg', 'body_water_percent']));
  expect(latest).not.toHaveProperty('impedance_ohm');
  expect(latest).not.toHaveProperty('sex');
});
