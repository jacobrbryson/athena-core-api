/**
 * The outage watch's persistence (migration 0101). The orchestrator talks only
 * to this interface so its tests can swap in an in-memory twin.
 *
 * Reads of other features' tables (Nest devices, site checks, location
 * samples, the incident situation) are here too, each tolerant of a table
 * that doesn't exist yet: a missing source is reported as unreadable, never
 * as "nothing wrong".
 */
const pool = require("../../helpers/db");

const json = (v) => (v == null ? null : JSON.stringify(v));
const parse = (v) => {
	if (v == null) return null;
	if (typeof v === "object") return v;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
};
const episodeOf = (r) => (r ? { ...r, signals: parse(r.signals), checked: parse(r.checked), cause_sources: parse(r.cause_sources) } : null);

async function openEpisode() {
	const [rows] = await pool.query("SELECT * FROM athena_outage_episode WHERE open_key = 'open' LIMIT 1");
	return episodeOf(rows[0]);
}

/** One live episode at a time: the unique open_key makes a second insert a no-op. */
async function createEpisode({ uuid, openedAt, signals }) {
	const [result] = await pool.query(
		"INSERT IGNORE INTO athena_outage_episode (uuid, open_key, state, opened_at, signals) VALUES (?, 'open', 'open', ?, ?)",
		[uuid, openedAt, json(signals)]
	);
	return { episode: await openEpisode(), created: result.affectedRows === 1 };
}

const COLUMNS = new Set(["state", "checked", "locality", "cause_status", "cause_text", "cause_sources", "nudge_uuid", "reported_at", "recovered_at", "recovery_cause_text", "recovery_nudge_uuid", "recovery_reported_at", "closed_at"]);
const JSON_COLUMNS = new Set(["checked", "cause_sources"]);

async function updateEpisode(id, fields, { close = false } = {}) {
	const sets = [];
	const values = [];
	for (const [key, value] of Object.entries(fields)) {
		if (!COLUMNS.has(key)) throw new Error(`unknown episode column ${key}`);
		sets.push(`${key} = ?`);
		values.push(JSON_COLUMNS.has(key) ? json(value) : value);
	}
	if (close) sets.push("open_key = NULL");
	if (!sets.length) return;
	await pool.query(`UPDATE athena_outage_episode SET ${sets.join(", ")} WHERE id = ?`, [...values, id]);
}

async function addAssessment({ at, reason, verdict, episodeId = null, signals = null, errors = null }) {
	await pool.query(
		"INSERT INTO athena_outage_assessment (at, reason, verdict, episode_id, signals, errors) VALUES (?, ?, ?, ?, ?, ?)",
		[at, reason, verdict, episodeId, json(signals), json(errors && errors.length ? errors : null)]
	);
}

async function lastAssessmentAt() {
	const [[row]] = await pool.query("SELECT MAX(at) AS at FROM athena_outage_assessment");
	return row?.at ? new Date(row.at) : null;
}

async function pruneAssessments(days = 60) {
	await pool.query("DELETE FROM athena_outage_assessment WHERE at < NOW() - INTERVAL ? DAY", [days]);
}

/** OFFLINE thermostats for these people. A device name is listed once however many people share it. */
async function nestOffline(profileIds) {
	if (!profileIds.length) return [];
	const [rows] = await pool.query(
		`SELECT device_name, MAX(display_name) AS display_name, MAX(room) AS room, MIN(offline_since) AS offline_since
		 FROM athena_nest_device WHERE profile_id IN (?) AND connectivity = 'OFFLINE' GROUP BY device_name`,
		[profileIds]
	);
	return rows.map((r) => ({
		name: r.device_name,
		label: r.display_name || (r.room ? `${r.room} thermostat` : "a thermostat"),
		offlineSince: r.offline_since ? new Date(r.offline_since) : null,
	}));
}

/** When each of these thermostats last came back (null if it hasn't). */
async function nestOnlineSince(names) {
	if (!names.length) return new Map();
	const [rows] = await pool.query(
		"SELECT device_name, MAX(online_since) AS online_since FROM athena_nest_device WHERE device_name IN (?) AND connectivity = 'ONLINE' GROUP BY device_name",
		[names]
	);
	return new Map(rows.map((r) => [r.device_name, r.online_since ? new Date(r.online_since) : null]));
}

/** Sites whose newest check in the last three hours failed / passed. Empty before migration 0079. */
async function siteStatus(now) {
	try {
		const [rows] = await pool.query(
			`SELECT c.site_id, c.ok FROM athena_site_check c
			 WHERE c.checked_at >= ? AND c.id = (SELECT MAX(id) FROM athena_site_check WHERE site_id = c.site_id)`,
			[new Date(now.getTime() - 3 * 3600_000)]
		);
		return { checked: rows.length, failing: rows.filter((r) => !r.ok).length };
	} catch (err) {
		if (err?.code === "ER_NO_SUCH_TABLE") return { checked: 0, failing: 0 };
		throw err;
	}
}

/** When the phone last reported in (server clock). Null if never or location is off. */
async function phoneLastSeen(profileIds) {
	if (!profileIds.length) return null;
	try {
		const [[row]] = await pool.query("SELECT MAX(received_at) AS at FROM athena_location_sample WHERE profile_id IN (?)", [profileIds]);
		return row?.at ? new Date(row.at) : null;
	} catch (err) {
		if (err?.code === "ER_NO_SUCH_TABLE") return null;
		throw err;
	}
}

/** The stored nearby-911 situation for these people (the phone-sourced calls live in it). */
async function situations(profileIds) {
	if (!profileIds.length) return [];
	const [rows] = await pool.query("SELECT profile_id, incidents FROM athena_incident_situation WHERE profile_id IN (?)", [profileIds]);
	return rows.map((r) => ({ profileId: Number(r.profile_id), incidents: parse(r.incidents) || [] }));
}

/** True when the row was written; false when this person already has one under that key. */
async function insertNudge({ uuid, profileId, dedupeKey, text, facts, ttlSeconds }) {
	const [result] = await pool.query(
		`INSERT IGNORE INTO athena_nudge (uuid, profile_id, trigger_id, dedupe_key, urgency, text, facts, expires_at)
		 VALUES (?, ?, 'outage', ?, 'normal', ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
		[uuid, profileId, dedupeKey, text, json(facts), ttlSeconds]
	);
	return result.affectedRows === 1;
}

async function bridgeHealth() {
	const [[row]] = await pool.query("SELECT * FROM athena_camera_bridge_health WHERE id = 1");
	return row
		? { state: row.state, since: row.since ? new Date(row.since) : null, lastOkAt: row.last_ok_at ? new Date(row.last_ok_at) : null, reportedSince: row.reported_since ? new Date(row.reported_since) : null, recoveryPending: Boolean(row.recovery_pending) }
		: { state: "unknown", since: null, lastOkAt: null, reportedSince: null, recoveryPending: false };
}

async function saveBridgeHealth({ state, since, lastOkAt, checkedAt, reportedSince, recoveryPending }) {
	await pool.query(
		`INSERT INTO athena_camera_bridge_health (id, state, since, last_ok_at, last_checked_at, reported_since, recovery_pending)
		 VALUES (1, ?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE state = VALUES(state), since = VALUES(since), last_ok_at = VALUES(last_ok_at),
		   last_checked_at = VALUES(last_checked_at), reported_since = VALUES(reported_since), recovery_pending = VALUES(recovery_pending)`,
		[state, since, lastOkAt, checkedAt, reportedSince, recoveryPending ? 1 : 0]
	);
}

module.exports = {
	openEpisode, createEpisode, updateEpisode, addAssessment, lastAssessmentAt, pruneAssessments,
	nestOffline, nestOnlineSince, siteStatus, phoneLastSeen, situations, insertNudge, bridgeHealth, saveBridgeHealth,
};
