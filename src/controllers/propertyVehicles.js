const { randomUUID } = require('node:crypto');
const pool = require('../helpers/db');
const { requireAdultActor } = require('../helpers/actor');
const recalls = require('../services/vehicleRecalls');

// Vehicles (docs/capabilities/vehicles.md): the cars kept at a property, with
// what comes due and what was done. Adult-only, profile-scoped, and every
// write answers with the whole list, like property issues. A vehicle belongs
// to one of the person's properties; the photo is fetched apart.
const MAX_VEHICLES = 20;
const MAX_SERVICE = 500;
const MAX_MILES = 2_000_000;
const DATES = { registrationDue: 'registration_due', inspectionDue: 'inspection_due', insuranceDue: 'insurance_due', serviceDue: 'service_due' };

const bad = message => Object.assign(new Error(message), { status: 400 });
const notFound = () => Object.assign(new Error('That vehicle is no longer on your list.'), { status: 404 });

function text(value, max, label) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max) throw bad(`${label} is too long.`);
  return value.trim();
}
function day(value, label, { past = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw bad(`Enter a valid date for ${label}.`);
  // A day of slack for the person's timezone, as for issues.
  if (past && Date.parse(`${value}T00:00:00Z`) > Date.now() + 86_400_000) throw bad(`The date for ${label} is in the future.`);
  return value;
}
function miles(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_MILES) throw bad(`Enter ${label} in whole miles.`);
  return n;
}
function photo(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 1500000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value)) throw bad('Upload a JPEG photo under 1.5 MB.');
  return value;
}

/** A full vehicle from input, or a patch merged over an existing one. `photo` stays undefined when unchanged. */
function normalize(input, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Invalid vehicle.');
  const pick = (key, fn) => (input[key] !== undefined || !existing ? fn(input[key]) : existing[key]);
  const out = {
    propertyUuid: pick('propertyUuid', v => (v === undefined || v === null || v === '' ? null : text(v, 36, 'Property'))),
    year: pick('year', v => {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1900 || n > new Date().getUTCFullYear() + 2) throw bad('Enter a model year like 2021.');
      return n;
    }),
    make: pick('make', v => text(v, 60, 'Make') || null),
    model: pick('model', v => text(v, 60, 'Model') || null),
    color: pick('color', v => text(v, 40, 'Color') || null),
    plate: pick('plate', v => text(v, 20, 'Plate').toUpperCase() || null),
    vin: pick('vin', v => {
      const vin = text(v, 24, 'VIN').toUpperCase().replace(/\s+/g, '');
      if (vin && !/^[A-HJ-NPR-Z0-9]{11,17}$/.test(vin)) throw bad('That VIN doesn’t look right — it is letters and numbers, without I, O or Q.');
      return vin || null;
    }),
    odometer: pick('odometer', v => miles(v, 'the odometer')),
    odometerOn: pick('odometerOn', v => day(v, 'the odometer reading', { past: true })),
    serviceDueMiles: pick('serviceDueMiles', v => miles(v, 'the next service mileage')),
    notes: pick('notes', v => text(v, 4000, 'Notes') || null),
  };
  for (const key of Object.keys(DATES)) out[key] = pick(key, v => day(v, key === 'serviceDue' ? 'the next service' : key.replace('Due', '')));
  // The name is what the person calls it; without one, the car itself.
  out.name = pick('name', v => text(v, 100, 'Name')) || [out.year, out.make, out.model].filter(Boolean).join(' ');
  if (!out.name) throw bad('Give the vehicle a name, or its make and model.');
  // A new reading without its own date was read today; no reading, no date.
  const newReading = existing && input.odometer !== undefined && input.odometerOn === undefined && out.odometer !== existing.odometer;
  if (out.odometer === null) out.odometerOn = null;
  else if (!out.odometerOn || newReading) out.odometerOn = new Date().toISOString().slice(0, 10);
  out.photo = photo(input.photo);
  return out;
}

function service(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Invalid service entry.');
  const what = text(input.what, 500, 'What was done');
  if (!what) throw bad('Say what was done.');
  const doneOn = day(input.doneOn, 'the service', { past: true });
  if (!doneOn) throw bad('Choose when it was done.');
  return { doneOn, odometer: miles(input.odometer, 'the mileage'), what, shop: text(input.shop, 100, 'The shop') || null };
}

const iso = v => (v instanceof Date ? v.toISOString() : v ? new Date(`${String(v).replace(' ', 'T')}Z`).toISOString() : null);
const COLUMNS = `id, uuid, property_uuid, name, year, make, model, color, plate, vin, odometer,
  DATE_FORMAT(odometer_on, '%Y-%m-%d') AS odometer_on, DATE_FORMAT(registration_due, '%Y-%m-%d') AS registration_due,
  DATE_FORMAT(inspection_due, '%Y-%m-%d') AS inspection_due, DATE_FORMAT(insurance_due, '%Y-%m-%d') AS insurance_due,
  DATE_FORMAT(service_due, '%Y-%m-%d') AS service_due, service_due_miles, notes, photo IS NOT NULL AS has_photo, created_at, updated_at`;
const toVehicle = (r, log, recallLog = new Map()) => ({
  uuid: r.uuid, propertyUuid: r.property_uuid, name: r.name, year: r.year, make: r.make, model: r.model, color: r.color,
  plate: r.plate, vin: r.vin, odometer: r.odometer, odometerOn: r.odometer_on,
  registrationDue: r.registration_due, inspectionDue: r.inspection_due, insuranceDue: r.insurance_due,
  serviceDue: r.service_due, serviceDueMiles: r.service_due_miles, notes: r.notes, hasPhoto: !!r.has_photo,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  service: log.get(r.id) || [],
  recalls: recallLog.get(r.id) || [],
});
const existingOf = r => ({
  propertyUuid: r.property_uuid, name: r.name, year: r.year, make: r.make, model: r.model, color: r.color, plate: r.plate, vin: r.vin,
  odometer: r.odometer, odometerOn: r.odometer_on, registrationDue: r.registration_due, inspectionDue: r.inspection_due,
  insuranceDue: r.insurance_due, serviceDue: r.service_due, serviceDueMiles: r.service_due_miles, notes: r.notes,
});

/** Service entries per vehicle id, newest first. */
async function serviceFor(ids) {
  const log = new Map();
  if (!ids.length) return log;
  const [list] = await pool.query(
    `SELECT vehicle_id, uuid, DATE_FORMAT(done_on, '%Y-%m-%d') AS done_on, odometer, what, shop FROM athena_property_vehicle_service
     WHERE vehicle_id IN (?) ORDER BY done_on DESC, id DESC`, [ids]);
  for (const s of list) log.set(s.vehicle_id, [...(log.get(s.vehicle_id) || []), { uuid: s.uuid, doneOn: s.done_on, odometer: s.odometer, what: s.what, shop: s.shop }]);
  return log;
}

async function all(profileId) {
  const [rows] = await pool.query(`SELECT ${COLUMNS} FROM athena_property_vehicle WHERE profile_id = ? ORDER BY created_at, id`, [profileId]);
  const ids = rows.map(r => r.id);
  const [log, recallLog] = await Promise.all([serviceFor(ids), recalls.forVehicles(ids)]);
  return rows.map(r => toVehicle(r, log, recallLog));
}

// Recalls are looked up from NHTSA when a vehicle is added or what it is
// changes. The answer to the save doesn't wait on NHTSA; the nightly step and
// the next list load pick the result up.
function lookUpRecalls(profileId, uuid) {
  recalls.refreshByUuid(profileId, uuid).catch(err => console.warn('[vehicles] recall lookup failed:', err.message));
}

async function owned(profileId, uuid) {
  const [rows] = await pool.query(`SELECT ${COLUMNS} FROM athena_property_vehicle WHERE profile_id = ? AND uuid = ? LIMIT 1`, [profileId, String(uuid || '')]);
  if (!rows.length) throw notFound();
  return rows[0];
}

/** The property a vehicle lives at: the one named, if it is theirs, else their first. */
async function propertyFor(profileId, wanted) {
  const [rows] = await pool.query('SELECT uuid FROM athena_property WHERE profile_id = ? ORDER BY uuid', [profileId]);
  if (!rows.length) throw bad('Add your property first — vehicles live at a property.');
  if (!wanted) return rows[0].uuid;
  if (!rows.some(r => r.uuid === wanted)) throw bad('That property is no longer on your list.');
  return wanted;
}

function handler(fn) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const actor = await requireAdultActor(req, res);
    if (!actor) return;
    try {
      res.json(await fn(actor.profileId, req));
    } catch (err) {
      if (err.status === 400 || err.status === 404) return res.status(err.status).json({ message: err.message });
      return res.status(503).json({ message: 'Vehicles are unavailable. Please try again; the vehicles migration must be installed.' });
    }
  };
}

const FIELDS = ['property_uuid', 'name', 'year', 'make', 'model', 'color', 'plate', 'vin', 'odometer', 'odometer_on',
  'registration_due', 'inspection_due', 'insurance_due', 'service_due', 'service_due_miles', 'notes'];
const values = f => [f.propertyUuid, f.name, f.year, f.make, f.model, f.color, f.plate, f.vin, f.odometer, f.odometerOn,
  f.registrationDue, f.inspectionDue, f.insuranceDue, f.serviceDue, f.serviceDueMiles, f.notes];

const list = handler(async profileId => ({ vehicles: await all(profileId) }));

const create = handler(async (profileId, req) => {
  const f = normalize(req.body);
  f.propertyUuid = await propertyFor(profileId, f.propertyUuid);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM athena_property_vehicle WHERE profile_id = ?', [profileId]);
  if (n >= MAX_VEHICLES) throw bad(`That is already ${MAX_VEHICLES} vehicles; remove one you no longer have first.`);
  const uuid = randomUUID();
  await pool.query(
    `INSERT INTO athena_property_vehicle (uuid, profile_id, ${FIELDS.join(', ')}, photo) VALUES (?, ?, ${FIELDS.map(() => '?').join(', ')}, ?)`,
    [uuid, profileId, ...values(f), f.photo ?? null]);
  lookUpRecalls(profileId, uuid);
  return { vehicles: await all(profileId) };
});

const update = handler(async (profileId, req) => {
  const row = await owned(profileId, req.params.uuid);
  const f = normalize(req.body, existingOf(row));
  if (req.body.propertyUuid !== undefined) f.propertyUuid = await propertyFor(profileId, f.propertyUuid);
  await pool.query(
    `UPDATE athena_property_vehicle SET ${FIELDS.map(c => `${c}=?`).join(', ')}${f.photo !== undefined ? ', photo=?' : ''} WHERE id = ? AND profile_id = ?`,
    [...values(f), ...(f.photo !== undefined ? [f.photo] : []), row.id, profileId]);
  if (f.vin !== row.vin || f.year !== row.year || f.make !== row.make || f.model !== row.model) lookUpRecalls(profileId, row.uuid);
  return { vehicles: await all(profileId) };
});

const remove = handler(async (profileId, req) => {
  const [result] = await pool.query('DELETE FROM athena_property_vehicle WHERE profile_id = ? AND uuid = ?', [profileId, String(req.params.uuid || '')]);
  if (!result.affectedRows) throw notFound();
  return { vehicles: await all(profileId) };
});

const getPhoto = handler(async (profileId, req) => {
  const row = await owned(profileId, req.params.uuid);
  const [[p]] = await pool.query('SELECT photo FROM athena_property_vehicle WHERE id = ?', [row.id]);
  return { image: p?.photo || null };
});

const addService = handler(async (profileId, req) => {
  const row = await owned(profileId, req.params.uuid);
  const s = service(req.body);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM athena_property_vehicle_service WHERE vehicle_id = ?', [row.id]);
  if (n >= MAX_SERVICE) throw bad(`That vehicle already has ${MAX_SERVICE} service entries.`);
  await pool.query('INSERT INTO athena_property_vehicle_service (uuid, vehicle_id, done_on, odometer, what, shop) VALUES (?, ?, ?, ?, ?, ?)',
    [randomUUID(), row.id, s.doneOn, s.odometer, s.what, s.shop]);
  // A service reading above the odometer on file is the newer reading.
  if (s.odometer !== null && (row.odometer === null || s.odometer > row.odometer)) {
    await pool.query('UPDATE athena_property_vehicle SET odometer = ?, odometer_on = ? WHERE id = ?', [s.odometer, s.doneOn, row.id]);
  }
  return { vehicles: await all(profileId) };
});

const removeService = handler(async (profileId, req) => {
  const row = await owned(profileId, req.params.uuid);
  const [result] = await pool.query('DELETE FROM athena_property_vehicle_service WHERE vehicle_id = ? AND uuid = ?', [row.id, String(req.params.serviceUuid || '')]);
  if (!result.affectedRows) throw Object.assign(new Error('That entry is no longer in this vehicle’s history.'), { status: 404 });
  return { vehicles: await all(profileId) };
});

// Done / doesn't apply / open again, on one of the person's own recalls.
const setRecall = handler(async (profileId, req) => {
  await recalls.setStatus(profileId, req.params.uuid, req.params.campaign, req.body?.status);
  return { vehicles: await all(profileId) };
});

/** Vehicles for Athena's prompt, with what is due and the latest service. Read-only; never throws. */
async function promptVehicles(profileId, limit = 6) {
  try {
    const [rows] = await pool.query(`SELECT ${COLUMNS} FROM athena_property_vehicle WHERE profile_id = ? ORDER BY created_at, id LIMIT ?`, [profileId, limit]);
    const ids = rows.map(r => r.id);
    const [log, recallLog] = await Promise.all([serviceFor(ids), recalls.forVehicles(ids).catch(() => new Map())]);
    return rows.map(r => {
      const v = toVehicle(r, log, recallLog);
      return { ...v, service: v.service.slice(0, 2), recalls: v.recalls.filter(x => x.status === 'open').slice(0, 4) };
    });
  } catch {
    return [];
  }
}

module.exports = { list, create, update, remove, getPhoto, addService, removeService, setRecall, normalize, service, promptVehicles };
