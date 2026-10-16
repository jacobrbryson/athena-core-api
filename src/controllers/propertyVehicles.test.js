jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('../helpers/actor', () => ({ requireAdultActor: jest.fn() }));
const db = require('../helpers/db');
const { requireAdultActor } = require('../helpers/actor');
const { normalize, service, list, create, update, remove, getPhoto, addService, removeService, promptVehicles } = require('./propertyVehicles');

const today = new Date().toISOString().slice(0, 10);
const response = () => { const r = { set: jest.fn(), json: jest.fn(), status: jest.fn() }; r.status.mockReturnValue(r); return r; };
const row = {
  id: 7, uuid: 'car-1', property_uuid: 'prop-1', name: 'The BMW', year: 2021, make: 'BMW', model: 'X5', color: null, plate: null, vin: null,
  odometer: 30000, odometer_on: '2026-09-01', registration_due: null, inspection_due: null, insurance_due: null, service_due: null,
  service_due_miles: null, notes: null, has_photo: 0, created_at: '2026-10-01 12:00:00', updated_at: '2026-10-01 12:00:00',
};
beforeEach(() => { jest.clearAllMocks(); requireAdultActor.mockResolvedValue({ profileId: 42 }); });

test('names a vehicle after the car when it has no name, and needs one or the other', () => {
  expect(normalize({ year: '2021', make: 'BMW', model: 'X5' })).toMatchObject({ name: '2021 BMW X5', year: 2021, photo: undefined });
  expect(normalize({ name: 'Mom’s van' }).name).toBe('Mom’s van');
  expect(() => normalize({})).toThrow('Give the vehicle a name');
});

test('checks the year, VIN, mileage and dates', () => {
  expect(() => normalize({ name: 'x', year: 1800 })).toThrow('model year');
  expect(() => normalize({ name: 'x', vin: 'WBA0IO' })).toThrow('VIN');
  expect(normalize({ name: 'x', vin: 'wba 5r1c50fd123456', plate: 'abc 123' })).toMatchObject({ vin: 'WBA5R1C50FD123456', plate: 'ABC 123' });
  expect(() => normalize({ name: 'x', odometer: -1 })).toThrow('whole miles');
  expect(() => normalize({ name: 'x', registrationDue: 'soon' })).toThrow('valid date');
  // Due dates are in the future; a reading's date never is.
  expect(normalize({ name: 'x', registrationDue: '2999-01-01' }).registrationDue).toBe('2999-01-01');
  expect(() => normalize({ name: 'x', odometer: 5, odometerOn: '2999-01-01' })).toThrow('future');
});

test('a reading without a date is dated today, and no reading has no date', () => {
  expect(normalize({ name: 'x', odometer: 100 }).odometerOn).toBe(today);
  expect(normalize({ name: 'x', odometerOn: '2026-01-01' }).odometerOn).toBeNull();
  const existing = { name: 'x', odometer: 100, odometerOn: '2026-01-01' };
  expect(normalize({ notes: 'hi' }, existing).odometerOn).toBe('2026-01-01');
  expect(normalize({ odometer: 200 }, existing).odometerOn).toBe(today);
});

test('accepts only a JPEG data photo, and null removes it', () => {
  expect(() => normalize({ name: 'x', photo: 'https://example.org/a.jpg' })).toThrow('JPEG');
  expect(normalize({ name: 'x', photo: null }).photo).toBeNull();
  expect(normalize({ name: 'x', photo: 'data:image/jpeg;base64,AAAA' }).photo).toBe('data:image/jpeg;base64,AAAA');
});

test('a service entry needs what and when, never in the future', () => {
  expect(service({ what: 'Oil change', doneOn: today, odometer: '31000' })).toEqual({ what: 'Oil change', doneOn: today, odometer: 31000, shop: null });
  expect(() => service({ what: '', doneOn: today })).toThrow('Say what');
  expect(() => service({ what: 'Tires' })).toThrow('when it was done');
  expect(() => service({ what: 'Tires', doneOn: '2999-01-01' })).toThrow('future');
});

test('does not query without an adult actor', async () => {
  requireAdultActor.mockResolvedValue(null);
  await list({}, response());
  await create({ body: { name: 'x' } }, response());
  expect(db.query).not.toHaveBeenCalled();
});

test('lists only the actor’s vehicles, with their service history', async () => {
  db.query.mockResolvedValueOnce([[row]]).mockResolvedValueOnce([[{ vehicle_id: 7, uuid: 's1', done_on: today, odometer: 30000, what: 'Oil change', shop: null }]]);
  const res = response(); await list({}, res);
  expect(db.query.mock.calls[0]).toEqual([expect.stringContaining('WHERE profile_id = ?'), [42]]);
  expect(db.query.mock.calls[0][0]).not.toMatch(/(^|[\s,])photo,/);
  const [v] = res.json.mock.calls[0][0].vehicles;
  expect(v).toMatchObject({ uuid: 'car-1', propertyUuid: 'prop-1', name: 'The BMW', hasPhoto: false, service: [{ uuid: 's1', what: 'Oil change' }] });
});

test('a vehicle lives at the actor’s property: their first by default, never someone else’s', async () => {
  db.query.mockResolvedValueOnce([[]]);
  let res = response(); await create({ body: { name: 'x' } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ message: expect.stringContaining('Add your property first') });

  db.query.mockReset().mockResolvedValueOnce([[{ uuid: 'prop-1' }]]);
  res = response(); await create({ body: { name: 'x', propertyUuid: 'prop-2' } }, res);
  expect(res.status).toHaveBeenCalledWith(400);

  db.query.mockReset().mockResolvedValueOnce([[{ uuid: 'prop-1' }]]).mockResolvedValueOnce([[{ n: 0 }]]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([[]]);
  res = response(); await create({ body: { name: 'The BMW', photo: 'data:image/jpeg;base64,AAAA' } }, res);
  const [sql, params] = db.query.mock.calls[2];
  expect(sql).toContain('INSERT INTO athena_property_vehicle');
  expect(params.slice(1, 4)).toEqual([42, 'prop-1', 'The BMW']);
  expect(params[params.length - 1]).toBe('data:image/jpeg;base64,AAAA');
  expect(res.json).toHaveBeenCalledWith({ vehicles: [] });
});

test('a patch keeps the photo unless it is sent', async () => {
  db.query.mockResolvedValueOnce([[row]]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([[]]);
  await update({ params: { uuid: 'car-1' }, body: { notes: 'Needs wipers' } }, response());
  const [sql, params] = db.query.mock.calls[1];
  expect(sql).not.toContain('photo=?');
  expect(params).toEqual(expect.arrayContaining(['The BMW', 'Needs wipers', 7, 42]));

  db.query.mockReset().mockResolvedValueOnce([[row]]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([[]]);
  await update({ params: { uuid: 'car-1' }, body: { photo: null } }, response());
  expect(db.query.mock.calls[1][0]).toContain('photo=?');
});

test('an unknown or foreign vehicle is a 404', async () => {
  db.query.mockResolvedValueOnce([[]]);
  const res = response(); await update({ params: { uuid: 'nope' }, body: {} }, res);
  expect(db.query.mock.calls[0][1]).toEqual([42, 'nope']);
  expect(res.status).toHaveBeenCalledWith(404);

  db.query.mockReset().mockResolvedValueOnce([{ affectedRows: 0 }]);
  const res2 = response(); await remove({ params: { uuid: 'nope' } }, res2);
  expect(res2.status).toHaveBeenCalledWith(404);
});

test('the photo is read through the actor’s own vehicle', async () => {
  db.query.mockResolvedValueOnce([[row]]).mockResolvedValueOnce([[{ photo: 'data:image/jpeg;base64,AAAA' }]]);
  const res = response(); await getPhoto({ params: { uuid: 'car-1' } }, res);
  expect(db.query.mock.calls[1][1]).toEqual([7]);
  expect(res.json).toHaveBeenCalledWith({ image: 'data:image/jpeg;base64,AAAA' });
});

test('service above the odometer on file becomes the new reading; below it does not', async () => {
  db.query.mockResolvedValueOnce([[row]]).mockResolvedValueOnce([[{ n: 0 }]]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([[]]);
  await addService({ params: { uuid: 'car-1' }, body: { what: 'Oil change', doneOn: today, odometer: 31000 } }, response());
  expect(db.query.mock.calls[2][1].slice(1)).toEqual([7, today, 31000, 'Oil change', null]);
  expect(db.query.mock.calls[3]).toEqual([expect.stringContaining('SET odometer = ?'), [31000, today, 7]]);

  db.query.mockReset().mockResolvedValueOnce([[row]]).mockResolvedValueOnce([[{ n: 0 }]]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([[]]);
  await addService({ params: { uuid: 'car-1' }, body: { what: 'Old receipt', doneOn: '2025-01-01', odometer: 12000 } }, response());
  expect(db.query.mock.calls.some(c => c[0].includes('SET odometer = ?'))).toBe(false);
});

test('removing a service entry is scoped to the vehicle', async () => {
  db.query.mockResolvedValueOnce([[row]]).mockResolvedValueOnce([{ affectedRows: 0 }]);
  const res = response(); await removeService({ params: { uuid: 'car-1', serviceUuid: 's9' } }, res);
  expect(db.query.mock.calls[1][1]).toEqual([7, 's9']);
  expect(res.status).toHaveBeenCalledWith(404);
});

test('the prompt read never throws', async () => {
  db.query.mockRejectedValueOnce(Object.assign(new Error('no table'), { code: 'ER_NO_SUCH_TABLE' }));
  await expect(promptVehicles(42)).resolves.toEqual([]);
});
