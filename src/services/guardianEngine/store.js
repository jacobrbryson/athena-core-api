/**
 * The Guardian Engine's persistence (migration 0093). The engine talks only to
 * this interface, so its tests can run the same logic against an in-memory
 * twin with the same uniqueness rules (guardianEngine.test.js).
 *
 * The guarantees that matter live in SQL, not in the engine remembering:
 *   - a run's (household, protocol, occurrence) is unique → scheduling twice is a no-op
 *   - claiming a run is one guarded UPDATE → two dispatchers never observe it twice
 *   - an incident's open_key is unique while open → one incident per unresolved condition
 *   - a notification's (incident, person, kind) is unique → one alert per person per incident
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
const rowOf = (r, fields) => {
	if (!r) return null;
	const out = { ...r };
	for (const f of fields) out[f] = parse(r[f]);
	return out;
};

async function getProtocols(householdId) {
	const [rows] = await pool.query("SELECT * FROM athena_guard_protocol WHERE household_id = ?", [householdId]);
	return rows.map((r) => ({ protocolId: r.protocol_id, version: Number(r.version), enabled: r.enabled === 1 || r.enabled === true, config: parse(r.config) || {}, updatedBy: Number(r.updated_by), updatedAt: r.updated_at }));
}

async function saveProtocol(householdId, protocolId, { version, enabled, config, updatedBy, now }) {
	await pool.query(
		`INSERT INTO athena_guard_protocol (household_id, protocol_id, version, enabled, config, updated_by, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE version = VALUES(version), enabled = VALUES(enabled), config = VALUES(config), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
		[householdId, protocolId, version, enabled ? 1 : 0, json(config), updatedBy, now]
	);
}

/** INSERT IGNORE on the occurrence key. Returns { run, created }. */
async function insertRun(run) {
	const [result] = await pool.query(
		`INSERT IGNORE INTO athena_guard_run
			(uuid, household_id, protocol_id, protocol_version, occurrence_key, trigger_kind, state, scheduled_for, incident_id, checks, simulated, requested_by, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?)`,
		[run.uuid, run.household_id, run.protocol_id, run.protocol_version, run.occurrence_key, run.trigger_kind, run.scheduled_for, run.incident_id || null, json(run.checks || null), run.simulated ? 1 : 0, run.requested_by || null, run.created_at]
	);
	const [rows] = await pool.query("SELECT * FROM athena_guard_run WHERE household_id = ? AND protocol_id = ? AND occurrence_key = ?", [run.household_id, run.protocol_id, run.occurrence_key]);
	return { run: rowOf(rows[0], ["checks", "summary"]), created: result.affectedRows === 1 };
}

/**
 * Claim one run for observation: scheduled and due, or observing/evaluating
 * with a lease that ran out (a restart mid-run). One UPDATE; affectedRows is
 * the claim. Attempts past the limit are not claimable.
 */
async function claimRun(id, { now, leaseMs, maxAttempts }) {
	const [result] = await pool.query(
		`UPDATE athena_guard_run
		 SET state = 'observing', lease_until = ?, attempts = attempts + 1, started_at = COALESCE(started_at, ?)
		 WHERE id = ? AND attempts < ? AND scheduled_for <= ?
		   AND (state = 'scheduled' OR (state IN ('observing', 'evaluating') AND lease_until < ?))`,
		[new Date(now.getTime() + leaseMs), now, id, maxAttempts, now, now]
	);
	return result.affectedRows === 1;
}

async function dueRuns({ now, householdId = null, limit = 20 }) {
	const [rows] = await pool.query(
		`SELECT * FROM athena_guard_run
		 WHERE scheduled_for <= ? ${householdId == null ? "" : "AND household_id = ?"}
		   AND (state = 'scheduled' OR (state IN ('observing', 'evaluating') AND lease_until < ?))
		 ORDER BY scheduled_for LIMIT ?`,
		householdId == null ? [now, now, limit] : [now, householdId, now, limit]
	);
	return rows.map((r) => rowOf(r, ["checks", "summary"]));
}

/** Runs past their time by more than `overdueMs` that nothing ever claimed, or that used every attempt. */
async function overdueRuns({ now, overdueMs }) {
	const [rows] = await pool.query(
		`SELECT * FROM athena_guard_run
		 WHERE ((state = 'scheduled' AND scheduled_for < ?) OR (state IN ('observing', 'evaluating') AND lease_until < ? AND attempts >= 3))
		 ORDER BY scheduled_for LIMIT 50`,
		[new Date(now.getTime() - overdueMs), now]
	);
	return rows.map((r) => rowOf(r, ["checks", "summary"]));
}

async function getRun(id) {
	const [rows] = await pool.query("SELECT * FROM athena_guard_run WHERE id = ?", [id]);
	return rowOf(rows[0], ["checks", "summary"]);
}

/** Guarded on the state the engine believes the run is in, so a stale writer changes nothing. */
async function updateRun(id, fromState, patch) {
	const cols = Object.keys(patch);
	const values = cols.map((c) => (c === "summary" || c === "checks" ? json(patch[c]) : patch[c]));
	const [result] = await pool.query(`UPDATE athena_guard_run SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND state = ?`, [...values, id, fromState]);
	return result.affectedRows === 1;
}

async function recentRuns(householdId, limit = 20) {
	const [rows] = await pool.query("SELECT * FROM athena_guard_run WHERE household_id = ? ORDER BY scheduled_for DESC, id DESC LIMIT ?", [householdId, limit]);
	return rows.map((r) => rowOf(r, ["checks", "summary"]));
}

async function nextScheduledRun(householdId, protocolId, now) {
	const [rows] = await pool.query("SELECT * FROM athena_guard_run WHERE household_id = ? AND protocol_id = ? AND state = 'scheduled' AND scheduled_for >= ? ORDER BY scheduled_for LIMIT 1", [householdId, protocolId, now]);
	return rowOf(rows[0], ["checks", "summary"]);
}

/** Runs of a protocol still waiting for their time, so a changed schedule can move them. */
async function scheduledRuns(householdId, protocolId) {
	const [rows] = await pool.query("SELECT * FROM athena_guard_run WHERE household_id = ? AND protocol_id = ? AND state = 'scheduled' ORDER BY scheduled_for", [householdId, protocolId]);
	return rows.map((r) => rowOf(r, ["checks", "summary"]));
}

/**
 * Strangers the cameras logged between two times (sightings, migration 0083),
 * counted per visit — frames closer than half an hour apart are one stranger —
 * so a person on the porch for ten frames is "once", not "ten times".
 */
async function overnightStrangers(from, to) {
	const [rows] = await pool.query("SELECT seen_at, device_name FROM athena_sighting WHERE label = 'stranger' AND seen_at BETWEEN ? AND ? ORDER BY seen_at LIMIT 200", [from, to]);
	if (!rows.length) return null;
	let count = 0;
	let last = -Infinity;
	for (const r of rows) {
		const t = new Date(r.seen_at).getTime();
		if (t - last > 30 * 60_000) count += 1;
		last = t;
	}
	return { count, firstAt: new Date(rows[0].seen_at), camera: rows[0].device_name || null };
}

async function insertObservation(o) {
	const [result] = await pool.query(
		`INSERT INTO athena_guard_observation
			(run_id, household_id, check_id, subject_key, source, status, confidence, captured_at, observed_at, fresh, attempt, reason, evidence_media_uuid, device_serial, model)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[o.run_id, o.household_id, o.check_id, o.subject_key, o.source, o.status, o.confidence, o.captured_at, o.observed_at, o.fresh ? 1 : 0, o.attempt || 1, o.reason ? String(o.reason).slice(0, 300) : null, o.evidence_media_uuid || null, o.device_serial || null, o.model ? String(o.model).slice(0, 80) : null]
	);
	return result.insertId;
}

async function observationsForRun(runId) {
	const [rows] = await pool.query("SELECT * FROM athena_guard_observation WHERE run_id = ? ORDER BY id", [runId]);
	return rows;
}

/** The newest fresh observation of a subject that was a definite verdict, for "last verified". */
async function lastGoodObservation(householdId, checkId, subjectKey) {
	const [rows] = await pool.query(
		`SELECT * FROM athena_guard_observation WHERE household_id = ? AND check_id = ? AND subject_key = ? AND fresh = 1
		   AND status NOT IN ('unknown', 'offline', 'not_applicable') ORDER BY observed_at DESC LIMIT 1`,
		[householdId, checkId, subjectKey]
	);
	return rows[0] || null;
}

async function openIncident(householdId, openKey) {
	const [rows] = await pool.query("SELECT * FROM athena_guard_incident WHERE household_id = ? AND open_key = ? LIMIT 1", [householdId, openKey]);
	return rowOf(rows[0], ["context"]);
}

/** INSERT IGNORE on open_key. Returns { incident, created }. */
async function insertIncident(i) {
	const [result] = await pool.query(
		`INSERT IGNORE INTO athena_guard_incident
			(uuid, household_id, protocol_id, check_id, subject_key, open_key, state, condition_status, severity, confidence, trigger_run_id, trigger_kind,
			 last_observation_id, first_detected_at, last_verified_at, next_recheck_at, expires_at, context)
		 VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[i.uuid, i.household_id, i.protocol_id, i.check_id, i.subject_key, i.open_key, i.condition_status, i.severity, i.confidence, i.trigger_run_id, i.trigger_kind, i.last_observation_id, i.first_detected_at, i.last_verified_at, i.next_recheck_at || null, i.expires_at || null, json(i.context || null)]
	);
	const incident = await openIncident(i.household_id, i.open_key);
	return { incident, created: result.affectedRows === 1 };
}

async function getIncident(id) {
	const [rows] = await pool.query("SELECT * FROM athena_guard_incident WHERE id = ?", [id]);
	return rowOf(rows[0], ["context"]);
}

async function incidentByUuid(householdId, uuid) {
	const [rows] = await pool.query("SELECT * FROM athena_guard_incident WHERE household_id = ? AND uuid = ?", [householdId, uuid]);
	return rowOf(rows[0], ["context"]);
}

/** Guarded on the incident's current state; returns whether the write landed. */
async function updateIncident(id, fromState, patch) {
	const cols = Object.keys(patch);
	const values = cols.map((c) => (c === "context" ? json(patch[c]) : patch[c]));
	const [result] = await pool.query(`UPDATE athena_guard_incident SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND state = ?`, [...values, id, fromState]);
	return result.affectedRows === 1;
}

async function activeIncidents({ householdId = null } = {}) {
	const [rows] = await pool.query(
		`SELECT * FROM athena_guard_incident WHERE state IN ('open', 'notified', 'acknowledged') ${householdId == null ? "" : "AND household_id = ?"} ORDER BY first_detected_at`,
		householdId == null ? [] : [householdId]
	);
	return rows.map((r) => rowOf(r, ["context"]));
}

async function recentIncidents(householdId, limit = 20) {
	const [rows] = await pool.query("SELECT * FROM athena_guard_incident WHERE household_id = ? ORDER BY first_detected_at DESC LIMIT ?", [householdId, limit]);
	return rows.map((r) => rowOf(r, ["context"]));
}

/** INSERT IGNORE on (incident, profile, kind). Returns { notification, created }. */
async function insertNotification(n) {
	const [result] = await pool.query(
		`INSERT IGNORE INTO athena_guard_notification (incident_id, household_id, profile_id, kind, status, text, hold_until, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[n.incident_id, n.household_id, n.profile_id, n.kind, n.status, String(n.text).slice(0, 600), n.hold_until || null, n.created_at]
	);
	const [rows] = await pool.query("SELECT * FROM athena_guard_notification WHERE incident_id = ? AND profile_id = ? AND kind = ?", [n.incident_id, n.profile_id, n.kind]);
	return { notification: rowOf(rows[0], ["result"]), created: result.affectedRows === 1 };
}

async function updateNotification(id, patch) {
	const cols = Object.keys(patch);
	const values = cols.map((c) => (c === "result" ? json(patch[c]) : patch[c]));
	await pool.query(`UPDATE athena_guard_notification SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...values, id]);
}

/**
 * Held notifications whose window ended, failed ones with attempts left, and
 * pending ones a crash left undelivered (older than two minutes, so one being
 * delivered right now by another process is not sent twice).
 */
async function retryableNotifications({ now, maxAttempts }) {
	const settled = new Date(now.getTime() - 2 * 60_000);
	const [rows] = await pool.query(
		`SELECT * FROM athena_guard_notification
		 WHERE (status = 'held' AND hold_until <= ?)
		    OR (status = 'failed' AND attempts < ?)
		    OR (status = 'pending' AND attempts < ? AND created_at < ?)
		 ORDER BY created_at LIMIT 100`,
		[now, maxAttempts, maxAttempts, settled]
	);
	return rows.map((r) => rowOf(r, ["result"]));
}

async function notificationsFor(incidentIds) {
	if (!incidentIds.length) return [];
	const [rows] = await pool.query("SELECT * FROM athena_guard_notification WHERE incident_id IN (?) ORDER BY created_at", [incidentIds]);
	return rows.map((r) => rowOf(r, ["result"]));
}

async function addEvent(e) {
	await pool.query("INSERT INTO athena_guard_event (household_id, run_id, incident_id, kind, actor, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)", [e.household_id, e.run_id || null, e.incident_id || null, e.kind, e.actor || "engine", json(e.detail || null), e.at]);
}

async function recentEvents(householdId, limit = 40) {
	const [rows] = await pool.query("SELECT * FROM athena_guard_event WHERE household_id = ? ORDER BY at DESC, id DESC LIMIT ?", [householdId, limit]);
	return rows.map((r) => rowOf(r, ["detail"]));
}

/** The same access audit the camera routes write. */
async function audit(subject, action) {
	await pool.query("INSERT INTO athena_access_audit (subject, action) VALUES (?, ?)", [String(subject), String(action).slice(0, 64)]);
}

/** The in-app half of an alert: a nudge row, shown in the app whether or not a push lands. */
async function insertNudge({ uuid, profileId, dedupeKey, urgency, text, facts, ttlSeconds }) {
	await pool.query(
		`INSERT IGNORE INTO athena_nudge (uuid, profile_id, trigger_id, dedupe_key, urgency, text, facts, expires_at)
		 VALUES (?, ?, 'guardian', ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
		[uuid, profileId, dedupeKey, urgency, text, json(facts), ttlSeconds]
	);
}

async function observationsByIds(ids) {
	if (!ids.length) return [];
	const [rows] = await pool.query("SELECT * FROM athena_guard_observation WHERE id IN (?)", [ids]);
	return rows;
}

async function profileNames(ids) {
	if (!ids.length) return [];
	const [rows] = await pool.query("SELECT id, full_name FROM profile WHERE id IN (?)", [ids]);
	return rows.map((r) => ({ id: Number(r.id), name: r.full_name || `Adult ${r.id}` }));
}

async function googleIdOf(profileId) {
	const [rows] = await pool.query("SELECT google_id FROM profile WHERE id = ?", [profileId]);
	return rows[0]?.google_id || null;
}

/** Evidence of incidents closed more than `days` ago, not starred, for the purge. */
async function staleEvidence(days) {
	const [rows] = await pool.query(
		`SELECT DISTINCT o.evidence_media_uuid AS uuid FROM athena_guard_observation o
		 JOIN athena_security_media m ON m.uuid = o.evidence_media_uuid AND m.important = 0
		 WHERE o.evidence_media_uuid IS NOT NULL AND o.observed_at < NOW() - INTERVAL ? DAY
		   AND NOT EXISTS (SELECT 1 FROM athena_guard_incident i WHERE i.last_observation_id = o.id AND i.state IN ('open', 'notified', 'acknowledged'))
		 LIMIT 200`,
		[days]
	);
	return rows.map((r) => r.uuid);
}

async function clearEvidence(uuid) {
	await pool.query("UPDATE athena_guard_observation SET evidence_media_uuid = NULL WHERE evidence_media_uuid = ?", [uuid]);
}

module.exports = {
	getProtocols, saveProtocol, insertRun, scheduledRuns, overnightStrangers, claimRun, dueRuns, overdueRuns, getRun, updateRun, recentRuns, nextScheduledRun,
	insertObservation, observationsForRun, lastGoodObservation, observationsByIds, profileNames,
	openIncident, insertIncident, getIncident, incidentByUuid, updateIncident, activeIncidents, recentIncidents,
	insertNotification, updateNotification, retryableNotifications, notificationsFor,
	addEvent, recentEvents, audit, insertNudge, googleIdOf, staleEvidence, clearEvidence,
};
