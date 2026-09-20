const pool = require("../helpers/db");

const DEFAULT_PREF = { enabled: false, interval_seconds: 900, retention_days: 2 };
const MIN_INTERVAL = 60;
const MAX_INTERVAL = 3600;

function numberOrNull(value, min, max) {
	if (value === null || value === undefined || value === "") return null;
	const n = Number(value);
	return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

async function getPref(profileId) {
	const [rows] = await pool.query(
		"SELECT enabled, interval_seconds, retention_days FROM athena_location_pref WHERE profile_id = ? LIMIT 1",
		[profileId]
	);
	if (!rows[0]) return { ...DEFAULT_PREF };
	return {
		enabled: rows[0].enabled === 1,
		interval_seconds: Number(rows[0].interval_seconds),
		retention_days: Number(rows[0].retention_days),
	};
}

async function setPref(profileId, patch = {}) {
	const current = await getPref(profileId);
	const next = {
		enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
		interval_seconds: Math.round(numberOrNull(patch.interval_seconds, MIN_INTERVAL, MAX_INTERVAL) ?? current.interval_seconds),
		retention_days: Math.round(numberOrNull(patch.retention_days, 1, 7) ?? current.retention_days),
	};
	await pool.query(
		`INSERT INTO athena_location_pref (profile_id, enabled, interval_seconds, retention_days)
		 VALUES (?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), interval_seconds = VALUES(interval_seconds),
		 retention_days = VALUES(retention_days)`,
		[profileId, next.enabled ? 1 : 0, next.interval_seconds, next.retention_days]
	);
	if (!next.enabled) {
		await pool.query("DELETE FROM athena_location_sample WHERE profile_id = ?", [profileId]);
	}
	return next;
}

function normalizeObservedAt(value) {
	const date = new Date(value);
	if (!value || Number.isNaN(date.getTime())) return null;
	const age = Date.now() - date.getTime();
	if (age < -5 * 60 * 1000 || age > 24 * 60 * 60 * 1000) return null;
	return date;
}

async function recordSample({ profileId, deviceId, body }) {
	const pref = await getPref(profileId);
	if (!pref.enabled) {
		const err = new Error("Location sharing is not enabled");
		err.status = 403;
		err.code = "location_not_enabled";
		throw err;
	}
	const rawLatitude = numberOrNull(body?.latitude, -90, 90);
	const rawLongitude = numberOrNull(body?.longitude, -180, 180);
	const observedAt = normalizeObservedAt(body?.observed_at);
	if (rawLatitude === null || rawLongitude === null || !observedAt) {
		const err = new Error("A valid latitude, longitude, and observed_at are required");
		err.status = 400;
		throw err;
	}
	// Keep the useful area-level context, not a sub-metre breadcrumb trail.
	const latitude = Math.round(rawLatitude * 10000) / 10000;
	const longitude = Math.round(rawLongitude * 10000) / 10000;
	const values = {
		accuracy_m: numberOrNull(body.accuracy_m, 0, 100000),
		altitude_m: numberOrNull(body.altitude_m, -1000, 100000),
		speed_mps: numberOrNull(body.speed_mps, 0, 1000),
		bearing_deg: numberOrNull(body.bearing_deg, 0, 360),
	};
	await pool.query(
		`INSERT IGNORE INTO athena_location_sample
		 (profile_id, device_id, latitude, longitude, accuracy_m, altitude_m, speed_mps, bearing_deg, observed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[profileId, deviceId, latitude, longitude, values.accuracy_m, values.altitude_m, values.speed_mps, values.bearing_deg, observedAt]
	);
	const cutoff = new Date(Date.now() - pref.retention_days * 24 * 60 * 60 * 1000);
	await pool.query("DELETE FROM athena_location_sample WHERE profile_id = ? AND observed_at < ?", [profileId, cutoff]);
	return { accepted: true, observed_at: observedAt.toISOString(), interval_seconds: pref.interval_seconds };
}

async function recent(profileId) {
	const [rows] = await pool.query(
		`SELECT s.latitude, s.longitude, s.accuracy_m, s.altitude_m, s.speed_mps,
		 s.bearing_deg, s.observed_at, s.received_at, d.uuid AS device_uuid
		 FROM athena_location_sample s JOIN paired_device d ON d.id = s.device_id
		 WHERE s.profile_id = ? ORDER BY s.observed_at DESC LIMIT 50`,
		[profileId]
	);
	return rows;
}

module.exports = { getPref, setPref, recordSample, recent };
