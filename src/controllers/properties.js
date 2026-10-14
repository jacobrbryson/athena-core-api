const { randomUUID } = require('node:crypto');
const pool = require('../helpers/db');
const { requireAdultActor } = require('../helpers/actor');

const bad = message => Object.assign(new Error(message), { status: 400 });
function normalize(input) {
  if (!input || typeof input !== 'object') throw bad('Invalid property details.');
  const text = (value, max) => {
    if (typeof value !== 'string' || value.length > max) throw bad('Invalid property details.');
    return value.trim();
  };
  const image = value => {
    if (!value) return '';
    if (typeof value !== 'string' || value.length > 1500000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value)) throw bad('Upload a JPEG property image.');
    return value;
  };
  const point = p => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 100 || p.y < 0 || p.y > 100) throw bad('Invalid map position.');
    return { x: p.x, y: p.y };
  };
  const ids = values => {
    if (!Array.isArray(values) || values.length > 1000 || values.some(v => typeof v !== 'string' || !/^[a-f0-9-]{36}$/i.test(v))) throw bad('Invalid area links.');
    return [...new Set(values)];
  };
  if (!Array.isArray(input.areas) || input.areas.length > 50 || !Array.isArray(input.boundary) || input.boundary.length > 100) throw bad('Too many map features.');
  const name = text(input.name, 190);
  if (!name) throw bad('Give your property a name.');
  const acreage = input.acreage === '' ? null : Number(input.acreage);
  if (acreage !== null && (!Number.isFinite(acreage) || acreage < 0 || acreage > 1e9)) throw bad('Enter a valid acreage.');
  return { name, address: text(input.address, 500), description: text(input.description, 2000), acreage,
    headerImage: image(input.headerImage), mapImage: image(input.mapImage), boundary: input.boundary.map(point),
    areas: input.areas.map(a => ({ ...point(a), name: text(a.name, 100), projects: ids(a.projects), concerns: ids(a.concerns) })) };
}
async function handle(req, res, save) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    if (save) {
      const details = normalize(req.body);
      const projectIds = [...new Set(details.areas.flatMap(a => a.projects))];
      const concernIds = [...new Set(details.areas.flatMap(a => a.concerns))];
      for (const [table, ids] of [['athena_project', projectIds], ['athena_concern', concernIds]]) {
        if (!ids.length) continue;
        const [owned] = await pool.query(`SELECT uuid FROM ${table} WHERE profile_id = ? AND uuid IN (?)`, [actor.profileId, ids]);
        if (owned.length !== ids.length) throw bad('Some linked projects or concerns are no longer on your list.');
      }
      // The first property is today's primary property; UUIDs leave room for multiple properties later.
      const [rows] = await pool.query('SELECT uuid FROM athena_property WHERE profile_id = ? ORDER BY uuid LIMIT 1', [actor.profileId]);
      const uuid = rows[0]?.uuid || randomUUID();
      await pool.query('INSERT INTO athena_property (uuid, profile_id, details) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE details = VALUES(details)', [uuid, actor.profileId, JSON.stringify(details)]);
    }
    const [rows] = await pool.query('SELECT uuid, details FROM athena_property WHERE profile_id = ? ORDER BY uuid', [actor.profileId]);
    res.json({ properties: rows.map(r => ({ uuid: r.uuid, ...JSON.parse(r.details) })) });
  } catch (err) {
    res.status(err.status === 400 ? 400 : 503).json({ message: err.status === 400 ? err.message : 'Property details are unavailable. Please try again; the property migration must be installed.' });
  }
}
async function weather(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    const [rows] = await pool.query('SELECT details FROM athena_property WHERE profile_id = ? ORDER BY uuid LIMIT 1', [actor.profileId]);
    const address = rows[0] ? JSON.parse(rows[0].details).address : '';
    if (!address) return res.json({ status: 'no_address', weather: null });
    const sky = await require('../services/propertyWeather').read(actor.profileId, address);
    return res.json({ status: sky ? 'ready' : 'unavailable', weather: sky });
  } catch {
    return res.status(503).json({ message: 'Property weather is unavailable right now.' });
  }
}
module.exports = { list: (req, res) => handle(req, res, false), save: (req, res) => handle(req, res, true), weather, normalize };
