/**
 * The one client for the household Eufy bridge (eufy-bridge/server.mjs).
 *
 * Moved out of controllers/propertySecurity.js on 2026-10-23 so the Guardian
 * Engine (services/guardianEngine) reads the same fixed private endpoint
 * through the same checks instead of a second copy of them. The bridge is
 * read-only: status, fresh/stored JPEGs and short clips. Only the core
 * service can reach it — it sits on the tailnet; the Cloud Run Jobs do not.
 */
const { ProxyAgent } = require('undici');

let tailnetProxy;

const configured = () => Boolean(process.env.EUFY_BRIDGE_URL && process.env.EUFY_BRIDGE_TOKEN);
/** The household adults allowed to see camera media (and, so, Guardian status). */
const authorizedProfileIds = () => (process.env.EUFY_AUTHORIZED_PROFILE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const allowed = profileId => new Set(authorizedProfileIds()).has(String(profileId));

function bridgeDispatcher(root) {
  const proxy = process.env.EUFY_TAILSCALE_HTTP_PROXY;
  if (!proxy) return undefined;
  // The proxy is local to the Cloud Run container. Keep its use scoped to the
  // one HTTPS tailnet destination, never to other provider or model traffic.
  if (root.protocol !== 'https:' || !root.hostname.endsWith('.ts.net') || proxy !== 'http://127.0.0.1:1055') throw new Error('invalid_tailnet_config');
  if (!tailnetProxy) tailnetProxy = new ProxyAgent(proxy);
  return tailnetProxy;
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

const SERIAL = /^[A-Za-z0-9_-]{4,40}$/;

/** The bridge's status: { state, updatedAt, devices, events }. Throws when unreachable. */
async function status() {
  const upstream = await bridge('/v1/status');
  if (!upstream.ok) throw new Error('bridge_unavailable');
  return upstream.json();
}

/**
 * Can core reach the bridge, and is it working? Never throws.
 * { reachable: true, state } when it answered (state is the bridge's own:
 * ready | reconnecting | authorization_required | connecting), or
 * { reachable: false, error } when nothing answered (host or tailnet down,
 * timeout, non-2xx). A short timeout: this is a health probe, not a capture.
 */
async function health() {
	if (!configured()) return { reachable: false, error: 'not_configured', configured: false };
	try {
		const upstream = await bridge('/v1/status', 10_000);
		if (!upstream.ok) return { reachable: false, error: `bridge_http_${upstream.status}`, configured: true };
		const body = await upstream.json();
		return { reachable: true, state: String(body?.state || 'unknown'), devices: Array.isArray(body?.devices) ? body.devices.length : 0, configured: true };
	} catch (error) {
		return { reachable: false, error: error?.name === 'TimeoutError' ? 'timeout' : String(error?.cause?.code || error?.message || 'unreachable').slice(0, 80), configured: true };
	}
}

/**
 * A fresh JPEG from one camera, captured for this request. Never a stored
 * thumbnail, never a retained still (the bridge answers 409 for one).
 * Resolves { ok: true, jpeg, capturedAt, latencyMs } or { ok: false, reason }.
 */
async function freshSnapshot(serial) {
  if (!SERIAL.test(String(serial || ''))) return { ok: false, reason: 'invalid_serial' };
  const started = Date.now();
  let upstream;
  try {
    upstream = await bridge(`/v1/devices/${serial}/snapshot?kind=fresh`);
  } catch (error) {
    return { ok: false, reason: error?.message === 'unconfigured' ? 'not_configured' : 'bridge_unreachable' };
  }
  if (!upstream.ok) {
    const reason = upstream.status === 404 ? 'device_unavailable' : upstream.status === 409 ? 'station_busy' : upstream.status === 422 ? 'no_fresh_capability' : 'capture_failed';
    return { ok: false, reason };
  }
  const jpeg = Buffer.from(await upstream.arrayBuffer());
  if (upstream.headers.get('content-type') !== 'image/jpeg' || !jpeg.length || jpeg.length > 5_000_000) return { ok: false, reason: 'bad_media' };
  return { ok: true, jpeg, capturedAt: new Date(), latencyMs: Date.now() - started };
}

module.exports = { configured, allowed, authorizedProfileIds, bridge, status, health, freshSnapshot, SERIAL };
