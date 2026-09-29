const pool = require("../helpers/db");
const credentials = require("./credentials");
const whoop = require("./connectors/whoop");

/**
 * Live heart rate from the paired Android phone (HeartRateService.java reads a
 * WHOOP "Heart Rate Broadcast" or any standard Bluetooth heart-rate strap).
 *
 * Deliberately a dumb store. The owner's instruction (2026-09-29) was to keep
 * this "a dumb system she can check": there is no initiative trigger and no
 * server-side judgement of what is unusual. Exercise limits are checked and
 * spoken on the phone, which must work with no signal. The server keeps
 * one-minute summaries and hands the recent numbers to a conversation that is
 * about them (buildContext).
 *
 * Health data, so: adults only, off unless switched on (no pref row = off),
 * minute summaries only — never beats — kept for `retention_days` (30 by
 * default, 7–30), purged on every upload, and deleted outright when switched off.
 */

const DEFAULT_PREF = { enabled: false, retention_days: 30 };
const MIN_RETENTION = 7;
const MAX_RETENTION = 30;
/** A day of minutes: the phone queues at most 24h while offline. */
const MAX_BATCH = 1440;
const SPORTS = new Set(["ride", "run"]);
const CROSSINGS = new Set(["above", "below"]);

async function getPref(profileId) {
	const [rows] = await pool.query(
		"SELECT enabled, retention_days FROM athena_heart_pref WHERE profile_id = ? LIMIT 1",
		[profileId]
	);
	if (!rows[0]) return { ...DEFAULT_PREF };
	return { enabled: rows[0].enabled === 1, retention_days: Number(rows[0].retention_days) };
}

async function setPref(profileId, patch = {}) {
	const current = await getPref(profileId);
	const days = Number(patch.retention_days);
	const next = {
		enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
		retention_days:
			Number.isInteger(days) && days >= MIN_RETENTION && days <= MAX_RETENTION ? days : current.retention_days,
	};
	await pool.query(
		`INSERT INTO athena_heart_pref (profile_id, enabled, retention_days) VALUES (?, ?, ?)
		 ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), retention_days = VALUES(retention_days)`,
		[profileId, next.enabled ? 1 : 0, next.retention_days]
	);
	if (!next.enabled) {
		await pool.query("DELETE FROM athena_heart_minute WHERE profile_id = ?", [profileId]);
	} else if (next.retention_days < current.retention_days) {
		await purge(profileId, next.retention_days);
	}
	return next;
}

function purge(profileId, retentionDays) {
	const cutoff = new Date(Date.now() - retentionDays * 86400_000);
	return pool.query("DELETE FROM athena_heart_minute WHERE profile_id = ? AND minute_at < ?", [profileId, cutoff]);
}

function bpm(value) {
	const n = Number(value);
	return Number.isInteger(n) && n >= 25 && n <= 250 ? n : null;
}

/** One uploaded minute, or null if any part of it is not a plausible summary. */
function normalizeMinute(raw, now = Date.now()) {
	if (!raw || typeof raw !== "object") return null;
	const at = new Date(raw.minute_at);
	if (Number.isNaN(at.getTime())) return null;
	const age = now - at.getTime();
	if (age < -5 * 60_000 || age > 24 * 3600_000) return null;
	at.setUTCSeconds(0, 0);
	const min = bpm(raw.bpm_min);
	const avg = bpm(raw.bpm_avg);
	const max = bpm(raw.bpm_max);
	const readings = Number(raw.readings);
	if (min === null || avg === null || max === null || !(min <= avg && avg <= max)) return null;
	if (!Number.isInteger(readings) || readings < 1 || readings > 400) return null;
	const source = typeof raw.source === "string" && /^[a-z0-9_]{1,32}$/.test(raw.source) ? raw.source : null;
	if (!source) return null;
	return {
		minute_at: at,
		bpm_min: min,
		bpm_avg: avg,
		bpm_max: max,
		readings,
		source,
		session_sport: SPORTS.has(raw.session_sport) ? raw.session_sport : null,
		limit_crossed: CROSSINGS.has(raw.limit_crossed) ? raw.limit_crossed : null,
	};
}

async function recordMinutes({ profileId, deviceId, body }) {
	const pref = await getPref(profileId);
	if (!pref.enabled) {
		const err = new Error("Heart rate is not switched on");
		err.status = 403;
		err.code = "heart_rate_not_enabled";
		throw err;
	}
	const list = Array.isArray(body?.minutes) ? body.minutes : null;
	if (!list || list.length === 0 || list.length > MAX_BATCH) {
		const err = new Error(`Send between 1 and ${MAX_BATCH} minutes`);
		err.status = 400;
		throw err;
	}
	const now = Date.now();
	const rows = list.map((m) => normalizeMinute(m, now)).filter(Boolean);
	if (rows.length) {
		await pool.query(
			`INSERT IGNORE INTO athena_heart_minute
			 (profile_id, device_id, minute_at, bpm_min, bpm_avg, bpm_max, readings, source, session_sport, limit_crossed)
			 VALUES ?`,
			[
				rows.map((r) => [
					profileId, deviceId, r.minute_at, r.bpm_min, r.bpm_avg, r.bpm_max,
					r.readings, r.source, r.session_sport, r.limit_crossed,
				]),
			]
		);
	}
	await purge(profileId, pref.retention_days);
	// Rejected minutes are dropped, not retried: the phone clears its queue on
	// any 2xx, and a malformed minute would otherwise block every later one.
	return { accepted: rows.length, rejected: list.length - rows.length };
}

async function recent(profileId, { minutes = 60 } = {}) {
	const span = Math.max(1, Math.min(Number(minutes) || 60, 24 * 60));
	const [rows] = await pool.query(
		`SELECT minute_at, bpm_min, bpm_avg, bpm_max, readings, source, session_sport, limit_crossed
		 FROM athena_heart_minute WHERE profile_id = ? AND minute_at >= ?
		 ORDER BY minute_at DESC LIMIT 1440`,
		[profileId, new Date(Date.now() - span * 60_000)]
	);
	return rows;
}

// ---------------------------------------------------------------------------
// Conversation grounding
// ---------------------------------------------------------------------------

const KEYWORDS =
	/\b(heart ?rate|heart|pulse|bpm|hr|stress(ed|ful)?|anxious|nervous|panick?(ed|ing|y)?|calm(er)?|zones?|limits?|ride|riding|biking|cycling|run|running|jog(ging)?|workout|exercis\w*|resting)\b/i;

function matches(message) {
	return typeof message === "string" && KEYWORDS.test(message);
}

function ago(date, now) {
	const mins = Math.round((now - new Date(date).getTime()) / 60_000);
	if (mins <= 1) return "just now";
	if (mins < 90) return `${mins} minutes ago`;
	return `${Math.round(mins / 60)} hours ago`;
}

/**
 * Plain numbers for the prompt — what the phone has recorded recently and the
 * person's own typical resting-time average. Judgement is left to the
 * conversation; nothing here decides that anything is wrong.
 */
/** The latest WHOOP resting heart rate, when WHOOP is linked; null otherwise, never throws. */
async function whoopRestingHeartRate(profileId) {
	try {
		const links = await credentials.list(profileId);
		if (!links.some((l) => l.provider === "whoop" && l.status === "active")) return null;
		const latest = (await whoop.listRecovery(profileId, { days: 3 })).find((r) => r.resting_heart_rate !== null);
		return latest ? Number(latest.resting_heart_rate) : null;
	} catch {
		return null;
	}
}

/** `force`: the fast guess (services/toolIntent) picked heart rate though no keyword did. */
async function buildContext(profileId, { message, audience, force = false } = {}) {
	if (!profileId || audience !== "adult" || !(force || matches(message))) return null;
	const pref = await getPref(profileId);
	if (!pref.enabled) return null;

	const now = Date.now();
	const [hourRows] = await pool.query(
		`SELECT minute_at, bpm_min, bpm_avg, bpm_max, session_sport, limit_crossed
		 FROM athena_heart_minute WHERE profile_id = ? AND minute_at >= ? ORDER BY minute_at DESC`,
		[profileId, new Date(now - 24 * 3600_000)]
	);
	const restingPromise = whoopRestingHeartRate(profileId);
	const [typicalRows] = await pool.query(
		`SELECT ROUND(AVG(bpm_avg)) AS typical, COUNT(*) AS minutes FROM athena_heart_minute
		 WHERE profile_id = ? AND session_sport IS NULL AND minute_at >= ?`,
		[profileId, new Date(now - pref.retention_days * 86400_000)]
	);

	const lines = ["Live heart rate (from the person's own Bluetooth band via their Android phone, one-minute summaries):"];
	if (!hourRows.length) {
		lines.push("- Nothing recorded in the last 24 hours — the phone isn't connected to the band right now, or hasn't been.");
	} else {
		const latest = hourRows[0];
		lines.push(`- Latest minute: avg ${latest.bpm_avg} bpm (range ${latest.bpm_min}–${latest.bpm_max}), ${ago(latest.minute_at, now)}.`);
		const lastHour = hourRows.filter((r) => now - new Date(r.minute_at).getTime() <= 3600_000);
		if (lastHour.length > 1) {
			const avg = Math.round(lastHour.reduce((s, r) => s + r.bpm_avg, 0) / lastHour.length);
			const lo = Math.min(...lastHour.map((r) => r.bpm_min));
			const hi = Math.max(...lastHour.map((r) => r.bpm_max));
			lines.push(`- Last hour (${lastHour.length} minutes recorded): avg ${avg}, low ${lo}, high ${hi}.`);
		}
		const sessions = [...new Set(hourRows.filter((r) => r.session_sport).map((r) => r.session_sport))];
		if (sessions.length) lines.push(`- Exercise sessions with limits in the last 24h: ${sessions.join(", ")}.`);
		const crossings = hourRows.filter((r) => r.limit_crossed);
		if (crossings.length) {
			lines.push(
				`- Limit crossings in the last 24h (the phone already told them out loud): ` +
					crossings.slice(0, 5).map((r) => `${r.limit_crossed} at ${ago(r.minute_at, now)}`).join("; ") + "."
			);
		}
	}
	const typical = typicalRows[0];
	if (typical && Number(typical.minutes) >= 60) {
		lines.push(`- Their typical average outside exercise sessions, over the last ${pref.retention_days} days: ${typical.typical} bpm.`);
	}
	const restingHeartRate = await restingPromise;
	if (Number.isFinite(restingHeartRate)) {
		lines.push(`- WHOOP resting heart rate (latest recovery): ${Math.round(restingHeartRate)} bpm.`);
	}
	lines.push(
		"These are consumer-band readings, not a medical device. Describe what the numbers show; do not diagnose. " +
			"If something looks alarming, say so plainly and suggest they check how they feel or seek care."
	);
	return lines.join("\n");
}

module.exports = {
	DEFAULT_PREF,
	getPref,
	setPref,
	recordMinutes,
	recent,
	matches,
	normalizeMinute,
	buildContext,
};
