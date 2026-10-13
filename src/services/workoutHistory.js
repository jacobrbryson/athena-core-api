const pool = require("../helpers/db");
const consent = require("./consent");
const audience = require("./audience");

/**
 * Workout history — athena_workout (migration 0067).
 *
 * A provider's API answers a conversation 25 workouts at a time; this table is
 * what lets Athena look back months. Rows come from whatever already read a
 * workout (a signed webhook, a chat or dashboard read, the activity-review
 * sync, the backfill script), so recording never adds a provider call of its
 * own.
 *
 * Recording is gated the same way activity reviews are: an adult whose family
 * has accepted health_data consent. Children's workouts are never kept.
 */

const PROVIDER = "whoop";
const MAX_DAYS = 3650;

async function mayRecord(profileId) {
	if (!profileId) return false;
	if ((await audience.audienceForProfile(profileId)) !== "adult") return false;
	return consent.hasConsentForProfile(profileId, "health_data");
}

const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const date = (v) => {
	const d = v ? new Date(v) : null;
	return d && Number.isFinite(d.getTime()) ? d : null;
};

function rowOf(profileId, w) {
	const started = date(w.start), ended = date(w.end);
	if (!w?.id || !started || !ended) return null;
	return [
		profileId, PROVIDER, String(w.id).toLowerCase(),
		w.user_id === null || w.user_id === undefined ? null : String(w.user_id),
		typeof w.sport === "string" ? w.sport.slice(0, 64) : null,
		Number.isSafeInteger(w.sport_id) ? w.sport_id : null,
		started, ended, w.timezone_offset || null, w.score_state || null,
		num(w.strain), num(w.average_heart_rate), num(w.max_heart_rate), num(w.kilojoules),
		num(w.percent_recorded), num(w.distance_meter), num(w.altitude_gain_meter), num(w.altitude_change_meter),
		w.zone_durations && typeof w.zone_durations === "object" ? JSON.stringify(w.zone_durations) : null,
		date(w.updated_at),
	];
}

/**
 * Upsert normalized WHOOP workouts (connectors/whoop.js normalizeWorkout).
 * A workout the provider returns is present, so this also clears a stale
 * deleted_at. Returns how many were written; 0 when the profile may not record.
 */
async function record(profileId, workouts) {
	const rows = (Array.isArray(workouts) ? workouts : []).map((w) => rowOf(profileId, w)).filter(Boolean);
	if (!rows.length || !(await mayRecord(profileId))) return 0;
	await pool.query(
		`INSERT INTO athena_workout
		  (profile_id, provider, external_id, external_account_id, sport_name, sport_id,
		   started_at, ended_at, timezone_offset, score_state,
		   strain, average_heart_rate, max_heart_rate, kilojoules,
		   percent_recorded, distance_meter, altitude_gain_meter, altitude_change_meter,
		   zone_durations, provider_updated_at)
		 VALUES ?
		 ON DUPLICATE KEY UPDATE
		  external_account_id = VALUES(external_account_id), sport_name = VALUES(sport_name), sport_id = VALUES(sport_id),
		  started_at = VALUES(started_at), ended_at = VALUES(ended_at), timezone_offset = VALUES(timezone_offset),
		  score_state = VALUES(score_state), strain = VALUES(strain), average_heart_rate = VALUES(average_heart_rate),
		  max_heart_rate = VALUES(max_heart_rate), kilojoules = VALUES(kilojoules), percent_recorded = VALUES(percent_recorded),
		  distance_meter = VALUES(distance_meter), altitude_gain_meter = VALUES(altitude_gain_meter),
		  altitude_change_meter = VALUES(altitude_change_meter), zone_durations = VALUES(zone_durations),
		  provider_updated_at = VALUES(provider_updated_at), deleted_at = NULL`,
		[rows],
	);
	return rows.length;
}

/** The provider confirmed (404) that this workout is gone. */
async function markDeleted(profileId, externalId) {
	const [result] = await pool.query(
		`UPDATE athena_workout SET deleted_at = NOW(3)
		 WHERE profile_id = ? AND provider = ? AND external_id = ? AND deleted_at IS NULL`,
		[profileId, PROVIDER, String(externalId).toLowerCase()],
	);
	return result.affectedRows || 0;
}

/**
 * A signed workout webhook: read the workout as WHOOP has it now and record
 * it for every profile actively linked to that account. Reading it back, even
 * for a delete, means a late or replayed delivery can't erase a workout WHOOP
 * still returns. Per-profile failures are logged, not thrown — the webhook's
 * other work stands, and the next read or backfill fills the gap.
 */
async function fromWebhook(accountId, workoutId) {
	const whoop = require("./connectors/whoop");
	const [rows] = await pool.query(
		`SELECT DISTINCT profile_id FROM user_credential
		 WHERE provider = 'whoop' AND status = 'active' AND external_account_id = ?`,
		[String(accountId)],
	);
	let written = 0;
	for (const { profile_id: profileId } of rows) {
		try {
			if (!(await mayRecord(profileId))) continue;
			let workout;
			try { workout = await whoop.getWorkout(profileId, workoutId); }
			catch (error) {
				if (error.providerStatus === 404) { written += await markDeleted(profileId, workoutId); continue; }
				throw error;
			}
			if (String(workout.user_id) !== String(accountId)) continue;
			written += await record(profileId, [workout]);
		} catch (error) {
			console.error("[workoutHistory] webhook record failed", { profileId, code: error.code || null, status: error.providerStatus || null, message: error.message });
		}
	}
	return written;
}

/** The calendar day the workout started where it happened ("-04:00" offset). */
function localDate(startedAt, offset) {
	const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset || "");
	const shift = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000 : 0;
	return new Date(new Date(startedAt).getTime() + shift).toISOString().slice(0, 10);
}

/** Recorded workouts, newest first, for this profile only. */
async function list(profileId, { days = 90, sport, limit = 100 } = {}) {
	const lookback = Math.max(1, Math.min(Number(days) || 90, MAX_DAYS));
	const cap = Math.max(1, Math.min(Number(limit) || 100, 500));
	const params = [profileId, new Date(Date.now() - lookback * 86400_000)];
	let sportClause = "";
	if (typeof sport === "string" && sport.trim()) {
		sportClause = " AND sport_name LIKE ?";
		params.push(`%${sport.trim().replace(/[\\%_]/g, (c) => `\\${c}`).slice(0, 60)}%`);
	}
	params.push(cap);
	const [rows] = await pool.query(
		`SELECT external_id, sport_name, started_at, ended_at, timezone_offset, score_state, strain,
		        average_heart_rate, max_heart_rate, kilojoules, percent_recorded, distance_meter, zone_durations
		 FROM athena_workout
		 WHERE profile_id = ? AND deleted_at IS NULL AND started_at >= ?${sportClause}
		 ORDER BY started_at DESC LIMIT ?`,
		params,
	);
	return rows.map((r) => {
		const zones = typeof r.zone_durations === "string" ? JSON.parse(r.zone_durations) : r.zone_durations;
		return {
			date: localDate(r.started_at, r.timezone_offset),
			start: new Date(r.started_at).toISOString(), timezone_offset: r.timezone_offset,
			minutes: Math.round((new Date(r.ended_at) - new Date(r.started_at)) / 60000),
			sport: r.sport_name, strain: num(r.strain),
			average_heart_rate: num(r.average_heart_rate), max_heart_rate: num(r.max_heart_rate),
			kilojoules: num(r.kilojoules), percent_recorded: num(r.percent_recorded),
			distance_meter: num(r.distance_meter),
			minutes_in_zone: zones && typeof zones === "object"
				? Object.fromEntries(Object.entries(zones).map(([k, v]) => [k.replace(/_milli$/, ""), Math.round((Number(v) || 0) / 60000)]))
				: null,
		};
	});
}

module.exports = { PROVIDER, record, markDeleted, fromWebhook, list, mayRecord };
