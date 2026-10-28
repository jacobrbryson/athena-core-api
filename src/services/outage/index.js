/**
 * The outage watch: when several independent things at home go quiet
 * together, work out what can be worked out, tell the household once, and say
 * when it's over.
 *
 *   noteNestEvent({ wentOffline, wentOnline })  the Nest webhook's hook: books ONE
 *                                  delayed check (a Cloud Task, never a poller)
 *   run({ reason })                the assessment — the core service only (it alone
 *                                  reaches the camera bridge)
 *   backstopDue({ now })           DB-only: should the hourly job ask the service to run?
 *
 * The footing is the Guardian Engine's, not Initiative's (initiative/ is
 * protected and this is not one of its triggers): an `athena_nudge` row with
 * trigger_id 'outage' plus push.deliverNudge. There is no cap, no cooldown, no
 * spacing and no shared collapse key — each report and each recovery note is
 * its own nudge, and an observation is never discarded. One report per
 * episode and one recovery note per episode come from the unique open_key and
 * the nudge dedupe key, not from a limit on telling.
 *
 * Detection is by absence. When the home internet is out, nothing can say so,
 * so the first offline transition books a check a few minutes later and the
 * hourly athena-incidents job asks for one if none ran. A quiet pass and a
 * pass whose checks failed are different rows in athena_outage_assessment.
 */
const { randomUUID } = require("node:crypto");
const classify = require("./classify");
const evidence = require("./evidence");

const HOUSEHOLD_TZ = () => process.env.OUTAGE_TIME_ZONE || "America/New_York";
/** First delayed check after an offline transition: long enough for the others to drop and the bridge's silence to be real. */
const CHECK_DELAY_MS = 3 * 60_000;
const BUCKET_MS = 5 * 60_000;
const NUDGE_TTL_S = 12 * 3600;
/** A bridge that has been down this long is worth its own note when no outage explains it. */
const BRIDGE_REPORT_AFTER_MS = 45 * 60_000;
const BACKSTOP_IDLE_MS = 60 * 60_000;
const BACKSTOP_OPEN_MS = 15 * 60_000;
/** An episode nobody could close in three days is closed quietly so it can't block the next one. */
const EPISODE_MAX_MS = 72 * 3600_000;

const message = (err) => String(err?.message || err).slice(0, 200);

function createOutage(overrides = {}) {
	const deps = {
		store: require("./store"),
		recipients: () => require("../eufyBridge").authorizedProfileIds().map(Number).filter(Number.isFinite),
		bridgeHealth: () => require("../eufyBridge").health(),
		places: async (profileIds) => {
			const watch = require("../pulsepoint/watch");
			const byId = new Map();
			for (const id of profileIds) for (const p of await watch.listPlaces(id)) if (p.enabled && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && !byId.has(p.uuid)) byId.set(p.uuid, p);
			return [...byId.values()];
		},
		nws: (places) => require("../pulsepoint/nws").alertsForPlaces(places),
		llm: () => require("../llm"),
		push: () => require("../push"),
		wake: (at, opts) => require("../guardianEngine/dispatch").wakeAt(at, opts),
		now: () => new Date(),
		...overrides,
	};
	const store = deps.store;

	// -- telling ----------------------------------------------------------------

	/** One nudge per recipient (in-app always; push as configured). Resolves how many were reached. */
	async function tell(profileIds, { dedupeKey, text, facts }) {
		const results = [];
		for (const profileId of profileIds) {
			const uuid = randomUUID();
			try {
				// A nudge already written under this key was already told: don't push it twice.
				if (!(await store.insertNudge({ uuid, profileId, dedupeKey, text, facts, ttlSeconds: NUDGE_TTL_S }))) {
					results.push({ profileId, uuid: null, duplicate: true, pushed: false });
					continue;
				}
				const pushed = await deps.push().deliverNudge(profileId, { uuid, text, trigger_id: "outage" });
				results.push({ profileId, uuid, pushed: Number(pushed?.sent || 0) > 0 });
			} catch (err) {
				results.push({ profileId, uuid: null, pushed: false, error: message(err) });
			}
		}
		return { results, written: results.filter((r) => (r.uuid || r.duplicate) && !r.error).length, pushed: results.filter((r) => r.pushed).length };
	}

	// -- gathering ----------------------------------------------------------------

	async function gather(profileIds, now, errors) {
		const checked = [];
		let nest = null;
		try {
			nest = await store.nestOffline(profileIds);
			checked.push({ source: "nest", ok: true, offline: nest.map((d) => d.label) });
		} catch (err) {
			errors.push({ source: "nest", error: message(err) });
			checked.push({ source: "nest", ok: false, error: message(err) });
		}
		let bridge = null;
		const health = await deps.bridgeHealth();
		if (health.configured !== false) {
			bridge = health;
			checked.push({ source: "camera_bridge", ok: health.reachable, state: health.state || null, error: health.error || null });
			if (!health.reachable) errors.push({ source: "camera_bridge", error: health.error });
		}
		try {
			const sites = await store.siteStatus(now);
			checked.push({ source: "sites", ok: true, ...sites, note: "Sites run in the cloud: failing ones point away from a power cut at home." });
		} catch (err) {
			checked.push({ source: "sites", ok: false, error: message(err) });
		}
		try {
			const seen = await store.phoneLastSeen(profileIds);
			checked.push({ source: "phone", ok: true, lastSeenAt: seen ? seen.toISOString() : null });
		} catch (err) {
			checked.push({ source: "phone", ok: false, error: message(err) });
		}
		return { nest, bridge, health, checked };
	}

	// -- the camera bridge on its own (Part B: a silent bridge can't go unseen) ------

	async function trackBridge({ health, now, profileIds, episodeOpen, errors }) {
		if (health.configured === false) return null;
		const prev = await store.bridgeHealth();
		const ok = health.reachable && health.state === "ready";
		const state = health.reachable ? health.state : "unreachable";
		const next = { state, since: prev.since, lastOkAt: prev.lastOkAt, checkedAt: now, reportedSince: prev.reportedSince, recoveryPending: prev.recoveryPending };
		let told = null;
		if (ok) {
			if (prev.state !== "ready" && prev.state !== "unknown") {
				// A bridge that was down is up. Say so only if the household was told it was down.
				if (prev.recoveryPending && prev.since) {
					const r = await tell(profileIds, { dedupeKey: `bridge-back:${prev.since.toISOString()}`, text: classify.bridgeBackText({ since: prev.since, now, timeZone: HOUSEHOLD_TZ() }), facts: { kind: "bridge_back", since: prev.since } });
					told = { kind: "bridge_back", ...r };
					next.recoveryPending = r.written === 0 && profileIds.length > 0;
				}
				next.since = null;
				next.reportedSince = null;
			}
			next.state = "ready";
			next.lastOkAt = now;
		} else {
			if (prev.state === "ready" || prev.state === "unknown" || !prev.since) next.since = now;
			if (!episodeOpen && next.since && now.getTime() - next.since.getTime() >= BRIDGE_REPORT_AFTER_MS && !prev.reportedSince) {
				const r = await tell(profileIds, { dedupeKey: `bridge:${next.since.toISOString()}`, text: classify.bridgeNote({ state, since: next.since, lastOkAt: next.lastOkAt, timeZone: HOUSEHOLD_TZ() }), facts: { kind: "bridge_down", state, since: next.since } });
				told = { kind: "bridge_down", ...r };
				if (r.written > 0) {
					next.reportedSince = next.since;
					next.recoveryPending = true;
				} else errors.push({ source: "bridge_report", error: profileIds.length ? "no nudge could be written" : "no recipients" });
			}
		}
		await store.saveBridgeHealth(next);
		return { state: next.state, since: next.since, told };
	}

	// -- investigating ------------------------------------------------------------

	async function investigate({ profileIds, now, phase = "report", since = null }) {
		const places = await deps.places(profileIds).catch(() => []);
		const home = places.find((p) => p.kind === "home") || places[0] || null;
		const [calls, nws, cause] = await Promise.all([
			evidence.recentCalls({ store, profileIds, now }),
			evidence.nwsAlerts({ nws: deps.nws, places }),
			evidence.searchCause({ llm: deps.llm(), town: evidence.townOf(home?.address), now, phase, since }),
		]);
		const widespread = cause.status === "found" && cause.scope === "widespread";
		return {
			calls,
			nws,
			cause,
			locality: widespread ? "widespread" : "unknown",
			record: [
				{ source: "911_calls", ok: !calls.error, window_minutes: 30, recent: calls.calls.length, plausible: calls.plausible.length, error: calls.error, note: "Only calls the phone's PulsePoint notifications passed on, and only those near a watched place; an empty list is not proof of anything." },
				{ source: "nws_alerts", ok: !nws.error, active: nws.alerts.map((a) => a.event), error: nws.error },
				{ source: "cause_search", ok: cause.status !== "failed", status: cause.status, scope: cause.scope, sources: cause.sources, error: cause.error || null, raw: cause.raw || null },
				{ source: "x_twitter", ok: false, note: "Not read: no free API, and scraping is not done." },
				{ source: "duke_energy_outage_map", ok: false, note: "Not read: no sanctioned public API; see docs/capabilities/outage-watch.md." },
			],
		};
	}

	// -- the episode ----------------------------------------------------------------

	async function openNew({ cls, snapshot, profileIds, now, reason, errors }) {
		const openedAt = new Date(Math.min(...cls.items.map((i) => (i.at ? new Date(i.at).getTime() : now.getTime()))));
		const { episode, created } = await store.createEpisode({ uuid: randomUUID(), openedAt, signals: cls.items });
		if (!episode) throw new Error("could not open an episode");
		if (!created && episode.state !== "open") return { episode, verdict: "ongoing" };
		return reportEpisode({ episode, cls, snapshot, profileIds, now, errors });
	}

	/** Investigate and tell. An episode whose report didn't reach anyone stays 'open' and is tried again next pass. */
	async function reportEpisode({ episode, cls, snapshot, profileIds, now, errors }) {
		const found = await investigate({ profileIds, now });
		const items = cls.items.length ? cls.items : episode.signals || [];
		const text = classify.reportText({ items, openedAt: episode.opened_at, evidence: found, timeZone: HOUSEHOLD_TZ() });
		const checked = [...snapshot.checked, ...found.record];
		const told = await tell(profileIds, { dedupeKey: `outage:${episode.uuid}`, text, facts: { episode: episode.uuid, kind: "outage", items } });
		const fields = { checked, locality: found.locality, cause_status: found.cause.status, cause_text: found.cause.text, cause_sources: found.cause.sources };
		if (told.written > 0) {
			Object.assign(fields, { state: "reported", reported_at: now, nudge_uuid: told.results.find((r) => r.uuid)?.uuid || null });
		} else errors.push({ source: "report", error: profileIds.length ? "no nudge could be written" : "no recipients configured (EUFY_AUTHORIZED_PROFILE_IDS)" });
		await store.updateEpisode(episode.id, fields);
		return { episode, verdict: "suspected", text, told };
	}

	async function resolveEpisode({ episode, cls, snapshot, profileIds, now, errors }) {
		const items = episode.signals || [];
		const stillDark = cls.nowDark.map((d) => d.label);
		const names = items.filter((i) => i.source === "nest").map((i) => i.name);
		const back = [...(await store.nestOnlineSince(names)).values()].filter(Boolean).map((d) => d.getTime());
		const exact = back.length > 0 && !stillDark.length;
		const recoveredAt = exact ? new Date(Math.max(...back)) : now;
		// One more look for the cause now that it's over — utilities usually say after restoration.
		const found = await investigate({ profileIds, now, phase: "recovery", since: new Date(episode.opened_at).toISOString() });
		const cause = found.cause.status === "found" ? found.cause : episode.cause_status === "found" ? { status: "found", text: episode.cause_text } : found.cause;
		const text = classify.recoveryText({ items, stillDark, recoveredAt, exact, timeZone: HOUSEHOLD_TZ(), cause });
		const told = await tell(profileIds, { dedupeKey: `outage-back:${episode.uuid}`, text, facts: { episode: episode.uuid, kind: "outage_over", stillDark } });
		const checked = [...(episode.checked || []), { phase: "recovery", at: now.toISOString(), checks: [...snapshot.checked, ...found.record] }];
		if (told.written === 0) errors.push({ source: "recovery_report", error: profileIds.length ? "no nudge could be written" : "no recipients configured" });
		await store.updateEpisode(
			episode.id,
			{ state: "closed", checked, recovered_at: recoveredAt, recovery_cause_text: cause.text || null, recovery_nudge_uuid: told.results.find((r) => r.uuid)?.uuid || null, recovery_reported_at: told.written > 0 ? now : null, closed_at: now },
			{ close: true }
		);
		return { episode, verdict: "recovered", text, told };
	}

	// -- the assessment -----------------------------------------------------------------

	/**
	 * One pass. Records a row in athena_outage_assessment whatever happens:
	 * quiet, suspected, ongoing, recovered, or check_failed (nothing could be read).
	 */
	async function run({ reason = "backstop", now = deps.now() } = {}) {
		const errors = [];
		const profileIds = deps.recipients();
		const snapshot = await gather(profileIds, now, errors);
		const cls = classify.classify({ now, nest: snapshot.nest, bridge: snapshot.bridge });
		let outcome = { verdict: "quiet", episode: null };
		let bridge = null;
		try {
			const open = await store.openEpisode();
			if (snapshot.nest === null && snapshot.bridge === null) {
				outcome = { verdict: "check_failed", episode: open };
			} else if (!open) {
				if (cls.suspected) outcome = await openNew({ cls, snapshot, profileIds, now, reason, errors });
			} else if (now.getTime() - new Date(open.opened_at).getTime() > EPISODE_MAX_MS) {
				await store.updateEpisode(open.id, { state: "closed", closed_at: now, recovery_cause_text: "closed after three days without recovering" }, { close: true });
				outcome = { verdict: "ongoing", episode: open };
			} else if (cls.nowDark.length < 2 && snapshot.nest !== null && open.state === "open") {
				// Never reported (the report didn't reach anyone) and it's over: nothing to say.
				await store.updateEpisode(open.id, { state: "closed", recovered_at: now, closed_at: now }, { close: true });
				outcome = { verdict: "recovered", episode: open };
			} else if (cls.nowDark.length < 2 && snapshot.nest !== null) {
				outcome = await resolveEpisode({ episode: open, cls, snapshot, profileIds, now, errors });
			} else if (open.state === "open") {
				outcome = await reportEpisode({ episode: open, cls, snapshot, profileIds, now, errors });
			} else outcome = { verdict: "ongoing", episode: open };
		} catch (err) {
			errors.push({ source: "assessment", error: message(err) });
			outcome = { verdict: "check_failed", episode: outcome.episode };
		}
		try {
			bridge = await trackBridge({ health: snapshot.health, now, profileIds, episodeOpen: Boolean(await store.openEpisode()), errors });
		} catch (err) {
			errors.push({ source: "camera_bridge_tracking", error: message(err) });
		}
		await store
			.addAssessment({ at: now, reason, verdict: outcome.verdict, episodeId: outcome.episode?.id || null, signals: { dark: cls.nowDark, suspected: cls.suspected, checked: snapshot.checked }, errors })
			.catch((err) => console.warn("[outage] assessment not recorded:", err.message));
		await store.pruneAssessments().catch(() => undefined);
		return { verdict: outcome.verdict, text: outcome.text || null, bridge, errors };
	}

	// -- scheduling -----------------------------------------------------------------------

	/** Round up to the next five-minute mark so a burst of transitions books one task, not one each. */
	const bucket = (ms) => new Date(Math.ceil(ms / BUCKET_MS) * BUCKET_MS);

	/**
	 * Called by the Nest webhook after it stored an event. A device going
	 * offline books the delayed assessment; one coming back books a recovery
	 * look (only while an episode is open). Never throws, never blocks the webhook.
	 */
	async function noteNestEvent({ wentOffline = [], wentOnline = [], now = deps.now() } = {}) {
		try {
			if (wentOffline.length) {
				return { booked: await deps.wake(bucket(now.getTime() + CHECK_DELAY_MS), { name: "outage", reason: "outage:nest_offline" }) };
			}
			if (wentOnline.length && (await store.openEpisode())) {
				return { booked: await deps.wake(bucket(now.getTime() + 60_000), { name: "outage", reason: "outage:nest_online" }) };
			}
		} catch (err) {
			console.warn("[outage] could not book a check (the hourly job is the backstop):", err.message);
		}
		return { booked: false };
	}

	/**
	 * For the hourly athena-incidents job (DB only, no bridge access): a reason
	 * string when the service should be asked to run an assessment, else null.
	 * An open episode is looked at every 15 minutes; otherwise once an hour.
	 * That is the existing job's rhythm used as a backstop, not a new poller.
	 */
	async function backstopDue({ now = deps.now() } = {}) {
		const [last, open] = await Promise.all([store.lastAssessmentAt(), store.openEpisode()]);
		const idle = last ? now.getTime() - last.getTime() : Infinity;
		if (open && idle >= BACKSTOP_OPEN_MS) return "outage backstop (episode open)";
		if (idle >= BACKSTOP_IDLE_MS) return "outage backstop";
		return null;
	}

	return { run, noteNestEvent, backstopDue };
}

const defaultOutage = createOutage();

module.exports = { ...defaultOutage, createOutage, CHECK_DELAY_MS, BRIDGE_REPORT_AFTER_MS };
