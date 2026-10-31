const pool = require('../helpers/db');
const { requireAdultActor } = require('../helpers/actor');
const media = require('../services/securityMedia');
const sightings = require('../services/sightings');
// The bridge client is shared with the Guardian Engine (services/guardianEngine).
const { configured, allowed, bridge } = require('../services/eufyBridge');

const BASE = '/api/v1/projects/property/security';
// Names from the last status read, so a kept image says which camera took it
// without trusting a name sent by the app.
const deviceNames = new Map();
const SERIAL = /^[A-Za-z0-9_-]{4,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const audit = (actor, action) => pool.query('INSERT INTO athena_access_audit (subject, action) VALUES (?, ?)', [String(actor.profileId), action]);

async function actorFor(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return null;
  // The paired-device token path can resolve to an adult profile. Security
  // media is a Companion sign-in capability, not a paired-device capability.
  if (actor.kind !== 'parent' || !allowed(actor.profileId)) {
    res.status(403).json({ message: 'Security access requires household authorization.' });
    return null;
  }
  return actor;
}

async function list(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  if (!configured()) return res.json({ status: 'not_connected', updatedAt: null, devices: [], events: [] });
  try {
    const upstream = await bridge('/v1/status');
    if (!upstream.ok) throw new Error('bridge_unavailable');
    const data = await upstream.json();
    for (const d of data.devices || []) if (d?.serial && d.name) deviceNames.set(d.serial, d.name);
    return res.json({ status: data.state, updatedAt: data.updatedAt, devices: data.devices, events: data.events });
  } catch {
    return res.status(503).json({ status: 'unavailable', devices: [], events: [], message: 'Security bridge is unavailable.' });
  }
}
async function snapshot(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  const serial = req.params.serial;
  const kind = req.query.kind;
  if (!SERIAL.test(serial) || !['fresh', 'stored'].includes(kind)) return res.status(400).json({ message: 'Invalid media request.' });
  try {
    // Fail closed if the access audit cannot be recorded. No media bytes are
    // forwarded into a prompt, response JSON, or a log.
    await audit(actor, kind === 'fresh' ? 'eufy_fresh_media' : 'eufy_stored_media');
    const upstream = await bridge(`/v1/devices/${serial}/snapshot?kind=${kind}`);
    if (!upstream.ok) return res.status(upstream.status === 422 ? 422 : 503).json({ message: 'Camera image is unavailable.' });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (upstream.headers.get('content-type') !== 'image/jpeg' || bytes.length > 5_000_000) throw new Error('bad_media');
    // Every fresh image is kept in the private bucket. Keeping it is not a
    // reason to withhold the image the person is waiting for, so a storage
    // failure is reported in a header rather than failing the request.
    let kept = null;
    if (kind === 'fresh') kept = await media.save({ profileId: actor.profileId, serial, deviceName: deviceNames.get(serial), type: 'image', buf: bytes }).catch(() => null);
    res.set('X-Athena-Kept', kept ? kept.id : 'no');
    res.set('Content-Type', 'image/jpeg');
    return res.send(bytes);
  } catch {
    return res.status(503).json({ message: 'Camera image is unavailable.' });
  }
}
/** Record a short clip now and keep it. Recording wakes the camera, so it only happens on request. */
async function clip(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  const serial = req.params.serial;
  const seconds = Number(req.body?.seconds ?? 15);
  if (!SERIAL.test(serial) || !Number.isInteger(seconds) || seconds < 5 || seconds > 30) return res.status(400).json({ message: 'Invalid clip request.' });
  try {
    await audit(actor, 'eufy_clip_media');
    const upstream = await bridge(`/v1/devices/${serial}/clip?seconds=${seconds}`, (seconds + 40) * 1000);
    if (!upstream.ok) return res.status(upstream.status === 422 ? 422 : 503).json({ message: 'Clip recording is unavailable.' });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (upstream.headers.get('content-type') !== 'video/mp4' || !bytes.length || bytes.length > 40_000_000) throw new Error('bad_media');
    const kept = await media.save({ profileId: actor.profileId, serial, deviceName: deviceNames.get(serial), type: 'clip', buf: bytes, durationSeconds: seconds });
    return res.status(201).json({ media: kept });
  } catch {
    return res.status(503).json({ message: 'Clip recording is unavailable.' });
  }
}
async function listMedia(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  try {
    return res.json({ media: await media.list() });
  } catch {
    return res.status(503).json({ message: 'Saved camera media is unavailable.', media: [] });
  }
}
async function getMedia(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  if (!UUID.test(req.params.id)) return res.status(400).json({ message: 'Invalid media id.' });
  try {
    await audit(actor, 'eufy_kept_media');
    const found = await media.open(req.params.id);
    if (!found) return res.status(404).json({ message: 'That image or clip is gone.' });
    res.set({ 'Content-Type': found.contentType, 'Content-Length': String(found.bytes), 'X-Content-Type-Options': 'nosniff' });
    const stream = found.file.createReadStream();
    stream.on('error', () => { if (!res.headersSent) res.status(503).json({ message: 'Saved camera media is unavailable.' }); else res.destroy(); });
    return stream.pipe(res);
  } catch {
    return res.status(503).json({ message: 'Saved camera media is unavailable.' });
  }
}
async function updateMedia(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  if (!UUID.test(req.params.id) || typeof req.body?.important !== 'boolean') return res.status(400).json({ message: 'Invalid media update.' });
  try {
    const updated = await media.setImportant(req.params.id, req.body.important);
    return updated ? res.json({ media: updated }) : res.status(404).json({ message: 'That image or clip is gone.' });
  } catch {
    return res.status(503).json({ message: 'Saved camera media is unavailable.' });
  }
}
async function removeMedia(req, res) {
  const actor = await actorFor(req, res);
  if (!actor) return;
  if (!UUID.test(req.params.id)) return res.status(400).json({ message: 'Invalid media id.' });
  try {
    await audit(actor, 'eufy_delete_media');
    return (await media.remove(req.params.id)) ? res.status(204).end() : res.status(404).json({ message: 'That image or clip is gone.' });
  } catch {
    return res.status(503).json({ message: 'Saved camera media is unavailable.' });
  }
}
// --- Sightings: gallery, zones, alert rules and the log (services/sightings.js) ---

/** Wrap a sightings call: authorized adult first, service errors with a status are the person's to read. */
const guarded = fn => async (req, res) => {
  const actor = await actorFor(req, res);
  if (!actor) return;
  try {
    return await fn(req, res, actor);
  } catch (error) {
    if (error.status && error.status < 500) return res.status(error.status).json({ message: error.message });
    console.warn('[security] sightings call failed', { message: error?.message });
    return res.status(503).json({ message: 'Sightings are unavailable right now.' });
  }
};
const sightingsOverview = guarded(async (req, res, actor) => {
  const people = await sightings.knownPeople(actor.profileId);
  const [subjects, zones, rules, recent] = await Promise.all([sightings.listSubjects(actor.profileId, people), sightings.listZones(), sightings.listRules(actor.profileId), sightings.page({ filter: req.query.filter, page: req.query.page })]);
  return res.json({ subjects, people: people.map(({ id, name, photoUrl }) => ({ id, name, hasPhoto: !!photoUrl })), zones, rules, ...recent, retentionDays: sightings.RETENTION_DAYS });
});
const createSubject = guarded(async (req, res, actor) => res.status(201).json({ id: await sightings.createSubject(actor.profileId, req.body || {}) }));
const updateSubject = guarded(async (req, res) => { await sightings.updateSubject(req.params.id, req.body || {}); return res.status(204).end(); });
const linkSubjectPerson = guarded(async (req, res, actor) => {
  if (!UUID.test(req.params.id) || (req.body?.factUuid !== null && !UUID.test(String(req.body?.factUuid || '')))) return res.status(400).json({ message: 'Pick a person from your app profile.' });
  await audit(actor, 'eufy_link_sighting_person');
  await sightings.linkPerson(actor.profileId, req.params.id, req.body.factUuid);
  return res.status(204).end();
});
const removeSubject = guarded(async (req, res, actor) => {
  await audit(actor, 'eufy_remove_subject');
  await sightings.removeSubject(req.params.id);
  return res.status(204).end();
});
const addSubjectPhoto = guarded(async (req, res) => {
  if (!UUID.test(String(req.body?.mediaId || ''))) return res.status(400).json({ message: 'Pick a kept image.' });
  await sightings.addPhoto(req.params.id, req.body.mediaId);
  return res.status(204).end();
});
const removeSubjectPhoto = guarded(async (req, res) => { await sightings.removePhoto(req.params.id, req.params.mediaId); return res.status(204).end(); });
const setZones = guarded(async (req, res) => { await sightings.setZones(req.params.serial, req.body?.zones); return res.status(204).end(); });
const createRule = guarded(async (req, res, actor) => res.status(201).json({ id: await sightings.createRule(actor.profileId, req.body || {}) }));
const updateRule = guarded(async (req, res, actor) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ message: 'Say whether the alert is on or off.' });
  await sightings.setRuleEnabled(actor.profileId, req.params.id, req.body.enabled);
  return res.status(204).end();
});
const removeRule = guarded(async (req, res, actor) => { await sightings.removeRule(actor.profileId, req.params.id); return res.status(204).end(); });
/** "This is…": the owner names one unnamed sighting (and any others they ticked). */
const teachSighting = guarded(async (req, res, actor) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ message: 'Invalid sighting id.' });
  const alsoIds = req.body?.alsoIds;
  if (alsoIds !== undefined && (!Array.isArray(alsoIds) || !alsoIds.every(id => UUID.test(String(id))))) return res.status(400).json({ message: 'Invalid sighting id.' });
  await audit(actor, 'eufy_teach_sighting');
  return res.json(await sightings.teachFromSighting(actor.profileId, req.params.id, req.body || {}));
});
const addSightingEntity = guarded(async (req, res, actor) => {
  if (!UUID.test(req.params.id) || !UUID.test(String(req.body?.subjectId || ''))) return res.status(400).json({ message: 'Pick a known person or animal.' });
  await audit(actor, 'eufy_add_sighting_entity');
  return res.status(201).json(await sightings.addEntityFromSighting(req.params.id, req.body.subjectId));
});
const sightingFrame = guarded(async (req, res, actor) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ message: 'Invalid sighting id.' });
  await audit(actor, 'eufy_sighting_frame');
  const file = await sightings.openFrame(req.params.id);
  if (!file) return res.status(404).json({ message: 'That frame is gone.' });
  res.set({ 'Content-Type': 'image/jpeg', 'X-Content-Type-Options': 'nosniff' });
  const stream = file.createReadStream();
  stream.on('error', () => { if (!res.headersSent) res.status(404).json({ message: 'That frame is gone.' }); else res.destroy(); });
  return stream.pipe(res);
});

module.exports = { list, snapshot, clip, listMedia, getMedia, updateMedia, removeMedia, BASE, actorFor,
  sightingsOverview, createSubject, updateSubject, linkSubjectPerson, removeSubject, addSubjectPhoto, removeSubjectPhoto, setZones, createRule, updateRule, removeRule, sightingFrame, teachSighting, addSightingEntity };
