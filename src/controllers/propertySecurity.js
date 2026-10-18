const pool = require('../helpers/db');
const { requireAdultActor } = require('../helpers/actor');
const { ProxyAgent } = require('undici');
const media = require('../services/securityMedia');

const BASE = '/api/v1/projects/property/security';
const configured = () => Boolean(process.env.EUFY_BRIDGE_URL && process.env.EUFY_BRIDGE_TOKEN);
const allowed = profileId => new Set((process.env.EUFY_AUTHORIZED_PROFILE_IDS || '').split(',').map(s => s.trim()).filter(Boolean)).has(String(profileId));
let tailnetProxy;
// Names from the last status read, so a kept image says which camera took it
// without trusting a name sent by the app.
const deviceNames = new Map();
const SERIAL = /^[A-Za-z0-9_-]{4,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const audit = (actor, action) => pool.query('INSERT INTO athena_access_audit (subject, action) VALUES (?, ?)', [String(actor.profileId), action]);

function bridgeDispatcher(root) {
  const proxy = process.env.EUFY_TAILSCALE_HTTP_PROXY;
  if (!proxy) return undefined;
  // The proxy is local to the Cloud Run container. Keep its use scoped to the
  // one HTTPS tailnet destination, never to other provider or model traffic.
  if (root.protocol !== 'https:' || !root.hostname.endsWith('.ts.net') || proxy !== 'http://127.0.0.1:1055') throw new Error('invalid_tailnet_config');
  if (!tailnetProxy) tailnetProxy = new ProxyAgent(proxy);
  return tailnetProxy;
}

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
async function bridge(path, timeoutMs = 25_000) {
  const base = process.env.EUFY_BRIDGE_URL;
  if (!base || !process.env.EUFY_BRIDGE_TOKEN) throw new Error('unconfigured');
  const root = new URL(base);
  // The operator configures this fixed private endpoint. No request URL or
  // model-provided address may select a network destination.
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) throw new Error('invalid_bridge_config');
  const url = new URL(path, root);
  if (url.origin !== root.origin) throw new Error('invalid_bridge_path');
  return fetch(url, { headers: { Authorization: `Bearer ${process.env.EUFY_BRIDGE_TOKEN}` }, signal: AbortSignal.timeout(timeoutMs), dispatcher: bridgeDispatcher(root) });
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
module.exports = { list, snapshot, clip, listMedia, getMedia, updateMedia, removeMedia, BASE };
