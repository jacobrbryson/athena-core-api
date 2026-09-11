/**
 * Paired devices — Athena on a phone or car head unit.
 *
 * Web sessions use IP-pinned JWTs, which break on phones that hop between
 * Wi-Fi and cellular. Devices instead pair once:
 *
 *   1. In the Companion app (signed in), the owner creates a pairing code —
 *      8 characters, valid 10 minutes, shown as text + QR.
 *   2. The device redeems it (POST /devices/pair) for an opaque device token.
 *   3. The device sends `X-Athena-Device-Token` on every request. Only the
 *      token's sha256 is stored; each request re-checks it (60s cache), so a
 *      revoke in the Companion app takes effect within a minute.
 *
 * Adult profiles only.
 */
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const pool = require("../helpers/db");

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
const CODE_TTL_MIN = 10;
const AUTH_CACHE_MS = 60_000;
const PLATFORMS = new Set(["android", "car", "web"]);

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const authCache = new Map(); // tokenHash -> { device, at }

function randomCode() {
	const bytes = crypto.randomBytes(8);
	let code = "";
	for (let i = 0; i < 8; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
	return `${code.slice(0, 4)}-${code.slice(4)}`;
}

const normalizeCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

async function createPairingCode(profileId, { name, platform } = {}) {
	const code = randomCode();
	const uuid = uuidv4();
	await pool.query(
		`INSERT INTO paired_device (uuid, profile_id, name, platform, pairing_code_hash, pairing_expires_at)
     VALUES (?, ?, ?, ?, ?, NOW() + INTERVAL ${CODE_TTL_MIN} MINUTE);`,
		[
			uuid,
			profileId,
			typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : "New device",
			PLATFORMS.has(platform) ? platform : "android",
			sha256(normalizeCode(code)),
		]
	);
	return { code, device_uuid: uuid, expires_in: CODE_TTL_MIN * 60 };
}

/** Redeem a pairing code. Returns { device_token, device_uuid, profile_uuid } or null. */
async function redeemPairingCode(code, { name, platform } = {}) {
	const normalized = normalizeCode(code);
	if (normalized.length !== 8) return null;
	const [rows] = await pool.query(
		`SELECT d.id, d.uuid, p.uuid AS profile_uuid FROM paired_device d
     JOIN profile p ON p.id = d.profile_id
     WHERE d.pairing_code_hash = ? AND d.pairing_expires_at > NOW()
       AND d.token_hash IS NULL AND d.revoked_at IS NULL LIMIT 1;`,
		[sha256(normalized)]
	);
	if (!rows.length) return null;

	const token = `athd_${crypto.randomBytes(32).toString("base64url")}`;
	const [result] = await pool.query(
		`UPDATE paired_device
     SET token_hash = ?, pairing_code_hash = NULL, pairing_expires_at = NULL, last_seen_at = NOW(),
         name = COALESCE(?, name), platform = COALESCE(?, platform)
     WHERE id = ? AND token_hash IS NULL;`,
		[
			sha256(token),
			typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : null,
			PLATFORMS.has(platform) ? platform : null,
			rows[0].id,
		]
	);
	if (!result.affectedRows) return null; // raced with another redeem
	return { device_token: token, device_uuid: rows[0].uuid, profile_uuid: rows[0].profile_uuid };
}

/** Resolve a device token to { deviceId, deviceUuid, profileId } or null. */
async function authenticateDeviceToken(token) {
	if (typeof token !== "string" || !token.startsWith("athd_") || token.length > 200) return null;
	const hash = sha256(token);
	const hit = authCache.get(hash);
	if (hit && Date.now() - hit.at < AUTH_CACHE_MS) return hit.device;

	const [rows] = await pool.query(
		`SELECT id, uuid, profile_id, platform FROM paired_device
     WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1;`,
		[hash]
	);
	const device = rows.length
		? { deviceId: rows[0].id, deviceUuid: rows[0].uuid, profileId: Number(rows[0].profile_id), platform: rows[0].platform }
		: null;
	authCache.set(hash, { device, at: Date.now() });
	if (device) {
		pool.query(`UPDATE paired_device SET last_seen_at = NOW() WHERE id = ?;`, [device.deviceId]).catch(() => undefined);
	}
	return device;
}

async function listDevices(profileId) {
	const [rows] = await pool.query(
		`SELECT uuid, name, platform, capabilities, last_seen_at, created_at FROM paired_device
     WHERE profile_id = ? AND token_hash IS NOT NULL AND revoked_at IS NULL
     ORDER BY last_seen_at DESC;`,
		[profileId]
	);
	return rows.map((r) => ({
		uuid: r.uuid,
		name: r.name,
		platform: r.platform,
		capabilities: typeof r.capabilities === "string" ? JSON.parse(r.capabilities) : r.capabilities,
		last_seen_at: r.last_seen_at,
		created_at: r.created_at,
	}));
}

async function revokeDevice(profileId, deviceUuid) {
	const [result] = await pool.query(
		`UPDATE paired_device SET revoked_at = NOW() WHERE uuid = ? AND profile_id = ? AND revoked_at IS NULL;`,
		[deviceUuid, profileId]
	);
	authCache.clear();
	if (!result.affectedRows) throw new Error("Device not found");
	return { success: true };
}

/** Store the device's self-reported model/runtime capabilities (manifest loop). */
async function recordCapabilities(deviceId, report = {}) {
	const caps = {
		platform: typeof report.platform === "string" ? report.platform.slice(0, 20) : null,
		ramGb: Number.isFinite(Number(report.ramGb)) ? Number(report.ramGb) : null,
		runtimes: Array.isArray(report.runtimes) ? report.runtimes.map(String).slice(0, 12) : [],
		installed: Array.isArray(report.installed)
			? report.installed.slice(0, 12).map((m) => ({ id: String(m?.id || "").slice(0, 60), sha256: String(m?.sha256 || "").slice(0, 64) }))
			: [],
		manifestVersion: typeof report.manifestVersion === "string" ? report.manifestVersion.slice(0, 20) : null,
		reportedAt: new Date().toISOString(),
	};
	await pool.query(`UPDATE paired_device SET capabilities = ? WHERE id = ?;`, [JSON.stringify(caps), deviceId]);
	return caps;
}

module.exports = {
	createPairingCode,
	redeemPairingCode,
	authenticateDeviceToken,
	listDevices,
	revokeDevice,
	recordCapabilities,
	normalizeCode,
	_clearCache: () => authCache.clear(),
};
