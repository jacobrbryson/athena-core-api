/**
 * The Guardian Engine: household safety protocols that look, decide, tell
 * the right adults, and keep hold of a problem until it is verified fixed.
 *
 *   plan({ now })        DB + weather only — safe in the job or the service.
 *                        Books tonight's sweep, starts a storm watch when the
 *                        weather turns, books rechecks, escalates, retries
 *                        failed notifications, reports missed runs.
 *   runDue({ now })      the service only (it alone reaches the cameras):
 *                        plan, then claim and execute every due run.
 *   runNow / recheck     an adult pressed a button on the dashboard.
 *   acknowledge / dismiss / assign / saveConfig / overview
 *
 * The rules this file keeps (docs/architecture/guardian-engine.md):
 *   - No model decides whether, when, or whom. Scheduling, state, policy and
 *     wording are code; the model only reports what one fresh frame shows.
 *   - Unknown is never safe. Offline, stale, unclear, conflicting: "unknown",
 *     retried a bounded number of times, then reported.
 *   - One incident per unresolved condition, one alert per person per incident.
 *     Repetition is prevented by unique keys; nothing true is dropped.
 *   - Acknowledged is not resolved. Only fresh evidence of the safe state, or
 *     an adult's explicit dismissal with a reason, closes an incident.
 *   - Everything the engine does passes policy.authorize() first, and nothing
 *     it may do touches a physical device.
 */
const { randomUUID } = require("node:crypto");
const defaultStore = require("./store");
const policy = require("./policy");
const protocols = require("./protocols");
const weatherRisk = require("./weatherRisk");
const observe = require("./observe");
const { CHECKS, unknownText, escalationText } = require("./checks");
const reports = require("./reports");
const { runTransition, incidentTransition, INCIDENT_ACTIVE } = require("./states");

/** One household per deployment today (the Eufy bridge's). Every row carries it. */
const HOUSEHOLD = 1;
const LEASE_MS = 4 * 60_000;
const MAX_RUN_ATTEMPTS = 3;
const MAX_NOTIFY_ATTEMPTS = 3;
const NUDGE_TTL_S = 12 * 3600;
/** Evidence frames of closed incidents are deleted after this, unless starred. */
const EVIDENCE_DAYS = 30;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function createEngine(overrides = {}) {
	const deps = {
		store: defaultStore,
		push: () => require("../push"),
		weather: (place, config, opts) => weatherRisk.assess(place, config, opts),
		tonight: (place, config, opts) => weatherRisk.tonight(place, config, opts),
		/** Stranger sightings between two times, one per visit (sightings log, migration 0083). */
		overnightStrangers: (from, to) => deps.store.overnightStrangers(from, to),
		homePlace: (profileId, placeUuid) => require("../weatherAlerts").homePlace(profileId, placeUuid),
		allowedIds: () => require("../eufyBridge").authorizedProfileIds().map(Number),
		cameraNames: async () => {
			const status = await require("../eufyBridge").status().catch(() => null);
			return new Map((status?.devices || []).map((d) => [d.serial, d.name]));
		},
		saveEvidence: async ({ profileId, serial, cameraName, jpeg }) => (await require("../securityMedia").save({ profileId, serial, deviceName: cameraName, type: "image", buf: jpeg })).id,
		removeEvidence: (uuid) => require("../securityMedia").remove(uuid),
		/** Run fn as this adult so the model call passes the same live access check theirs would. */
		asProfile: async (profileId, fn) => {
			const access = require("../../security/access");
			const googleId = await deps.store.googleIdOf(profileId);
			return access.context.run({ identity: googleId ? { google_id: googleId } : null }, fn);
		},
		wake: (at) => require("./dispatch").wakeAt(at),
		observeDeps: {},
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		now: () => new Date(),
		...overrides,
	};
	const store = deps.store;

	const event = (kind, { run = null, incident = null, actor = "engine", detail = null, now = deps.now() } = {}) =>
		store.addEvent({ household_id: HOUSEHOLD, run_id: run?.id || null, incident_id: incident?.id || null, kind, actor, detail, at: now }).catch((error) => console.warn("[guardian] event not recorded", kind, error?.message));

	/** A policy decision, recorded; refusals also go to the access audit. */
	async function authorize(actionId, ctx, { run = null, incident = null, config = {} } = {}) {
		const decision = policy.authorize(actionId, { ...ctx, restrict: config.autonomy || {} });
		if (!decision.allowed) {
			await event("policy_refused", { run, incident, detail: { actionId, level: decision.level, reasons: decision.reasons } });
			await store.audit("guardian_engine", `guardian_refused:${actionId}`).catch(() => undefined);
		}
		return decision;
	}

	// ---------------------------------------------------------------------
	// Configuration
	// ---------------------------------------------------------------------

	async function loadProtocols() {
		const rows = await store.getProtocols(HOUSEHOLD);
		const out = {};
		for (const def of Object.values(protocols.PROTOCOLS)) {
			const row = rows.find((r) => r.protocolId === def.id);
			let config;
			try {
				config = protocols.normalizeConfig(def.id, row?.config || {});
			} catch {
				config = protocols.normalizeConfig(def.id, {});
			}
			out[def.id] = { def, enabled: !!row?.enabled, config, updatedBy: row?.updatedBy || null, updatedAt: row?.updatedAt || null, version: row?.version || def.version };
		}
		return out;
	}

	/** Configured recipients, narrowed to approved household adults; none configured = all of them. */
	function recipientsFor(proto) {
		const allowed = deps.allowedIds();
		const chosen = proto.config.recipients.map(Number).filter((id) => allowed.includes(id));
		return proto.config.recipients.length ? chosen : allowed;
	}

	/** The adult whose identity model calls run as: who last configured it, if still approved. */
	function operatorOf(proto) {
		const allowed = deps.allowedIds();
		return allowed.includes(Number(proto.updatedBy)) ? Number(proto.updatedBy) : allowed[0] || null;
	}

	const tzOf = (all) => all.nightly_sweep.config.schedule?.timeZone || "America/New_York";

	async function saveConfig(profileId, protocolId, body = {}) {
		const def = protocols.get(protocolId);
		if (!def) throw bad("Unknown protocol.", 404);
		const config = protocols.normalizeConfig(protocolId, body.config || {});
		const allowed = deps.allowedIds();
		const refused = config.recipients.filter((id) => !allowed.includes(Number(id)));
		if (refused.length) {
			// A recipient outside the household allowlist is an external message (level 3).
			await authorize("notify.external", {}, {});
			throw bad("Alerts can only go to adults authorized for household security.", 403);
		}
		const now = deps.now();
		const before = (await store.getProtocols(HOUSEHOLD)).find((r) => r.protocolId === protocolId);
		const enabled = typeof body.enabled === "boolean" ? body.enabled : !!before?.enabled;
		await store.saveProtocol(HOUSEHOLD, protocolId, { version: def.version, enabled, config, updatedBy: profileId, now });
		// A booked sweep or morning report follows a changed time: its day stays,
		// its hour moves (the occurrence key is the day, so it can't be booked twice).
		if (protocolId === "nightly_sweep") {
			for (const run of await store.scheduledRuns(HOUSEHOLD, protocolId)) {
				const day = /(\d{4}-\d{2}-\d{2})$/.exec(run.occurrence_key)?.[1];
				const time = run.trigger_kind === "schedule" ? config.schedule.time : run.trigger_kind === "report" ? config.reports.morningTime : null;
				if (!day || !time) continue;
				const when = protocols.zonedInstant(day, time, config.schedule.timeZone);
				if (when.getTime() === new Date(run.scheduled_for).getTime()) continue;
				if (await store.updateRun(run.id, "scheduled", { scheduled_for: when })) {
					await event("run_rescheduled", { run, actor: `profile:${profileId}`, detail: { from: run.scheduled_for, to: when }, now });
					if (when > now) await Promise.resolve(deps.wake(when)).catch(() => false);
				}
			}
		}
		await event("config_changed", { actor: `profile:${profileId}`, detail: { protocolId, enabled, wasEnabled: !!before?.enabled }, now });
		await store.audit(profileId, `guardian_config:${protocolId}:${enabled ? "on" : "off"}`);
		return { protocolId, enabled, config };
	}

	// ---------------------------------------------------------------------
	// Planning
	// ---------------------------------------------------------------------

	async function scheduleRun(proto, { occurrenceKey, trigger, scheduledFor, checks, incident = null, simulated = false, requestedBy = null, now }) {
		const { run, created } = await store.insertRun({
			uuid: randomUUID(),
			household_id: HOUSEHOLD,
			protocol_id: proto.def.id,
			protocol_version: proto.def.version,
			occurrence_key: occurrenceKey,
			trigger_kind: trigger,
			scheduled_for: scheduledFor,
			incident_id: incident?.id || null,
			checks,
			simulated: simulated || proto.config.simulation,
			requested_by: requestedBy,
			created_at: now,
		});
		if (created) {
			await event("run_scheduled", { run, detail: { protocolId: proto.def.id, trigger, occurrenceKey, scheduledFor }, now });
			if (scheduledFor > now) await Promise.resolve(deps.wake(scheduledFor)).catch(() => false);
		}
		return { run, created };
	}

	/** Today's run at a local time, or tomorrow's once today's has gone by. */
	async function planDaily(proto, now, { time, prefix, trigger, checks }) {
		const { timeZone } = proto.config.schedule;
		const today = protocols.localDateOf(now, timeZone);
		const at = protocols.zonedInstant(today, time, timeZone);
		// Tonight's, unless tonight's time has already gone by (a protocol enabled
		// at 11 PM starts tomorrow rather than reporting a sweep it never had).
		let date = today;
		let when = at;
		if (now.getTime() > at.getTime() + proto.config.overdueAfterMinutes * 60_000) {
			date = protocols.localDateOf(new Date(at.getTime() + 24 * 3_600_000), timeZone);
			when = protocols.zonedInstant(date, time, timeZone);
		}
		return scheduleRun(proto, { occurrenceKey: `${prefix}${date}`, trigger, scheduledFor: when, checks, now });
	}

	const planNightly = (proto, now) => planDaily(proto, now, { time: proto.config.schedule.time, prefix: "", trigger: "schedule", checks: proto.def.checks });
	/** The 6 AM report: a run with nothing to look at, only a night to sum up. */
	const planMorning = (proto, now) => planDaily(proto, now, { time: proto.config.reports.morningTime, prefix: "morning:", trigger: "report", checks: [] });

	/** Reports need no camera, so whoever plans (job or service) sends them. */
	async function runReports(now) {
		for (const run of await store.dueRuns({ now, householdId: HOUSEHOLD })) {
			if (run.trigger_kind === "report") await claimAndExecute(run);
		}
	}

	async function riskFor(all, now) {
		const storm = all.storm_umbrella;
		const operator = operatorOf(storm.updatedBy ? storm : all.nightly_sweep);
		const place = operator ? await Promise.resolve(deps.homePlace(operator, storm.config.placeUuid)).catch(() => null) : null;
		return deps.weather(place, storm.config.weather || {}, { now });
	}

	async function planStorm(all, now) {
		const proto = all.storm_umbrella;
		if (!proto.enabled || !proto.config.umbrella) return null;
		const risk = await riskFor(all, now);
		if (!risk.atRisk) return { risk };
		const { run, created } = await scheduleRun(proto, { occurrenceKey: `storm:${risk.localDate}`, trigger: "weather", scheduledFor: now, checks: ["patio_umbrella"], now });
		if (created) await event("weather_trigger", { run, detail: { reasons: risk.reasons, earliestAt: risk.earliestAt, urgent: risk.urgent }, now });
		return { risk, run, created };
	}

	async function planRechecks(all, now) {
		for (const incident of await store.activeIncidents({ householdId: HOUSEHOLD })) {
			const proto = all[incident.protocol_id];
			const check = CHECKS[incident.check_id];
			if (!proto || !check) continue;
			if (incident.expires_at && new Date(incident.expires_at) <= now) {
				await closeIncident(incident, "expired", { resolution: "expired", now, detail: { why: "the weather risk has passed" } });
				continue;
			}
			if (!incident.next_recheck_at || new Date(incident.next_recheck_at) > now) continue;
			const n = Number(incident.recheck_count) + 1;
			const claimed = await store.updateIncident(incident.id, incident.state, { next_recheck_at: null, recheck_count: n });
			if (!claimed) continue;
			await scheduleRun(proto, { occurrenceKey: `recheck:${incident.uuid}:${n}`, trigger: "recheck", scheduledFor: now, checks: [incident.check_id], incident, now });
		}
	}

	async function planEscalations(all, now) {
		for (const incident of await store.activeIncidents({ householdId: HOUSEHOLD })) {
			const proto = all[incident.protocol_id];
			if (!proto || incident.state !== "notified" || incident.escalated_at || incident.severity !== "urgent") continue;
			const after = proto.config.escalateAfterMinutes;
			if (!after || now.getTime() - new Date(incident.first_detected_at).getTime() < after * 60_000) continue;
			const check = CHECKS[incident.check_id];
			const subject = subjectFor(all, incident.check_id, incident.subject_key) || { name: incident.context?.subjectName || check.label };
			const claimed = await store.updateIncident(incident.id, "notified", { escalated_at: now });
			if (!claimed) continue;
			await notify(proto, incident, "escalation", escalationText(check, subject, incident), "urgent", { now });
			await event("incident_escalated", { incident, now });
		}
	}

	/** A run that never got observed is a sweep that didn't happen — say so. */
	async function planMissed(all, now) {
		const overdueMs = all.nightly_sweep.config.overdueAfterMinutes * 60_000;
		for (const run of await store.overdueRuns({ now, overdueMs })) {
			if (Number(run.household_id) !== HOUSEHOLD) continue;
			const proto = all[run.protocol_id];
			if (!proto) continue;
			// A morning report hours late is not worth sending; it lapses, recorded.
			if (run.trigger_kind === "report") {
				const lapse = run.state === "scheduled" ? "expired" : "failed";
				if (await store.updateRun(run.id, run.state, { state: runTransition(run.state, lapse), finished_at: now, lease_until: null, summary: { missed: true, reason: "report_not_sent" } })) {
					await event("report_missed", { run, now });
				}
				continue;
			}
			const to = run.state === "scheduled" ? "unknown" : "failed";
			runTransition(run.state, to);
			const moved = await store.updateRun(run.id, run.state, { state: to, finished_at: now, lease_until: null, summary: { ...(run.summary || {}), missed: true, reason: run.state === "scheduled" ? "dispatch_unavailable" : "attempts_exhausted" } });
			if (!moved) continue;
			await event("run_missed", { run, detail: { state: to }, now });
			if (!proto.enabled && run.trigger_kind !== "manual") continue;
			const ctx = { trigger: run.trigger_kind, clock: protocols.clockIn(now, tzOf(all)), weatherPhrase: null, risk: null };
			let notified = false;
			for (const checkId of run.checks || []) {
				// The umbrella only matters under weather risk; a missed calm-night look at it is not an incident.
				if (checkId === "patio_umbrella" && run.trigger_kind === "schedule") continue;
				for (const subject of subjectsFor(all, checkId, run)) {
					const obs = { status: "unknown", reason: "dispatch_unavailable", confidence: null, fresh: false, capturedAt: null, source: "camera", deviceSerial: subject.serial };
					const obsId = await recordObservation(run, CHECKS[checkId], subject, obs, now, 1, null);
					const out = await raise(proto, run, CHECKS[checkId], subject, obs, obsId, ctx, now);
					notified = notified || out.notified;
				}
			}
			if (notified) await store.updateRun(run.id, to, { state: runTransition(to, "notified") });
		}
	}

	/** Failed notifications get another try; held ones go out when their window ends. */
	async function retryNotifications(all, now) {
		for (const n of await store.retryableNotifications({ now, maxAttempts: MAX_NOTIFY_ATTEMPTS })) {
			if (Number(n.household_id) !== HOUSEHOLD) continue;
			const incident = await store.getIncident(n.incident_id);
			if (!incident) continue;
			// A held alert for something already fixed or dismissed has nothing left to say.
			if (n.kind !== "resolved" && !INCIDENT_ACTIVE.includes(incident.state)) {
				await store.updateNotification(n.id, { status: "superseded", last_attempt_at: now });
				continue;
			}
			await deliver(n, incident, { simulated: false, now });
		}
	}

	async function purgeEvidence() {
		for (const uuid of await store.staleEvidence(EVIDENCE_DAYS).catch(() => [])) {
			await Promise.resolve(deps.removeEvidence(uuid)).catch(() => undefined);
			await store.clearEvidence(uuid).catch(() => undefined);
		}
	}

	async function plan({ now = deps.now() } = {}) {
		const all = await loadProtocols();
		const out = { scheduled: [], storm: null, due: 0 };
		if (all.nightly_sweep.enabled) {
			const r = await planNightly(all.nightly_sweep, now);
			if (r.created) out.scheduled.push(r.run.uuid);
			if (all.nightly_sweep.config.reports.morning) {
				const m = await planMorning(all.nightly_sweep, now);
				if (m.created) out.scheduled.push(m.run.uuid);
			}
		}
		const storm = await planStorm(all, now).catch((error) => (console.warn("[guardian] storm plan failed", error?.message), null));
		if (storm) out.storm = { atRisk: !!storm.risk?.atRisk, known: !!storm.risk?.known, created: !!storm.created };
		await planRechecks(all, now);
		await planEscalations(all, now);
		await runReports(now);
		await planMissed(all, now);
		await retryNotifications(all, now);
		await purgeEvidence();
		out.due = (await store.dueRuns({ now, householdId: HOUSEHOLD })).length;
		return out;
	}

	// ---------------------------------------------------------------------
	// Executing a run
	// ---------------------------------------------------------------------

	function subjectFor(all, checkId, key) {
		return subjectsFor(all, checkId, null).find((s) => s.key === key) || null;
	}

	function subjectsFor(all, checkId, run) {
		if (checkId === "garage_door") return all.nightly_sweep.config.garageDoors;
		if (checkId === "patio_umbrella") {
			if (run?.protocol_id === "nightly_sweep" && !all.nightly_sweep.config.includeUmbrella) return [];
			return all.storm_umbrella.config.umbrella ? [all.storm_umbrella.config.umbrella] : [];
		}
		return [];
	}

	async function recordObservation(run, check, subject, obs, now, attempt, evidenceUuid) {
		return store.insertObservation({
			run_id: run.id,
			household_id: HOUSEHOLD,
			check_id: check.id,
			subject_key: subject.key,
			source: obs.source || "camera",
			status: obs.status,
			confidence: obs.confidence,
			captured_at: obs.capturedAt || null,
			observed_at: now,
			fresh: !!obs.fresh,
			attempt,
			reason: obs.reason || null,
			evidence_media_uuid: evidenceUuid,
			device_serial: obs.deviceSerial || subject.serial || null,
			model: obs.model || null,
		});
	}

	/** Scripted observations for simulation: { garage_door: { main: "open" }, patio_umbrella: { patio: "up" } }. */
	function scenarioDeps(scenario, now) {
		return {
			snapshot: async (serial) => (scenario.__offline?.includes(serial) ? { ok: false, reason: "device_unavailable" } : { ok: true, jpeg: Buffer.from("simulated"), capturedAt: now, latencyMs: 0 }),
			vision: async ({ check, subject }) => {
				const state = scenario[check.id]?.[subject.key] || "unknown";
				return { visible: state !== "not_visible", state: state === "not_visible" ? "unknown" : state, confidence: state === "unknown" ? 0.3 : 0.95, reason: "simulation", model: "simulation" };
			},
			sensors: async () => [],
		};
	}

	/** Look at one subject, retrying an unclear answer with a fresh frame. */
	async function lookAt(proto, run, check, subject, { now, scenario, cameraNames }) {
		const config = proto.config;
		const tries = 1 + config.retries;
		let obs = null;
		for (let attempt = 1; attempt <= tries; attempt++) {
			const actionId = attempt === 1 ? (run.trigger_kind === "recheck" ? "incident.verify" : "camera.fresh_snapshot") : "observation.retry";
			const snap = await authorize(actionId, {}, { run, config });
			const vision = await authorize("analysis.vision", {}, { run, config });
			if (!snap.allowed || !vision.allowed) {
				obs = { status: "unknown", reason: "policy", confidence: null, fresh: false, source: "camera" };
				break;
			}
			const observeDeps = scenario ? scenarioDeps(scenario, deps.now()) : deps.observeDeps;
			// A button press runs as the adult who pressed it; a scheduled run as the one who configured it.
			obs = await deps.asProfile(run.requested_by ? Number(run.requested_by) : operatorOf(proto), () =>
				observe.observeSubject({ check, subject, config, captures: new Map(), cameraNames, deps: { now: deps.now, ...observeDeps } })
			);
			const definite = obs.status === check.safe || obs.status === check.unsafe;
			if (definite || attempt === tries) return { obs, attempt };
			await recordObservation(run, check, subject, obs, deps.now(), attempt, null);
			await event("observation_retry", { run, detail: { check: check.id, subject: subject.key, reason: obs.reason, attempt }, now });
			if (config.retryDelaySeconds) await deps.sleep(config.retryDelaySeconds * 1000);
		}
		return { obs, attempt: tries };
	}

	async function execute(run, { scenario = null } = {}) {
		const now = deps.now();
		const all = await loadProtocols();
		const proto = all[run.protocol_id];
		if (!proto || (!proto.enabled && run.trigger_kind !== "manual" && run.trigger_kind !== "recheck")) {
			await store.updateRun(run.id, "observing", { state: runTransition("observing", "suppressed"), finished_at: now, lease_until: null, summary: { reason: "protocol_disabled" } });
			await event("run_suppressed", { run, detail: { reason: "protocol_disabled" }, now });
			return { state: "suppressed" };
		}
		const simulated = !!run.simulated || proto.config.simulation || !!scenario;
		if (run.trigger_kind === "report") return executeMorning(run, proto, all, simulated);
		const tz = tzOf(all);
		const cameraNames = scenario ? new Map() : await deps.cameraNames().catch(() => new Map());
		const incidentOfRun = run.incident_id ? await store.getIncident(run.incident_id) : null;
		// The evening sweep with its report: every problem it finds goes out in
		// the one report push (collected in `deferred`), never as a second push.
		const reportMode = run.protocol_id === "nightly_sweep" && run.trigger_kind === "schedule" && !!proto.config.reports?.evening;
		const deferred = reportMode ? [] : null;
		let risk = null;
		let tonight = null;
		if ((run.checks || []).includes("patio_umbrella") || reportMode) {
			const ok = await authorize("weather.read", {}, { run, config: proto.config });
			risk = ok.allowed ? await riskFor(all, now).catch(() => null) : null;
			if (ok.allowed && reportMode) tonight = await tonightFor(all, now).catch(() => null);
		}
		const ctx = { trigger: run.trigger_kind, clock: protocols.clockIn(now, tz), risk, weatherPhrase: risk?.atRisk ? weatherRisk.phrase(risk) : null };
		const results = [];
		let notified = false;
		for (const checkId of run.checks || []) {
			const check = CHECKS[checkId];
			if (!check) continue;
			let subjects = subjectsFor(all, checkId, run);
			if (incidentOfRun) subjects = subjects.filter((s) => s.key === incidentOfRun.subject_key);
			if (!subjects.length) {
				results.push({ check: checkId, subject: null, status: "not_applicable", reason: "nothing_configured" });
				continue;
			}
			// The umbrella is looked at under weather risk, when the weather is
			// unreadable (unknown is not calm), or to follow up an open incident.
			const applies = !check.appliesWhen || check.appliesWhen(ctx) || risk === null || risk?.known === false || !!incidentOfRun;
			// On a calm night the evening report still looks, so it can say it
			// checked — but what it sees there is information, not an incident.
			const informational = !applies && reportMode;
			if (!applies && !informational) {
				for (const subject of subjects) {
					await recordObservation(run, check, subject, { status: "not_applicable", reason: "no weather risk", source: "weather", fresh: true }, now, 1, null);
					results.push({ check: checkId, subject: subject.key, status: "not_applicable", reason: "no_weather_risk" });
				}
				continue;
			}
			for (const subject of subjects) {
				const { obs, attempt } = await lookAt(proto, run, check, subject, { now, scenario, cameraNames });
				const safe = obs.status === check.safe;
				let evidence = null;
				// Keep the frame only when it is the reason someone will be told.
				if (!safe && !informational && obs.jpeg && !simulated) {
					evidence = await Promise.resolve(deps.saveEvidence({ profileId: operatorOf(proto), serial: subject.serial, cameraName: obs.cameraName, jpeg: obs.jpeg })).catch(() => null);
				}
				const obsId = await recordObservation(run, check, subject, obs, deps.now(), attempt, evidence);
				const out = safe
					? await settle(proto, run, check, subject, obs, obsId, ctx, { simulated, defer: deferred })
					: informational
						? { notified: false, incident: null }
						: await raise(proto, run, check, subject, obs, obsId, ctx, deps.now(), { simulated, defer: deferred });
				notified = notified || out.notified;
				results.push({ check: checkId, subject: subject.key, status: obs.status, reason: obs.reason || null, confidence: obs.confidence, incident: out.incident?.uuid || null, ...(informational ? { informational: true } : {}) });
			}
		}
		let report = null;
		if (reportMode) {
			const nameOf = (checkId, key) => subjectsFor(all, checkId, run).find((s) => s.key === key)?.name || key;
			const garage = results.filter((r) => r.check === "garage_door" && r.subject).map((r) => ({ name: nameOf("garage_door", r.subject), status: r.status, reason: r.reason }));
			const u = results.find((r) => r.check === "patio_umbrella" && r.subject);
			const words = reports.eveningText({ garage, umbrella: u ? { name: nameOf("patio_umbrella", u.subject), status: u.status, reason: u.reason } : null, risk, tonight });
			const deliveries = await sendReport(proto, run, { kind: "evening", ...words, deferred, now: deps.now(), simulated });
			report = { kind: "evening", text: words.text, deliveries };
			notified = notified || deliveries.length > 0;
		}
		// A test leaves nothing open behind it: its incidents live under their own
		// keys (so they can never swallow a real alert) and close when it ends.
		if (simulated) {
			for (const r of results) {
				const incident = r.incident ? await store.incidentByUuid(HOUSEHOLD, r.incident) : null;
				if (incident && INCIDENT_ACTIVE.includes(incident.state)) {
					await closeIncident(incident, "dismissed", { resolution: "dismissed", now: deps.now(), detail: { reason: "test run" }, extra: { dismiss_reason: "Test run — nothing was real." } });
				}
			}
		}
		await store.updateRun(run.id, "observing", { state: runTransition("observing", "evaluating") });
		const looked = results.filter((r) => r.status !== "not_applicable" && !r.informational);
		const unsafe = looked.some((r) => CHECKS[r.check] && r.status === CHECKS[r.check].unsafe);
		const unknown = looked.some((r) => CHECKS[r.check] && r.status !== CHECKS[r.check].safe && r.status !== CHECKS[r.check].unsafe);
		const verdict = unsafe ? "attention_required" : unknown ? "unknown" : "safe";
		const summary = { results, risk: risk ? { atRisk: risk.atRisk, known: risk.known, reasons: risk.reasons, earliestAt: risk.earliestAt } : null, simulated, ...(report ? { report } : {}) };
		await store.updateRun(run.id, "evaluating", { state: runTransition("evaluating", verdict), finished_at: deps.now(), lease_until: null, summary });
		let finalState = verdict;
		if (notified && verdict !== "safe") {
			await store.updateRun(run.id, verdict, { state: runTransition(verdict, "notified") });
			finalState = "notified";
		}
		await event("run_finished", { run, detail: { state: finalState, results: results.map(({ check, subject, status, reason }) => ({ check, subject, status, reason })) }, now: deps.now() });
		return { state: finalState, results, simulated, ...(report ? { report } : {}) };
	}

	async function tonightFor(all, now) {
		const storm = all.storm_umbrella;
		const operator = operatorOf(storm.updatedBy ? storm : all.nightly_sweep);
		const place = operator ? await Promise.resolve(deps.homePlace(operator, storm.config.placeUuid)).catch(() => null) : null;
		return deps.tonight(place, storm.config.weather || {}, { now });
	}

	/**
	 * The morning report: what happened since last evening's sweep. It looks at
	 * nothing new — it reads what the engine recorded overnight (and any
	 * strangers the sightings log has), so it costs no camera battery.
	 */
	async function executeMorning(run, proto, all, simulated) {
		const now = deps.now();
		if (!proto.config.reports?.morning) {
			await store.updateRun(run.id, "observing", { state: runTransition("observing", "suppressed"), finished_at: now, lease_until: null, summary: { reason: "morning_report_off" } });
			return { state: "suppressed" };
		}
		const tz = tzOf(all);
		const runs = await store.recentRuns(HOUSEHOLD, 80);
		const lastSweep = runs.find((r) => r.protocol_id === "nightly_sweep" && r.trigger_kind === "schedule" && new Date(r.scheduled_for) < now && now - new Date(r.scheduled_for) < 20 * 3_600_000);
		const from = lastSweep ? new Date(lastSweep.scheduled_for) : new Date(now.getTime() - 12 * 3_600_000);
		const inWindow = (v) => v && new Date(v) >= from && new Date(v) <= now;
		const incidents = (await store.recentIncidents(HOUSEHOLD, 50)).filter(
			(i) => !i.context?.simulated && (INCIDENT_ACTIVE.includes(i.state) || inWindow(i.first_detected_at) || inWindow(i.resolved_at))
		);
		const missed = runs.filter((r) => r.summary?.missed && r.trigger_kind !== "report" && inWindow(r.scheduled_for));
		const strangers = await Promise.resolve(deps.overnightStrangers(from, now)).catch(() => null);
		const words = reports.morningText({ from, to: now, incidents, missed, strangers, clock: (d) => protocols.clockIn(d, tz) });
		await store.updateRun(run.id, "observing", { state: runTransition("observing", "evaluating") });
		const deliveries = await sendReport(proto, run, { kind: "morning", ...words, deferred: [], now, simulated });
		const report = { kind: "morning", text: words.text, deliveries };
		await store.updateRun(run.id, "evaluating", { state: runTransition("evaluating", "safe"), finished_at: deps.now(), lease_until: null, summary: { results: [], report, window: { from, to: now }, simulated } });
		return { state: "safe", report };
	}

	/**
	 * One report push per approved recipient. Any incident the sweep found
	 * rides in it: its alert rows are written with the report's delivery, so
	 * dedupe, escalation and the failed-delivery retry all work as for any alert.
	 */
	async function sendReport(proto, run, { kind, text, severity, deferred = [], now, simulated }) {
		const allowedIds = deps.allowedIds();
		const recipients = recipientsFor(proto);
		if (!recipients.length) await event("no_recipients", { run, detail: { kind }, now });
		const deliveries = [];
		for (const profileId of recipients) {
			const decision = await authorize("notify.household", { recipientApproved: allowedIds.includes(Number(profileId)) }, { run, config: proto.config });
			if (!decision.allowed) continue;
			let status = "simulated";
			let nudgeUuid = null;
			let result = null;
			if (!simulated) {
				nudgeUuid = randomUUID();
				try {
					await store.insertNudge({ uuid: nudgeUuid, profileId, dedupeKey: `report:${run.uuid}`, urgency: severity === "urgent" ? "high" : "normal", text, facts: { run: run.uuid, kind }, ttlSeconds: NUDGE_TTL_S });
					result = await deps.push().deliverNudge(profileId, { uuid: nudgeUuid, text, trigger_id: "guardian" });
				} catch (error) {
					result = { sent: 0, failed: 1, error: error?.message || "delivery failed" };
				}
				status = Number(result?.sent || 0) > 0 ? "sent" : result?.skipped && !result?.failed ? "in_app" : "failed";
			}
			deliveries.push({ profileId: Number(profileId), status });
			for (const d of deferred) {
				const { notification, created } = await store.insertNotification({ incident_id: d.incident.id, household_id: HOUSEHOLD, profile_id: profileId, kind: d.kind, status, text, created_at: now });
				if (created) await store.updateNotification(notification.id, { attempts: simulated ? 0 : 1, nudge_uuid: nudgeUuid, result: result ? { sent: result.sent || 0, failed: result.failed || 0, skipped: result.skipped || null, error: result.error || null } : null, last_attempt_at: now });
			}
		}
		if (deliveries.length) {
			for (const d of deferred) {
				const fresh = await store.getIncident(d.incident.id);
				if (fresh?.state === "open") await store.updateIncident(fresh.id, "open", { state: incidentTransition("open", "notified") });
			}
		}
		await event(`report_${kind}`, { run, detail: { deliveries, severity, incidents: deferred.length }, now });
		return deliveries;
	}

	/** Fresh evidence of the safe state: resolve an open incident for it, if there is one. */
	const openKeyOf = (check, subject, simulated) => `${simulated ? "sim:" : ""}${check.id}:${subject.key}`;

	async function settle(proto, run, check, subject, obs, obsId, ctx, { simulated = false, defer = null } = {}) {
		const incident = await store.openIncident(HOUSEHOLD, openKeyOf(check, subject, simulated));
		if (!incident) return { notified: false, incident: null };
		const wasTold = incident.state === "notified";
		await closeIncident(incident, "resolved", { resolution: "verified_safe", now: deps.now(), observationId: obsId, detail: { confidence: obs.confidence, run: run.uuid } });
		let notified = false;
		// The people who were alerted and haven't said they're on it hear that
		// it's fixed — in the evening report itself, when there is one.
		if (wasTold && !defer) {
			const text = check.resolvedText(subject, obs, ctx);
			notified = (await notify(proto, incident, "resolved", text, "advisory", { now: deps.now(), simulated: !!run.simulated || proto.config.simulation, onlyAlerted: true })).count > 0;
		}
		return { notified, incident };
	}

	/** An unsafe or unverifiable result: open an incident, or update the open one. */
	async function raise(proto, run, check, subject, obs, obsId, ctx, now, { simulated = false, defer = null } = {}) {
		const unsafe = obs.status === check.unsafe;
		const condition = unsafe ? check.unsafe : obs.status === "offline" ? "offline" : "unknown";
		const severity = unsafe ? check.severity(ctx) : check.id === "garage_door" ? "urgent" : "advisory";
		const writeOk = await authorize("incident.write", { confidence: obs.confidence }, { run, config: proto.config });
		if (!writeOk.allowed) return { notified: false, incident: null };
		const openKey = openKeyOf(check, subject, simulated);
		const recheckAt = new Date(now.getTime() + check.recheckMinutes * 60_000);
		const expiresAt = check.id === "patio_umbrella" && ctx.risk?.earliestAt ? new Date(Math.max(Date.parse(ctx.risk.earliestAt), now.getTime()) + 6 * 3_600_000) : null;
		const existing = await store.openIncident(HOUSEHOLD, openKey);
		const context = { subjectName: subject.name, camera: obs.cameraName || null, reason: obs.reason || null, weather: ctx.risk?.atRisk ? { reasons: ctx.risk.reasons, earliestAt: ctx.risk.earliestAt } : null, ...(simulated ? { simulated: true } : {}) };
		const lastGood = await store.lastGoodObservation(HOUSEHOLD, check.id, subject.key).catch(() => null);
		const wordCtx = { ...ctx, lastGoodAt: lastGood?.observed_at || null };
		const text = unsafe ? check.alertText(subject, obs, wordCtx) : unknownText(check, subject, obs, wordCtx);
		if (existing) {
			const conditionChanged = existing.condition_status !== condition;
			const patch = { last_verified_at: now, last_observation_id: obsId, condition_status: condition, confidence: obs.confidence, context: { ...(existing.context || {}), ...context } };
			if (Number(existing.recheck_count) < check.maxRechecks) patch.next_recheck_at = recheckAt;
			if (expiresAt) patch.expires_at = expiresAt;
			// Severity only rises: an advisory that became urgent is told as urgent.
			if (severity === "urgent") patch.severity = "urgent";
			await store.updateIncident(existing.id, existing.state, patch);
			await event("incident_reverified", { run, incident: existing, detail: { condition, conditionChanged }, now });
			if (Number(existing.recheck_count) < check.maxRechecks) await Promise.resolve(deps.wake(recheckAt)).catch(() => false);
			// Same unresolved condition: no one is told again. A condition that
			// became known ("unknown" → "open") is new information, told once.
			if (conditionChanged && unsafe) {
				if (defer) {
					defer.push({ incident: { ...existing, ...patch }, kind: "update", severity });
					return { notified: false, incident: existing };
				}
				const r = await notify(proto, { ...existing, ...patch }, "update", text, severity, { now, simulated });
				return { notified: r.count > 0, incident: existing };
			}
			return { notified: false, incident: existing };
		}
		const { incident, created } = await store.insertIncident({
			uuid: randomUUID(),
			household_id: HOUSEHOLD,
			protocol_id: proto.def.id,
			check_id: check.id,
			subject_key: subject.key,
			open_key: openKey,
			condition_status: condition,
			severity,
			confidence: obs.confidence,
			trigger_run_id: run.id,
			trigger_kind: run.trigger_kind,
			last_observation_id: obsId,
			first_detected_at: now,
			last_verified_at: now,
			next_recheck_at: simulated ? null : recheckAt,
			expires_at: expiresAt,
			context,
		});
		if (!created) return { notified: false, incident };
		await event("incident_opened", { run, incident, detail: { condition, severity, confidence: obs.confidence, reason: obs.reason || null, simulated }, now });
		if (!simulated) await Promise.resolve(deps.wake(recheckAt)).catch(() => false);
		if (defer) {
			defer.push({ incident, kind: "alert", severity });
			return { notified: false, incident };
		}
		const r = await notify(proto, incident, "alert", text, severity, { now, simulated });
		return { notified: r.count > 0, incident };
	}

	async function closeIncident(incident, to, { resolution, now, observationId = null, actor = "engine", detail = null, extra = {} }) {
		incidentTransition(incident.state, to);
		const patch = { state: to, open_key: null, resolved_at: now, resolution, next_recheck_at: null, ...extra };
		if (observationId) Object.assign(patch, { last_observation_id: observationId, last_verified_at: now });
		const moved = await store.updateIncident(incident.id, incident.state, patch);
		if (moved) await event(`incident_${to}`, { incident, actor, detail, now });
		return moved;
	}

	// ---------------------------------------------------------------------
	// Notifications
	// ---------------------------------------------------------------------

	/**
	 * Tell the household about one incident. Unique per (incident, person,
	 * kind), so calling this twice tells no one twice. Returns { count }.
	 */
	async function notify(proto, incident, kind, text, severity, { now, simulated: simulatedRun = false, onlyAlerted = false }) {
		const simulated = simulatedRun || proto.config.simulation;
		const allowedIds = deps.allowedIds();
		let recipients = recipientsFor(proto);
		if (onlyAlerted) {
			const sent = (await store.notificationsFor([incident.id])).filter((n) => n.kind === "alert" || n.kind === "update" || n.kind === "escalation");
			recipients = recipients.filter((id) => sent.some((n) => Number(n.profile_id) === id));
		}
		if (!recipients.length) {
			await event("no_recipients", { incident, detail: { kind }, now });
			return { count: 0 };
		}
		const tz = proto.config.schedule?.timeZone || "America/New_York";
		const held = severity !== "urgent" && protocols.inQuiet(proto.config.quiet, now, tz);
		const holdUntil = held ? protocols.quietEnds(proto.config.quiet, now, tz) : null;
		let count = 0;
		for (const profileId of recipients) {
			const decision = await authorize("notify.household", { recipientApproved: allowedIds.includes(Number(profileId)) }, { incident, config: proto.config });
			if (!decision.allowed) continue;
			const { notification, created } = await store.insertNotification({
				incident_id: incident.id,
				household_id: HOUSEHOLD,
				profile_id: profileId,
				kind,
				status: simulated ? "simulated" : held ? "held" : "pending",
				text,
				hold_until: holdUntil,
				created_at: now,
			});
			if (!created) continue;
			count += 1;
			if (simulated || held) {
				await event(simulated ? "notification_simulated" : "notification_held", { incident, detail: { profileId, kind, holdUntil }, now });
				continue;
			}
			await deliver(notification, { ...incident, severity }, { now });
		}
		if (count && (kind === "alert" || kind === "update")) {
			// An incident someone already acknowledged stays acknowledged.
			const fresh = await store.getIncident(incident.id);
			if (fresh?.state === "open") await store.updateIncident(fresh.id, "open", { state: incidentTransition("open", "notified") });
		}
		return { count };
	}

	/** Push it (FCM / web push / SMS devices), with the in-app nudge always written first. */
	async function deliver(n, incident, { now }) {
		const nudgeUuid = n.nudge_uuid || randomUUID();
		let result;
		try {
			if (!n.nudge_uuid) {
				await store.insertNudge({ uuid: nudgeUuid, profileId: n.profile_id, dedupeKey: `${incident.uuid}:${n.kind}`, urgency: incident.severity === "urgent" ? "high" : "normal", text: n.text, facts: { incident: incident.uuid, check: incident.check_id, kind: n.kind }, ttlSeconds: NUDGE_TTL_S });
			}
			result = await deps.push().deliverNudge(n.profile_id, { uuid: nudgeUuid, text: n.text, trigger_id: "guardian" });
		} catch (error) {
			result = { sent: 0, failed: 1, error: error?.message || "delivery failed" };
		}
		const sent = Number(result?.sent || 0) > 0;
		// Nothing to retry when the person has no device or push off: it waits in the app.
		const status = sent ? "sent" : result?.skipped && !result?.failed ? "in_app" : "failed";
		await store.updateNotification(n.id, { status, attempts: Number(n.attempts || 0) + 1, nudge_uuid: nudgeUuid, result: { sent: result?.sent || 0, failed: result?.failed || 0, skipped: result?.skipped || null, error: result?.error || null }, last_attempt_at: now, hold_until: null });
		if (!sent) await event(status === "failed" ? "notification_failed" : "notification_in_app_only", { incident, detail: { profileId: n.profile_id, kind: n.kind, skipped: result?.skipped || null, error: result?.error || null, attempt: Number(n.attempts || 0) + 1 }, now });
		return status;
	}

	// ---------------------------------------------------------------------
	// Entry points
	// ---------------------------------------------------------------------

	async function claimAndExecute(run, opts = {}) {
		const claimed = await store.claimRun(run.id, { now: deps.now(), leaseMs: LEASE_MS, maxAttempts: MAX_RUN_ATTEMPTS });
		if (!claimed) return { claimed: false };
		try {
			return { claimed: true, ...(await execute(await store.getRun(run.id), opts)) };
		} catch (error) {
			// The lease runs out and the run is claimed again; after three
			// attempts the planner reports it as missed.
			console.error("[guardian] run failed", { run: run.uuid, message: error?.message });
			await event("run_error", { run, detail: { message: error?.message } });
			return { claimed: true, state: "error" };
		}
	}

	/** The service's pass: plan, then observe everything due. */
	async function runDue({ now = deps.now() } = {}) {
		const planned = await plan({ now });
		const ran = [];
		// The scheduled sweep first: when a storm watch comes due in the same
		// pass, it then finds the umbrella already in the evening report rather
		// than sending a second push about it.
		const due = (await store.dueRuns({ now: deps.now(), householdId: HOUSEHOLD })).sort((a, b) => (b.trigger_kind === "schedule") - (a.trigger_kind === "schedule"));
		for (const run of due) {
			const out = await claimAndExecute(run);
			if (out.claimed) ran.push({ run: run.uuid, protocol: run.protocol_id, state: out.state });
		}
		return { planned, ran };
	}

	async function runNow(profileId, protocolId, { simulate = false, scenario = null } = {}) {
		const all = await loadProtocols();
		const proto = all[protocolId];
		if (!proto) throw bad("Unknown protocol.", 404);
		const now = deps.now();
		const { run } = await scheduleRun(proto, { occurrenceKey: `manual:${randomUUID()}`, trigger: "manual", scheduledFor: now, checks: proto.def.checks, simulated: simulate || !!scenario, requestedBy: profileId, now });
		await event("run_requested", { run, actor: `profile:${profileId}`, detail: { simulate: simulate || !!scenario }, now });
		await store.audit(profileId, `guardian_run:${protocolId}${simulate || scenario ? ":sim" : ""}`);
		const out = await claimAndExecute(run, { scenario: scenario || (simulate ? {} : null) });
		return { run: run.uuid, ...out };
	}

	async function incidentFor(uuid) {
		const incident = await store.incidentByUuid(HOUSEHOLD, String(uuid || ""));
		if (!incident) throw bad("That incident isn't here.", 404);
		return incident;
	}

	async function recheck(profileId, uuid) {
		const incident = await incidentFor(uuid);
		if (!INCIDENT_ACTIVE.includes(incident.state)) throw bad("That incident is already closed.", 409);
		const all = await loadProtocols();
		const proto = all[incident.protocol_id];
		const now = deps.now();
		const { run } = await scheduleRun(proto, { occurrenceKey: `recheck:${incident.uuid}:manual:${randomUUID().slice(0, 8)}`, trigger: "recheck", scheduledFor: now, checks: [incident.check_id], incident, requestedBy: profileId, now });
		await event("recheck_requested", { run, incident, actor: `profile:${profileId}`, now });
		await store.audit(profileId, "guardian_recheck");
		const out = await claimAndExecute(run);
		return { run: run.uuid, ...out, incident: await store.getIncident(incident.id) };
	}

	async function acknowledge(profileId, uuid) {
		const incident = await incidentFor(uuid);
		if (incident.state === "acknowledged") return incident;
		const now = deps.now();
		const to = incidentTransition(incident.state, "acknowledged");
		// Acknowledged keeps the incident open: it is still rechecked and only
		// fresh evidence (or a dismissal) closes it.
		const moved = await store.updateIncident(incident.id, incident.state, { state: to, acknowledged_by: profileId, acknowledged_at: now });
		if (!moved) throw bad("That incident changed; refresh and try again.", 409);
		await event("incident_acknowledged", { incident, actor: `profile:${profileId}`, now });
		await store.audit(profileId, "guardian_acknowledge");
		return store.getIncident(incident.id);
	}

	async function dismiss(profileId, uuid, reason) {
		const why = typeof reason === "string" ? reason.trim().slice(0, 300) : "";
		if (why.length < 3) throw bad("Say why you're dismissing it.");
		const incident = await incidentFor(uuid);
		const now = deps.now();
		const moved = await closeIncident(incident, "dismissed", { resolution: "dismissed", now, actor: `profile:${profileId}`, detail: { reason: why }, extra: { dismissed_by: profileId, dismiss_reason: why } });
		if (!moved) throw bad("That incident changed; refresh and try again.", 409);
		await store.audit(profileId, "guardian_dismiss");
		return store.getIncident(incident.id);
	}

	async function assign(profileId, uuid, assignee) {
		const incident = await incidentFor(uuid);
		const target = assignee == null ? null : Number(assignee);
		if (target !== null && !deps.allowedIds().includes(target)) throw bad("Only adults authorized for household security can be assigned.", 403);
		const moved = await store.updateIncident(incident.id, incident.state, { assigned_profile_id: target });
		if (!moved) throw bad("That incident changed; refresh and try again.", 409);
		await event("incident_assigned", { incident, actor: `profile:${profileId}`, detail: { assignee: target } });
		return store.getIncident(incident.id);
	}

	/**
	 * Anything outside the engine asking it to act. The only answer above
	 * level 2 is no — with the reason, audited — and nothing here can call a
	 * device: a physical action belongs on the action layer's approval card.
	 */
	async function requestAction(actionId, { requestedBy = "engine", confidence = null } = {}) {
		const decision = policy.authorize(actionId, { confidence });
		await event(decision.allowed ? "action_allowed" : "policy_refused", { actor: String(requestedBy), detail: { actionId, level: decision.level, reasons: decision.reasons } });
		if (!decision.allowed) await store.audit(requestedBy, `guardian_refused:${actionId}`).catch(() => undefined);
		return { ...decision, executed: false };
	}

	const iso = (v) => (v ? new Date(v).toISOString() : null);

	function publicIncident(i, notes, observations) {
		const obs = observations.find((o) => Number(o.id) === Number(i.last_observation_id));
		return {
			id: i.uuid,
			protocol: i.protocol_id,
			check: i.check_id,
			subject: i.subject_key,
			subjectName: i.context?.subjectName || CHECKS[i.check_id]?.label || i.subject_key,
			camera: i.context?.camera || null,
			state: i.state,
			condition: i.condition_status,
			severity: i.severity,
			confidence: i.confidence == null ? null : Number(i.confidence),
			reason: i.context?.reason || null,
			weather: i.context?.weather || null,
			trigger: i.trigger_kind,
			firstDetectedAt: iso(i.first_detected_at),
			lastVerifiedAt: iso(i.last_verified_at),
			acknowledgedBy: i.acknowledged_by == null ? null : Number(i.acknowledged_by),
			acknowledgedAt: iso(i.acknowledged_at),
			assignedTo: i.assigned_profile_id == null ? null : Number(i.assigned_profile_id),
			resolvedAt: iso(i.resolved_at),
			resolution: i.resolution || null,
			dismissReason: i.dismiss_reason || null,
			rechecks: Number(i.recheck_count),
			nextRecheckAt: iso(i.next_recheck_at),
			escalatedAt: iso(i.escalated_at),
			evidenceMediaId: obs?.evidence_media_uuid || null,
			observedAt: iso(obs?.observed_at),
			notifications: notes.filter((n) => Number(n.incident_id) === Number(i.id)).map((n) => ({ profileId: Number(n.profile_id), kind: n.kind, status: n.status, attempts: Number(n.attempts), holdUntil: iso(n.hold_until), lastAttemptAt: iso(n.last_attempt_at), skipped: n.result?.skipped || null })),
		};
	}

	function publicRun(r) {
		return { id: r.uuid, protocol: r.protocol_id, trigger: r.trigger_kind, state: r.state, scheduledFor: iso(r.scheduled_for), startedAt: iso(r.started_at), finishedAt: iso(r.finished_at), attempts: Number(r.attempts), simulated: r.simulated === 1 || r.simulated === true, results: r.summary?.results || [], risk: r.summary?.risk || null, missed: !!r.summary?.missed, reason: r.summary?.reason || null, report: r.summary?.report ? { kind: r.summary.report.kind, text: r.summary.report.text, deliveries: r.summary.report.deliveries || [] } : null };
	}

	/**
	 * Everything the Guardian section shows. `devices` is the bridge's roster
	 * (the controller reads it with the page's own status call). Reading this
	 * never captures, observes or notifies anything.
	 */
	async function overview({ devices = null, bridgeState = null } = {}) {
		const now = deps.now();
		const all = await loadProtocols();
		const [active, recentInc, runs, events] = await Promise.all([
			store.activeIncidents({ householdId: HOUSEHOLD }),
			store.recentIncidents(HOUSEHOLD, 15),
			store.recentRuns(HOUSEHOLD, 60),
			store.recentEvents(HOUSEHOLD, 30),
		]);
		const closed = recentInc.filter((i) => !INCIDENT_ACTIVE.includes(i.state)).slice(0, 8);
		const incidents = [...active, ...closed];
		const [notes, observations, names] = await Promise.all([
			store.notificationsFor(incidents.map((i) => i.id)),
			store.observationsByIds(incidents.map((i) => i.last_observation_id).filter(Boolean)),
			store.profileNames(deps.allowedIds()),
		]);
		// Tests are shown in the activity list but never count toward status or health.
		const real = (r) => !(r.simulated === 1 || r.simulated === true);
		const isReport = (r) => r.trigger_kind === "report";
		const sweeps = runs.filter((r) => r.protocol_id === "nightly_sweep" && r.state !== "scheduled" && real(r) && !isReport(r));
		const lastSweep = sweeps[0] || null;
		const pending = (pred) => runs.filter((r) => r.protocol_id === "nightly_sweep" && r.state === "scheduled" && pred(r)).sort((a, b) => new Date(a.scheduled_for) - new Date(b.scheduled_for))[0] || null;
		const nextSweep = pending((r) => !isReport(r));
		const nextMorning = pending(isReport);
		const week = runs.filter((r) => now - new Date(r.scheduled_for) <= 7 * 86_400_000 && r.state !== "scheduled" && real(r) && !isReport(r));
		const count = (pred) => week.filter(pred).length;
		const anyOn = all.nightly_sweep.enabled || all.storm_umbrella.enabled;
		const status = !anyOn ? "off" : active.some((i) => i.condition_status !== "unknown" && i.condition_status !== "offline") ? "attention" : active.length ? "unverified" : lastSweep && lastSweep.state === "safe" ? "secure" : lastSweep ? "unverified" : "waiting";
		let weather = null;
		if (all.storm_umbrella.config.umbrella || all.nightly_sweep.config.includeUmbrella) {
			const r = await riskFor(all, now).catch(() => null);
			if (r) weather = { atRisk: r.atRisk, known: r.known, urgent: r.urgent, reasons: r.reasons, earliestAt: r.earliestAt, checkedAt: r.checkedAt, sources: r.sources, thresholds: r.thresholds };
		}
		const watched = new Set([...all.nightly_sweep.config.garageDoors.map((d) => d.serial), all.storm_umbrella.config.umbrella?.serial].filter(Boolean));
		return {
			status,
			bridge: bridgeState,
			protocols: Object.values(all).map((p) => ({ id: p.def.id, label: p.def.label, describe: p.def.describe, version: p.def.version, enabled: p.enabled, config: p.config, updatedBy: p.updatedBy, updatedAt: iso(p.updatedAt), policy: policy.describe(p.config.autonomy) })),
			lastSweep: lastSweep ? publicRun(lastSweep) : null,
			nextSweepAt: iso(nextSweep?.scheduled_for),
			nextMorningReportAt: iso(nextMorning?.scheduled_for),
			incidents: incidents.map((i) => publicIncident(i, notes, observations)),
			runs: runs.slice(0, 12).map(publicRun),
			events: events.map((e) => ({ kind: e.kind, actor: e.actor, at: iso(e.at), detail: e.detail })),
			weather,
			cameras: (devices || []).filter((d) => (d.capabilities || []).includes("camera")).map((d) => ({ serial: d.serial, name: d.name, watched: watched.has(d.serial), lastSeenAt: d.lastSeenAt || null, batteryPercent: d.batteryPercent ?? null, freshSnapshotAvailable: !!d.freshSnapshotAvailable })),
			recipients: names,
			health: {
				runs: week.length,
				safe: count((r) => r.state === "safe"),
				attention: count((r) => r.state === "attention_required" || (r.state === "notified" && (r.summary?.results || []).some((x) => CHECKS[x.check] && x.status === CHECKS[x.check].unsafe))),
				unknown: count((r) => r.state === "unknown" || (r.state === "notified" && !(r.summary?.results || []).some((x) => CHECKS[x.check] && x.status === CHECKS[x.check].unsafe))),
				failed: count((r) => r.state === "failed"),
				missed: count((r) => !!r.summary?.missed),
				notificationsFailed: notes.filter((n) => n.status === "failed").length,
			},
		};
	}

	return {
		plan, runDue, runNow, recheck, acknowledge, dismiss, assign, saveConfig, requestAction, overview,
		loadProtocols, recipientsFor, riskFor, execute: claimAndExecute, deps, HOUSEHOLD,
	};
}

const engine = createEngine();
module.exports = { ...engine, createEngine, HOUSEHOLD, LEASE_MS, MAX_RUN_ATTEMPTS, MAX_NOTIFY_ATTEMPTS };
