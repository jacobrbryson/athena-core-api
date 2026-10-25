/**
 * Trading push notifications: an outbox derived from the persisted signal
 * event log (docs/architecture/trading.md, "Notifications").
 *
 *   sync()      stored events / risk alerts → outbox rows (deduplicated)
 *   deliver()   claim due rows → gates → re-validate → push → record outcome
 *   process()   expire due signals, sync, deliver — what every caller runs
 *
 * Three rules hold everywhere:
 *
 * 1. A row exists only because a stored event does. Figures are copied from
 *    the event's sizing, never from a model and never estimated. The dedupe
 *    key (`confirm:<signal id>` etc.) makes a second derivation — a restart,
 *    a dashboard poll racing the monitor tick — a no-op.
 * 2. Nothing actionable is sent without re-checking it at send time against
 *    the current evaluation, the account's limits and the clock
 *    (lifecycle.revalidate). A setup that no longer holds is recorded as
 *    'lapsed' with the reason — never sent, never silently dropped.
 * 3. Only a validated strategy, switched on for live alerts by the person,
 *    on full-market (SIP) data, sends a LIVE confirmation. Everything else is
 *    labelled PAPER / EXPERIMENTAL on the lock screen.
 *
 * Holding is not dropping. Quiet hours and the person's own cooldown hold a
 * row to a later time and re-check it then; a cooldown never applies to a
 * live confirmation, an invalidation, an expiry or a risk limit.
 *
 * Nothing here places, changes or cancels an order.
 */

const crypto = require("node:crypto");
const pool = require("../../helpers/db");
const push = require("../push");
const store = require("./store");
const clock = require("./marketClock");
const lifecycle = require("./lifecycle");
const strategy = require("./strategy");

const MINUTE = 60_000;
const MAX_ATTEMPTS = 3;
const STUCK_MS = 3 * MINUTE;
const QUIET_RECHECK_MS = 15 * MINUTE;
const COOLDOWN_MAX_MIN = 120;
const LOW = new Set(["low"]);

const iso = (d) => (d ? new Date(d).toISOString() : null);
const json = (x) => (x === null || x === undefined ? null : typeof x === "string" ? JSON.parse(x) : x);
const bool = (x) => x === 1 || x === true;

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

const DEFAULT_PREFS = Object.freeze({
	enabled: false, setup_forming: true, entry_confirmed: true, invalidation: true, paper: true, risk_limit: true,
	sound: "default", cooldown_min: 0, live_strategies: [],
});

/** No row means nothing is pushed. */
async function getPrefs(profileId) {
	const [[r]] = await pool.query("SELECT * FROM trading_notification_prefs WHERE profile_id = ?", [profileId]);
	if (!r) return { ...DEFAULT_PREFS, live_strategies: [] };
	return {
		enabled: bool(r.enabled), setup_forming: bool(r.setup_forming), entry_confirmed: bool(r.entry_confirmed), invalidation: bool(r.invalidation),
		paper: bool(r.paper), risk_limit: bool(r.risk_limit), sound: r.sound === "silent" ? "silent" : "default", cooldown_min: Number(r.cooldown_min) || 0,
		live_strategies: (json(r.live_strategies) || []).filter((k) => typeof k === "string"),
	};
}

const SWITCHES = ["enabled", "setup_forming", "entry_confirmed", "invalidation", "paper", "risk_limit"];

/**
 * Save the person's own preferences. Returns { prefs } or { error }.
 * `live_strategy` (boolean) switches live alerts for the current strategy;
 * it can only be turned on for a validated version, so a paper strategy can
 * never be talked into sending live alerts.
 */
async function setPrefs(profileId, patch = {}, { versionStatus = null } = {}) {
	const next = { ...(await getPrefs(profileId)) };
	for (const k of SWITCHES) if (typeof patch[k] === "boolean") next[k] = patch[k];
	if (patch.sound !== undefined) {
		if (!["default", "silent"].includes(patch.sound)) return { error: "Sound is 'default' or 'silent'." };
		next.sound = patch.sound;
	}
	if (patch.cooldown_min !== undefined) {
		const n = Number(patch.cooldown_min);
		if (!Number.isInteger(n) || n < 0 || n > COOLDOWN_MAX_MIN) return { error: `Cooldown is 0–${COOLDOWN_MAX_MIN} minutes.` };
		next.cooldown_min = n;
	}
	if (typeof patch.live_strategy === "boolean") {
		const key = strategy.STRATEGY_KEY;
		if (patch.live_strategy && versionStatus !== "validated") return { error: "Live alerts need a validated strategy version. Until then alerts are paper." };
		next.live_strategies = patch.live_strategy ? [...new Set([...next.live_strategies, key])] : next.live_strategies.filter((k) => k !== key);
	}
	await pool.query(
		`INSERT INTO trading_notification_prefs (profile_id, enabled, setup_forming, entry_confirmed, invalidation, paper, risk_limit, sound, cooldown_min, live_strategies)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), setup_forming = VALUES(setup_forming), entry_confirmed = VALUES(entry_confirmed),
		   invalidation = VALUES(invalidation), paper = VALUES(paper), risk_limit = VALUES(risk_limit), sound = VALUES(sound),
		   cooldown_min = VALUES(cooldown_min), live_strategies = VALUES(live_strategies)`,
		[profileId, ...SWITCHES.map((k) => (next[k] ? 1 : 0)), next.sound, next.cooldown_min, JSON.stringify(next.live_strategies)]);
	return { prefs: next };
}

/** Everyone who has trading notifications switched on — the monitor's list. */
async function enabledProfiles() {
	const [rows] = await pool.query("SELECT profile_id FROM trading_notification_prefs WHERE enabled = 1");
	return rows.map((r) => Number(r.profile_id));
}

const EVENT_SWITCH = { SETUP_FORMING: "setup_forming", ENTRY_CONFIRMED: "entry_confirmed", SETUP_INVALIDATED: "invalidation", SETUP_EXPIRED: "invalidation", RISK_LIMIT_REACHED: "risk_limit" };

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

async function insert(profileId, row) {
	const uuid = crypto.randomUUID();
	const n = { uuid, payload: row.payload, event: row.event, mode: row.mode };
	const [res] = await pool.query(
		`INSERT IGNORE INTO trading_notifications (uuid, profile_id, signal_id, source_seq, source_alert_id, event, mode, priority, dedupe_key, symbol, payload_json, deep_link, state, state_reason, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[uuid, profileId, row.signal_id || null, row.source_seq || null, row.source_alert_id || null, row.event, row.mode, row.priority, row.dedupe_key.slice(0, 160),
			row.payload?.symbol || null, JSON.stringify(row.payload || {}), lifecycle.deepLink(n), row.skip ? "skipped" : "pending", row.skip || null, row.expires_at || null]);
	return res.affectedRows > 0;
}

/**
 * Derive outbox rows for today from stored events and daily-risk alerts.
 * A forming or confirmed notification comes only from a signal's LATEST
 * event, so switching notifications on mid-day doesn't replay the morning.
 */
async function sync(profileId, { date = clock.etParts().date, prefs } = {}) {
	prefs = prefs || (await getPrefs(profileId));
	if (!prefs.enabled) return { created: 0 };
	const signals = await store.signalsWithEventsForDay(profileId, date);
	const [existing] = signals.length
		? await pool.query("SELECT signal_id, event, state FROM trading_notifications WHERE profile_id = ? AND signal_id IN (?)", [profileId, signals.map((s) => s.id)])
		: [[]];
	let created = 0;
	for (const s of signals) {
		const prior = new Map(existing.filter((r) => Number(r.signal_id) === Number(s.id)).map((r) => [r.event, r.state]));
		const feedCanConfirm = strategy.DEFAULT_PARAMS.confirmFeeds.includes(s.feed);
		s.events.forEach((e, i) => {
			e.from_key = i > 0 && lifecycle.isPaperSetup({ status: s.events[i - 1].to_status, conditions: s.events[i - 1].conditions, sizing: s.events[i - 1].sizing, indicators: s.events[i - 1].indicators }) ? "WAIT_PAPER_SETUP" : e.from_status;
		});
		const last = s.events.length - 1;
		for (let i = 0; i <= last; i++) {
			const e = s.events[i];
			for (const c of lifecycle.candidatesFromEvent(e, s, prior)) {
				if ((c.event === "SETUP_FORMING" || c.event === "ENTRY_CONFIRMED") && i !== last) continue;
				if (!prefs[EVENT_SWITCH[c.event]]) continue;
				const live = !c.paper_only && lifecycle.liveEligibility({ feedCanConfirm, versionStatus: s.version_status, prefs }).live;
				const mode = live ? "live" : "paper";
				// Live confirmations are high priority; a paper one is as low as a forming alert.
				const priority = c.event === "ENTRY_CONFIRMED" && !live ? "low" : c.priority;
				if (c.event === "ENTRY_CONFIRMED" && mode === "paper" && !prefs.paper) continue;
				if (await insert(profileId, { ...c, mode, priority, signal_id: s.id, source_seq: e.seq })) {
					created += 1;
					prior.set(c.event, c.skip ? "skipped" : "pending");
				}
			}
		}
	}
	if (prefs.risk_limit) {
		const [alerts] = await pool.query(
			"SELECT id, dedupe_key, title, body, created_at FROM trading_alerts WHERE profile_id = ? AND kind IN ('daily_risk','trade_limit') AND dedupe_key LIKE ?",
			[profileId, `risk:${date}:%`]);
		for (const a of alerts) {
			const c = lifecycle.candidateFromRiskAlert({ ...a, created_at: iso(a.created_at) });
			if (c && (await insert(profileId, { ...c, mode: "live", source_alert_id: a.id }))) created += 1;
		}
	}
	return { created };
}

function shapeRow(r) {
	return {
		id: r.id, uuid: r.uuid, signal_id: r.signal_id, event: r.event, mode: r.mode, priority: r.priority, symbol: r.symbol, payload: json(r.payload_json) || {},
		title: r.title, body: r.body, deep_link: r.deep_link, state: r.state, state_reason: r.state_reason, not_before: iso(r.not_before), expires_at: iso(r.expires_at),
		attempts: Number(r.attempts) || 0, created_at: iso(r.created_at), sent_at: iso(r.sent_at), acknowledged_at: iso(r.acknowledged_at), acknowledged_via: r.acknowledged_via || null,
	};
}

async function finish(id, claim, state, reason, extra = {}) {
	const sets = ["state = ?", "state_reason = ?", "claim_id = NULL", "claimed_at = NULL"];
	const args = [state, reason ? String(reason).slice(0, 300) : null];
	for (const [k, v] of Object.entries(extra)) {
		sets.push(`${k} = ?`);
		args.push(v);
	}
	await pool.query(`UPDATE trading_notifications SET ${sets.join(", ")} WHERE id = ? AND claim_id = ?`, [...args, id, claim]);
}

/** Claim one row for sending. Returns the claim id, or null if another worker has it. */
async function claim(id, now) {
	const claimId = crypto.randomUUID();
	const [res] = await pool.query(
		`UPDATE trading_notifications SET state = 'sending', claim_id = ?, claimed_at = ?, attempts = attempts + 1
		 WHERE id = ? AND state IN ('pending','held') AND (not_before IS NULL OR not_before <= ?)`,
		[claimId, new Date(now), id, new Date(now)]);
	return res.affectedRows ? claimId : null;
}

/**
 * Send what's due for one person. `dashboard` is a fresh engine payload when
 * the caller has one; otherwise one is fetched (throttled) for re-validation.
 */
async function deliver(profileId, { now = Date.now(), dashboard = null, prefs = null } = {}) {
	// A worker that died mid-send leaves its row 'sending'; put it back. The
	// collapse key is the row's own, so a resend replaces rather than stacks.
	await pool.query("UPDATE trading_notifications SET state = 'pending', claim_id = NULL WHERE profile_id = ? AND state = 'sending' AND claimed_at < ?", [profileId, new Date(now - STUCK_MS)]);
	const [rows] = await pool.query(
		`SELECT * FROM trading_notifications WHERE profile_id = ? AND state IN ('pending','held') AND (not_before IS NULL OR not_before <= ?)
		 ORDER BY FIELD(priority, 'high', 'normal', 'low'), created_at LIMIT 20`, [profileId, new Date(now)]);
	if (!rows.length) return { sent: 0, lapsed: 0, held: 0, failed: 0 };
	prefs = prefs || (await getPrefs(profileId));
	const out = { sent: 0, lapsed: 0, held: 0, failed: 0, skipped: 0 };
	let quiet = null;
	let muted = null;
	for (const raw of rows) {
		const n = shapeRow(raw);
		const claimId = await claim(n.id, now);
		if (!claimId) continue;
		try {
			const verdict = await decide(profileId, n, { now, prefs, dashboard, quiet, muted });
			({ quiet, muted, dashboard } = verdict.cache);
			if (verdict.hold) {
				await finish(n.id, claimId, "held", verdict.hold.reason, { not_before: new Date(verdict.hold.until), attempts: n.attempts });
				out.held += 1;
				continue;
			}
			if (verdict.end) {
				await finish(n.id, claimId, verdict.end.state, verdict.end.reason);
				out[verdict.end.state === "lapsed" ? "lapsed" : "skipped"] += 1;
				continue;
			}
			const sent = await send(profileId, { ...n, mode: verdict.mode }, { prefs, now, ledgerOnly: verdict.ledgerOnly, paperBecause: verdict.paperBecause, attempt: n.attempts + 1 });
			if (sent.ok) {
				await finish(n.id, claimId, "sent", verdict.note || null, { sent_at: new Date(now), title: sent.title, body: sent.body, mode: verdict.mode });
				out.sent += 1;
			} else if (sent.retry && n.attempts + 1 < MAX_ATTEMPTS && !(n.expires_at && now + 30_000 * 2 ** n.attempts >= Date.parse(n.expires_at))) {
				await finish(n.id, claimId, "pending", sent.reason, { not_before: new Date(now + 30_000 * 2 ** n.attempts), title: sent.title, body: sent.body });
				out.failed += 1;
			} else {
				await finish(n.id, claimId, "failed", sent.reason, { title: sent.title, body: sent.body });
				out.failed += 1;
			}
		} catch (err) {
			console.warn("[trading] notification failed", { id: n.id, message: err?.message });
			await finish(n.id, claimId, "pending", `error: ${err?.message}`, { not_before: new Date(now + MINUTE) }).catch(() => {});
			out.failed += 1;
		}
	}
	return out;
}

/** Every gate between a stored row and a push, in order. */
async function decide(profileId, n, { now, prefs, dashboard, quiet, muted }) {
	const cache = { quiet, muted, dashboard };
	const end = (state, reason) => ({ end: { state, reason }, cache });
	if (n.event === "TEST") return { mode: "live", cache };
	if (!prefs.enabled) return end("skipped", "Trading notifications were switched off.");
	if (prefs[EVENT_SWITCH[n.event]] === false) return end("skipped", "That kind of notification was switched off.");
	const initiative = require("../initiative");
	if (cache.muted === null) cache.muted = await initiative.listMutes(profileId).catch(() => []);
	if (cache.muted.includes("trading")) return end("skipped", "You muted trading notifications.");
	if (n.expires_at && now >= Date.parse(n.expires_at)) return end("lapsed", `Expired at ${clock.etClock(n.expires_at)} ET before it could be sent.`);

	const ph = clock.phase(now);
	const actionable = n.event === "ENTRY_CONFIRMED" || n.event === "SETUP_FORMING";
	if (actionable && ph.phase !== "open") return end("lapsed", `The market is ${ph.phase}; a setup outside trading hours isn't sent.`);

	if (cache.quiet === null) {
		const pref = await initiative.getPref(profileId).catch(() => null);
		cache.quiet = pref ? initiative.inQuietHours(pref, new Date(now)) : false;
	}
	if (cache.quiet) return { hold: { until: now + QUIET_RECHECK_MS, reason: "Held for your quiet hours; re-checked when they end." }, cache };

	// Re-validate against the market as it is now.
	let verdict = { mode: n.mode, cache };
	if (actionable) {
		if (!cache.dashboard) cache.dashboard = await require("./engine").evaluate(profileId);
		const row = (cache.dashboard.watchlist || []).find((w) => w.symbol === n.symbol) || null;
		const signal = n.payload.signal_uuid ? await store.signalByUuid(profileId, n.payload.signal_uuid) : null;
		if (n.event === "SETUP_FORMING") {
			if (row?.signal?.status !== "SETUP_FORMING" || signal?.status !== "SETUP_FORMING") return end("lapsed", `No longer forming: ${row?.signal?.reason || signal?.status || "not on the watchlist"}.`);
			verdict.mode = lifecycle.liveEligibility({ feedCanConfirm: !!cache.dashboard.data?.can_confirm, versionStatus: cache.dashboard.strategy?.status, prefs }).live ? "live" : "paper";
		} else {
			const check = lifecycle.revalidate({ notification: n, signal, evaluation: row?.signal || null, dashboard: cache.dashboard, prefs, now });
			if (!check.actionable) return end("lapsed", `Re-checked before sending: ${check.blocking.join(" ")}`);
			verdict = { mode: check.mode, ledgerOnly: check.ledger_only, paperBecause: check.paper_because, cache };
			if (n.mode === "live" && check.mode === "paper") verdict.note = "Sent as paper: it no longer qualified as live when re-checked.";
		}
		if (verdict.mode === "paper" && n.event === "ENTRY_CONFIRMED" && !prefs.paper) return end("skipped", "Paper alerts are switched off.");
	}

	// The person's own cooldown: low-priority only, and it holds rather than drops.
	if (LOW.has(n.priority) && prefs.cooldown_min > 0) {
		const [[last]] = await pool.query(
			"SELECT MAX(sent_at) AS at FROM trading_notifications WHERE profile_id = ? AND priority = 'low' AND state = 'sent' AND id <> ?", [profileId, n.id]);
		const until = last?.at ? Date.parse(iso(last.at)) + prefs.cooldown_min * MINUTE : 0;
		if (until > now) return { hold: { until, reason: `Held for your ${prefs.cooldown_min}-minute cooldown; re-checked at ${clock.etClock(until)} ET.` }, cache };
	}
	return verdict;
}

/** Render and push one row; record every device's answer. */
async function send(profileId, n, { prefs, now, ledgerOnly = false, paperBecause = [], attempt }) {
	const { title, body } = lifecycle.render(n, { ledgerOnly, paperBecause });
	const windowEnd = n.expires_at ? Date.parse(n.expires_at) : null;
	const result = await push.sendToProfile(profileId, {
		title, body,
		data: { kind: "trading", uuid: n.uuid, event: n.event, url: n.deep_link || lifecycle.deepLink(n), silent: prefs.sound === "silent" ? "1" : "0" },
		// Per notification: a resend of this one replaces it, two different ones stack.
		collapseKey: `trading-${n.uuid}`,
		// A confirmation isn't worth delivering after its window; the push
		// service drops it rather than lighting up a phone with a stale plan.
		ttlSeconds: windowEnd ? Math.max(30, Math.floor((windowEnd - now) / 1000)) : 3600,
	}).catch((err) => ({ sent: 0, failed: 1, devices: 0, results: [], skipped: err.message }));
	for (const r of result.results || []) {
		await pool.query(
			"INSERT INTO trading_notification_deliveries (notification_id, attempt, device_uuid, device_name, platform, ok, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[n.id, attempt, r.uuid || null, r.name ? String(r.name).slice(0, 80) : null, r.platform || null, r.ok ? 1 : 0, r.reason ? String(r.reason).slice(0, 160) : null]);
	}
	if (result.sent > 0) return { ok: true, title, body };
	if (result.skipped) {
		const why = result.skipped === "not enabled" ? "Push notifications are off in Athena's notification settings." : result.skipped === "no registered device" ? "No phone or browser is subscribed." : result.skipped;
		await pool.query("INSERT INTO trading_notification_deliveries (notification_id, attempt, ok, reason) VALUES (?, ?, 0, ?)", [n.id, attempt, String(why).slice(0, 160)]);
		return { ok: false, retry: false, reason: why, title, body };
	}
	const reasons = (result.results || []).filter((r) => !r.ok).map((r) => `${r.name || "device"}: ${r.reason}`);
	return { ok: false, retry: true, reason: reasons.join("; ") || "Every device refused it.", title, body };
}

/**
 * Expire, derive and deliver for one person. Never throws; every caller
 * (dashboard poll, monitor tick) runs the same thing.
 */
async function process(profileId, { now = Date.now(), dashboard = null } = {}) {
	try {
		await store.expireDue(profileId, now);
		const prefs = await getPrefs(profileId);
		const synced = await sync(profileId, { date: clock.etParts(new Date(now)).date, prefs });
		const delivered = await deliver(profileId, { now, dashboard, prefs });
		return { ...synced, ...delivered };
	} catch (err) {
		if (err?.code !== "ER_NO_SUCH_TABLE") console.warn("[trading] notifications pass failed", { profileId, message: err?.message });
		return { error: err?.message };
	}
}

// ---------------------------------------------------------------------------
// Person-facing
// ---------------------------------------------------------------------------

/** Recent notifications with each delivery attempt. */
async function history(profileId, { limit = 50 } = {}) {
	const [rows] = await pool.query("SELECT * FROM trading_notifications WHERE profile_id = ? ORDER BY created_at DESC, id DESC LIMIT ?", [profileId, limit]);
	if (!rows.length) return [];
	const [deliveries] = await pool.query(
		"SELECT notification_id, attempt, device_name, platform, ok, reason, attempted_at FROM trading_notification_deliveries WHERE notification_id IN (?) ORDER BY id", [rows.map((r) => r.id)]);
	return rows.map((r) => ({
		...shapeRow(r),
		deliveries: deliveries.filter((d) => Number(d.notification_id) === Number(r.id)).map((d) => ({ attempt: d.attempt, device: d.device_name, platform: d.platform, ok: bool(d.ok), reason: d.reason, at: iso(d.attempted_at) })),
	}));
}

async function byUuid(profileId, uuid) {
	const [[r]] = await pool.query("SELECT * FROM trading_notifications WHERE profile_id = ? AND uuid = ?", [profileId, uuid]);
	return r ? shapeRow(r) : null;
}

/** The person opened or acknowledged it. First acknowledgement wins. */
async function acknowledge(profileId, uuid, via = "open") {
	const [res] = await pool.query(
		"UPDATE trading_notifications SET acknowledged_at = UTC_TIMESTAMP(3), acknowledged_via = ? WHERE profile_id = ? AND uuid = ? AND acknowledged_at IS NULL",
		[["open", "dismiss", "button"].includes(via) ? via : "open", profileId, uuid]);
	return res.affectedRows > 0;
}

/** A test the person asked for: recorded like any other, sent at once, no market gates. */
async function sendTest(profileId) {
	const key = `test:${Date.now()}`;
	await insert(profileId, { event: "TEST", mode: "live", priority: "high", dedupe_key: key, payload: { reason: "Test" } });
	const [[r]] = await pool.query("SELECT * FROM trading_notifications WHERE profile_id = ? AND dedupe_key = ?", [profileId, key]);
	const n = shapeRow(r);
	const claimId = await claim(n.id, Date.now());
	const sent = await send(profileId, n, { prefs: await getPrefs(profileId), now: Date.now(), attempt: 1 });
	await finish(n.id, claimId, sent.ok ? "sent" : "failed", sent.ok ? null : sent.reason, { title: sent.title, body: sent.body, ...(sent.ok ? { sent_at: new Date() } : {}) });
	return { ...(await history(profileId, { limit: 1 }))[0], ok: sent.ok, reason: sent.ok ? null : sent.reason };
}

/**
 * Where a tapped notification lands: the setup re-checked against the market
 * now, with a fresh evaluation. The notification's figures are shown as what
 * was notified at its time; `check.actionable` is the only thing that says
 * whether it still stands. Returns null for someone else's (or no) signal.
 */
async function recheckSetup(profileId, signalUuid, { notificationUuid = null, now = Date.now() } = {}) {
	const s = await store.signalWithEvents(profileId, signalUuid);
	if (!s) return null;
	const notification = notificationUuid ? await byUuid(profileId, notificationUuid) : null;
	if (notification) await acknowledge(profileId, notification.uuid, "open");
	const dashboard = await require("./engine").evaluate(profileId, { force: true });
	const signal = await store.signalByUuid(profileId, signalUuid);
	const row = (dashboard.watchlist || []).find((w) => w.symbol === s.symbol) || null;
	// The plan to re-check: the notification's own figures, else the setup's
	// latest confirming (or paper-setup) event.
	let payload = notification?.event === "ENTRY_CONFIRMED" ? notification.payload : null;
	if (!payload) {
		const e = [...s.events].reverse().find((x) => x.to_status === "ENTRY_CONFIRMED" || lifecycle.isPaperSetup({ status: x.to_status, conditions: x.conditions, sizing: x.sizing, indicators: x.indicators }));
		const plan = e ? lifecycle.planFrom(e.sizing) : null;
		if (plan) payload = { ...plan, session_date: s.session_date, signal_at: e.evaluated_at, expires_at: (e.to_status === "ENTRY_CONFIRMED" ? lifecycle.expiryFor({ sessionDate: s.session_date, status: "ENTRY_CONFIRMED", confirmedAt: s.confirmed_at || e.evaluated_at }) : new Date(Date.parse(e.evaluated_at) + lifecycle.ENTRY_WINDOW_MIN * MINUTE)).toISOString() };
	}
	const prefs = await getPrefs(profileId);
	const check = payload
		? lifecycle.revalidate({ notification: { payload }, signal, evaluation: row?.signal || null, dashboard, prefs, now })
		: { actionable: false, mode: "paper", checks: [], blocking: ["This setup never confirmed, so there is no plan to act on."], paper_because: [], ledger_only: false, checked_at: new Date(now).toISOString() };
	return { signal: { ...s, expires_at: signal?.expires_at || null, expiry_policy: signal?.expiry_policy || null, events: undefined }, notification, plan: payload, check, current: row?.signal || null, market: dashboard.market };
}

/** What the Notifications section shows: prefs, devices, transports, monitoring. */
async function status(profileId) {
	const [prefs, pushStatus] = await Promise.all([getPrefs(profileId), push.statusFor(profileId).catch(() => null)]);
	return { prefs, push: pushStatus, monitor: require("./monitor").info(), cooldown_max_min: COOLDOWN_MAX_MIN, entry_window_min: lifecycle.ENTRY_WINDOW_MIN };
}

module.exports = { DEFAULT_PREFS, getPrefs, setPrefs, enabledProfiles, sync, deliver, process, history, byUuid, acknowledge, sendTest, recheckSetup, status, _decide: decide };
