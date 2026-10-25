/**
 * An in-memory twin of store.js for the engine's tests and simulations. It
 * keeps the same uniqueness and guarded-update rules the SQL does — that is
 * the point: a test that passes here is exercising the same idempotency the
 * database enforces (occurrence key, open_key, notification key, run claim).
 */
function memoryStore({ names = {} } = {}) {
	const db = { protocols: [], runs: [], obs: [], incidents: [], notes: [], events: [], audits: [], nudges: [] };
	let seq = 1;
	const copy = (x) => (x == null ? null : structuredClone(x));
	const t = (v) => (v == null ? null : new Date(v).getTime());
	const ACTIVE = ["open", "notified", "acknowledged"];

	return {
		db,
		async getProtocols(h) {
			return db.protocols.filter((p) => p.household_id === h).map((p) => ({ protocolId: p.protocol_id, version: p.version, enabled: p.enabled, config: copy(p.config), updatedBy: p.updated_by, updatedAt: p.updated_at }));
		},
		async saveProtocol(h, protocolId, { version, enabled, config, updatedBy, now }) {
			const row = db.protocols.find((p) => p.household_id === h && p.protocol_id === protocolId);
			const next = { household_id: h, protocol_id: protocolId, version, enabled: !!enabled, config: copy(config), updated_by: updatedBy, updated_at: now };
			if (row) Object.assign(row, next);
			else db.protocols.push(next);
		},
		async insertRun(run) {
			const found = db.runs.find((r) => r.household_id === run.household_id && r.protocol_id === run.protocol_id && r.occurrence_key === run.occurrence_key);
			if (found) return { run: copy(found), created: false };
			const row = { id: seq++, ...copy(run), state: "scheduled", attempts: 0, lease_until: null, started_at: null, finished_at: null, summary: null, simulated: run.simulated ? 1 : 0 };
			db.runs.push(row);
			return { run: copy(row), created: true };
		},
		async claimRun(id, { now, leaseMs, maxAttempts }) {
			const r = db.runs.find((x) => x.id === id);
			if (!r || r.attempts >= maxAttempts || t(r.scheduled_for) > t(now)) return false;
			const claimable = r.state === "scheduled" || (["observing", "evaluating"].includes(r.state) && t(r.lease_until) < t(now));
			if (!claimable) return false;
			Object.assign(r, { state: "observing", lease_until: new Date(t(now) + leaseMs), attempts: r.attempts + 1, started_at: r.started_at || now });
			return true;
		},
		async dueRuns({ now, householdId = null }) {
			return db.runs
				.filter((r) => (householdId == null || r.household_id === householdId) && t(r.scheduled_for) <= t(now) && (r.state === "scheduled" || (["observing", "evaluating"].includes(r.state) && t(r.lease_until) < t(now))))
				.sort((a, b) => t(a.scheduled_for) - t(b.scheduled_for))
				.map(copy);
		},
		async overdueRuns({ now, overdueMs }) {
			return db.runs.filter((r) => (r.state === "scheduled" && t(r.scheduled_for) < t(now) - overdueMs) || (["observing", "evaluating"].includes(r.state) && t(r.lease_until) < t(now) && r.attempts >= 3)).map(copy);
		},
		async getRun(id) {
			return copy(db.runs.find((r) => r.id === id));
		},
		async updateRun(id, from, patch) {
			const r = db.runs.find((x) => x.id === id && x.state === from);
			if (!r) return false;
			Object.assign(r, copy(patch));
			return true;
		},
		async recentRuns(h, limit = 20) {
			return db.runs.filter((r) => r.household_id === h).sort((a, b) => t(b.scheduled_for) - t(a.scheduled_for) || b.id - a.id).slice(0, limit).map(copy);
		},
		async scheduledRuns(h, p) {
			return db.runs.filter((r) => r.household_id === h && r.protocol_id === p && r.state === "scheduled").map(copy);
		},
		/** Tests set db.strangers = { count, firstAt, camera } to script the sightings log. */
		async overnightStrangers() {
			return db.strangers || null;
		},
		async nextScheduledRun(h, p, now) {
			return copy(db.runs.filter((r) => r.household_id === h && r.protocol_id === p && r.state === "scheduled" && t(r.scheduled_for) >= t(now)).sort((a, b) => t(a.scheduled_for) - t(b.scheduled_for))[0]);
		},
		async insertObservation(o) {
			const row = { id: seq++, ...copy(o), fresh: o.fresh ? 1 : 0 };
			db.obs.push(row);
			return row.id;
		},
		async observationsForRun(runId) {
			return db.obs.filter((o) => o.run_id === runId).map(copy);
		},
		async lastGoodObservation(h, c, s) {
			return copy(db.obs.filter((o) => o.household_id === h && o.check_id === c && o.subject_key === s && o.fresh && !["unknown", "offline", "not_applicable"].includes(o.status)).sort((a, b) => t(b.observed_at) - t(a.observed_at))[0]);
		},
		async observationsByIds(ids) {
			return db.obs.filter((o) => ids.includes(o.id)).map(copy);
		},
		async profileNames(ids) {
			return ids.map((id) => ({ id: Number(id), name: names[id] || `Adult ${id}` }));
		},
		async openIncident(h, key) {
			return copy(db.incidents.find((i) => i.household_id === h && i.open_key === key));
		},
		async insertIncident(i) {
			const found = db.incidents.find((x) => x.household_id === i.household_id && x.open_key === i.open_key);
			if (found) return { incident: copy(found), created: false };
			const row = { id: seq++, ...copy(i), state: "open", recheck_count: 0, acknowledged_by: null, acknowledged_at: null, assigned_profile_id: null, resolved_at: null, resolution: null, dismissed_by: null, dismiss_reason: null, escalated_at: null };
			db.incidents.push(row);
			return { incident: copy(row), created: true };
		},
		async getIncident(id) {
			return copy(db.incidents.find((i) => i.id === id));
		},
		async incidentByUuid(h, uuid) {
			return copy(db.incidents.find((i) => i.household_id === h && i.uuid === uuid));
		},
		async updateIncident(id, from, patch) {
			const i = db.incidents.find((x) => x.id === id && x.state === from);
			if (!i) return false;
			Object.assign(i, copy(patch));
			return true;
		},
		async activeIncidents({ householdId = null } = {}) {
			return db.incidents.filter((i) => ACTIVE.includes(i.state) && (householdId == null || i.household_id === householdId)).map(copy);
		},
		async recentIncidents(h, limit = 20) {
			return db.incidents.filter((i) => i.household_id === h).sort((a, b) => t(b.first_detected_at) - t(a.first_detected_at)).slice(0, limit).map(copy);
		},
		async insertNotification(n) {
			const found = db.notes.find((x) => x.incident_id === n.incident_id && Number(x.profile_id) === Number(n.profile_id) && x.kind === n.kind);
			if (found) return { notification: copy(found), created: false };
			const row = { id: seq++, ...copy(n), attempts: 0, nudge_uuid: null, result: null, last_attempt_at: null };
			db.notes.push(row);
			return { notification: copy(row), created: true };
		},
		async updateNotification(id, patch) {
			Object.assign(db.notes.find((n) => n.id === id), copy(patch));
		},
		async retryableNotifications({ now, maxAttempts }) {
			return db.notes
				.filter((n) => (n.status === "held" && t(n.hold_until) <= t(now)) || (n.status === "failed" && n.attempts < maxAttempts) || (n.status === "pending" && n.attempts < maxAttempts && t(n.created_at) < t(now) - 120_000))
				.map(copy);
		},
		async notificationsFor(ids) {
			return db.notes.filter((n) => ids.includes(n.incident_id)).map(copy);
		},
		async addEvent(e) {
			db.events.push(copy(e));
		},
		async recentEvents(h, limit = 40) {
			return db.events.filter((e) => e.household_id === h).slice(-limit).reverse().map(copy);
		},
		async audit(subject, action) {
			db.audits.push({ subject: String(subject), action });
		},
		async insertNudge(n) {
			db.nudges.push(copy(n));
		},
		async googleIdOf(id) {
			return `g-${id}`;
		},
		async staleEvidence() {
			return [];
		},
		async clearEvidence() {},
	};
}

module.exports = { memoryStore };
