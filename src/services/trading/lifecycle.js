/**
 * A setup's lifecycle beyond what strategy.evaluate() classifies, and the
 * rules that turn persisted transitions into notifications. Pure.
 *
 *   WATCH → SETUP_FORMING → ENTRY_CONFIRMED → EXIT_INVALIDATED | EXPIRED
 *
 * evaluate() decides the first three and EXIT_INVALIDATED from the candles.
 * EXPIRED is time: a confirmed entry is actionable for ENTRY_WINDOW_MIN after
 * it confirms, and nothing is actionable after the day's entry cutoff. Both
 * are terminal, and each signal row records the policy that set its expiry.
 *
 * Nothing here reads a model. Every figure a notification carries is copied
 * from a stored signal event; revalidate() decides whether that event may
 * still be presented as actionable, and says why not when it may not.
 */

const { STATUS, ENTRY_CONDITIONS, DEFAULT_PARAMS, STRATEGY_KEY } = require("./strategy");
const clock = require("./marketClock");

const MINUTE = 60_000;
/** How long a confirmed entry stays actionable. */
const ENTRY_WINDOW_MIN = 10;
/** An evaluation older than this can't vouch for a setup. */
const MAX_EVALUATION_AGE_MS = 90_000;
/** Never present a plan below this reward/risk, whatever the account says. */
const MIN_REWARD_RISK = 2;
const TERMINAL = new Set([STATUS.EXIT_INVALIDATED, STATUS.EXPIRED]);
const SETUP_LABEL = { orb_vwap: "Opening-range breakout + VWAP retest" };

const EXPIRY_POLICY = `confirmed entries ${ENTRY_WINDOW_MIN} min; all setups at the ${DEFAULT_PARAMS.noNewEntriesAfter} ET entry cutoff or the close`;

const num = (x) => (x === null || x === undefined || x === "" ? null : Number(x));
const money = (x) => (x === null || x === undefined ? "—" : `$${Number(x).toFixed(2)}`);
const round = (x, dp = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp);

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/** No new entries after this instant: the strategy's cutoff, or the close if earlier. */
function cutoffAt(sessionDate, params = DEFAULT_PARAMS) {
	const session = clock.sessionFor(sessionDate);
	const cutoff = clock.etToUtc(sessionDate, clock.hhmm(params.noNewEntriesAfter)).getTime();
	return session.close_at ? Math.min(cutoff, Date.parse(session.close_at)) : cutoff;
}

/** When a signal in `status` stops being actionable. */
function expiryFor({ sessionDate, status, confirmedAt = null, params = DEFAULT_PARAMS }) {
	const cutoff = cutoffAt(sessionDate, params);
	if (status === STATUS.ENTRY_CONFIRMED && confirmedAt) return new Date(Math.min(Date.parse(confirmedAt) + ENTRY_WINDOW_MIN * MINUTE, cutoff));
	return new Date(cutoff);
}

/** Should this signal be expired now? Terminal signals never are. */
function isExpired(signal, now) {
	if (!signal || TERMINAL.has(signal.status) || !signal.expires_at) return false;
	return now >= Date.parse(signal.expires_at);
}

/** The EXPIRED evaluation written to the event log (same shape evaluate() returns). */
function expiredResult(signal, now) {
	const why = signal.status === STATUS.ENTRY_CONFIRMED
		? `The ${ENTRY_WINDOW_MIN}-minute entry window after confirmation closed at ${clock.etClock(signal.expires_at)} ET.`
		: `No new entries after ${clock.etClock(signal.expires_at)} ET.`;
	return {
		symbol: signal.symbol, status: STATUS.EXPIRED, reason: why, next_step: "Not actionable. One setup per symbol per day.",
		evaluated_at: new Date(now).toISOString(), strategy: STRATEGY_KEY, conditions: [], indicators: {}, levels: {}, data: { expired_by: "lifecycle", policy: EXPIRY_POLICY }, sizing: null,
	};
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

/**
 * A WAIT where every entry condition passed except that the feed can't
 * confirm (IEX), on fresh data and outside any event blackout. It is the
 * nearest thing to a confirmation the IEX feed can produce, so it may be
 * pushed — but only ever as PAPER / EXPERIMENTAL.
 */
function isPaperSetup(r) {
	if (!r || r.status !== STATUS.WAIT || !r.sizing?.ok) return false;
	const data = r.data || r.indicators?.data;
	if (!data || data.stale || data.feed_can_confirm !== false || data.blackout) return false;
	const state = (id) => (r.conditions || []).find((c) => c.id === id)?.state;
	return ENTRY_CONDITIONS.filter((id) => id !== "event_data").every((id) => state(id) === "pass");
}

/** The state a signal row records; a paper setup is its own state so it gets its own event. */
function stateKey(result) {
	return isPaperSetup(result) ? "WAIT_PAPER_SETUP" : result.status;
}

/**
 * Whether an alert for this strategy version may go out LIVE, and every
 * reason it can't. Paper is what's left.
 */
function liveEligibility({ feedCanConfirm, versionStatus, strategyKey = STRATEGY_KEY, prefs }) {
	const why = [];
	if (!feedCanConfirm) why.push("the market-data feed isn't full-market (SIP)");
	if (versionStatus !== "validated") why.push("the strategy isn't validated yet");
	if (!(prefs?.live_strategies || []).includes(strategyKey)) why.push("live alerts aren't switched on for this strategy");
	return { live: why.length === 0, why };
}

/** The plan's figures from a stored event's sizing. */
function planFrom(sizing) {
	if (!sizing?.ok) return null;
	const entry = num(sizing.entry);
	const stop = num(sizing.stop);
	const target = num(sizing.target);
	return {
		entry, stop, target,
		shares: num(sizing.shares),
		position_cost: num(sizing.position_cost),
		planned_risk: num(sizing.planned_loss),
		risk_with_costs: num(sizing.est_loss_with_costs),
		reward_risk: entry && stop && target && entry > stop ? round((target - entry) / (entry - stop), 2) : null,
	};
}

// ---------------------------------------------------------------------------
// Transitions → notification candidates
// ---------------------------------------------------------------------------

/**
 * What one stored event should notify, given what was already notified about
 * its signal. `prior` maps notification event → state for this signal.
 *
 * Returns [] or [{ event, dedupe_key, priority, paper_only, payload, expires_at, skip? }].
 * A candidate with `skip` is recorded as skipped, so the history shows it.
 */
function candidatesFromEvent(e, signal, prior = new Map()) {
	const out = [];
	const to = e.to_status;
	const from = e.from_status;
	const base = {
		signal_uuid: signal.uuid, symbol: signal.symbol, session_date: signal.session_date, strategy: STRATEGY_KEY, strategy_version: signal.strategy_version ?? null,
		setup_type: SETUP_LABEL[STRATEGY_KEY] || STRATEGY_KEY, status: to, reason: e.reason, feed: signal.feed, seq: e.seq, signal_at: e.evaluated_at,
	};
	const notified = (ev) => prior.get(ev) === "sent";
	const toldAboutIt = notified("ENTRY_CONFIRMED") || notified("SETUP_FORMING");
	const wasConfirmLike = from === STATUS.ENTRY_CONFIRMED || e.from_key === "WAIT_PAPER_SETUP";

	const paperSetup = isPaperSetup({ status: to, conditions: e.conditions, sizing: e.sizing, indicators: e.indicators });
	if (to === STATUS.ENTRY_CONFIRMED || paperSetup) {
		const plan = planFrom(e.sizing);
		if (!plan) return out;
		const confirmedAt = to === STATUS.ENTRY_CONFIRMED ? signal.confirmed_at || e.evaluated_at : e.evaluated_at;
		const expires = expiryFor({ sessionDate: signal.session_date, status: STATUS.ENTRY_CONFIRMED, confirmedAt });
		out.push({
			event: "ENTRY_CONFIRMED", dedupe_key: `confirm:${signal.id}`, priority: "high", paper_only: paperSetup,
			payload: { ...base, ...plan, paper_reason: paperSetup ? "the IEX feed can watch but not confirm" : null, expires_at: expires.toISOString() },
			expires_at: expires,
		});
		return out;
	}
	if (to === STATUS.SETUP_FORMING) {
		out.push({
			event: "SETUP_FORMING", dedupe_key: `forming:${signal.id}`, priority: "low", paper_only: false,
			payload: { ...base, next_step: e.next_step || null, expires_at: signal.expires_at || null }, expires_at: signal.expires_at ? new Date(signal.expires_at) : null,
		});
		return out;
	}
	if (to === STATUS.EXPIRED) {
		if (prior.has("SETUP_INVALIDATED")) return out;
		const c = { event: "SETUP_EXPIRED", dedupe_key: `expired:${signal.id}`, priority: "normal", paper_only: false, payload: { ...base }, expires_at: null };
		if (!prior.size) return out; // never mentioned, so nothing to retract
		if (!toldAboutIt) c.skip = "Nothing about this setup reached a device, so there was nothing to retract.";
		out.push(c);
		return out;
	}
	// Leaving a confirmation (live or paper), or ending outright after forming.
	const ended = TERMINAL.has(to) || to === STATUS.AVOID;
	if (wasConfirmLike || (from === STATUS.SETUP_FORMING && ended)) {
		if (!prior.size) return out;
		const c = {
			event: "SETUP_INVALIDATED", dedupe_key: `invalid:${signal.id}`, priority: wasConfirmLike ? "high" : "normal", paper_only: false,
			payload: { ...base, exit: e.indicators?.exit || null }, expires_at: null,
		};
		if (!toldAboutIt) c.skip = "Nothing about this setup reached a device, so there was nothing to retract.";
		out.push(c);
	}
	return out;
}

/** A daily-risk alert row → a RISK_LIMIT_REACHED candidate (only the "limit reached" ones). */
function candidateFromRiskAlert(a) {
	if (!/^risk:\d{4}-\d{2}-\d{2}:(full|trades)$/.test(a.dedupe_key || "")) return null;
	return {
		event: "RISK_LIMIT_REACHED", dedupe_key: a.dedupe_key, priority: "high", paper_only: false,
		payload: { title: a.title, reason: a.body, signal_at: a.created_at }, expires_at: null,
	};
}

// ---------------------------------------------------------------------------
// Revalidation — may this still be shown as actionable?
// ---------------------------------------------------------------------------

/**
 * Re-check a confirmed setup against current conditions.
 *
 * @param {object} p
 * @param {object} p.notification   { payload, mode? }
 * @param {object} p.signal          current signal row (status, expires_at, state_key)
 * @param {object} p.evaluation      the latest live evaluation of the symbol (engine row.signal)
 * @param {object} p.dashboard       engine payload (market, data, strategy, account, events)
 * @param {object} p.prefs           notification prefs
 * @param {number} p.now
 * @returns {{ actionable: boolean, mode: 'live'|'paper', checks: Array, blocking: string[], paper_because: string[], ledger_only: boolean }}
 */
function revalidate({ notification, signal, evaluation, dashboard, prefs, now }) {
	const checks = [];
	const add = (id, label, ok, detail, liveOnly = false) => checks.push({ id, label, ok: !!ok, detail, live_only: liveOnly });
	const plan = notification.payload || {};
	const phase = dashboard?.market?.phase;
	const account = dashboard?.account || {};
	const today = account.today || {};
	const settings = account.settings || {};

	add("market_open", "Market open, before the entry cutoff", phase === "open" && now < cutoffAt(signal?.session_date || plan.session_date),
		phase !== "open" ? `The market is ${phase || "unknown"}.` : now >= cutoffAt(signal?.session_date || plan.session_date) ? "Past the day's entry cutoff." : "Open.");
	const windowEnd = Date.parse(plan.expires_at || signal?.expires_at || 0);
	add("not_expired", "Inside the entry window", Number.isFinite(windowEnd) && windowEnd > now && signal?.status !== STATUS.EXPIRED,
		Number.isFinite(windowEnd) ? `Window ${windowEnd > now ? "ends" : "ended"} ${clock.etClock(windowEnd)} ET.` : "No entry window recorded.");

	const evAge = evaluation?.evaluated_at ? now - Date.parse(evaluation.evaluated_at) : Infinity;
	const data = evaluation?.data || {};
	add("fresh_data", "Fresh quotes and completed candles", evAge <= MAX_EVALUATION_AGE_MS && data.stale === false,
		!evaluation ? "No current evaluation." : evAge > MAX_EVALUATION_AGE_MS ? `Last evaluated ${Math.round(evAge / 1000)}s ago.` : data.stale ? `Data problem: ${(data.problems || []).join("; ")}.` : `Candle ${data.bar_age_s ?? "?"}s, quote ${data.quote_age_s ?? "?"}s old.`);

	const stillOn = evaluation?.status === STATUS.ENTRY_CONFIRMED || isPaperSetup(evaluation);
	add("conditions", "Strategy conditions still hold", stillOn && !TERMINAL.has(signal?.status),
		stillOn ? evaluation.reason : `Now ${evaluation?.status || signal?.status || "unknown"}: ${evaluation?.reason || "no current evaluation"}`);

	const price = num(evaluation?.indicators?.price);
	const entry = num(plan.entry);
	const stop = num(plan.stop);
	const target = num(plan.target);
	const chaseLimit = entry && stop ? entry + DEFAULT_PARAMS.maxChaseR * (entry - stop) : null;
	add("entry_range", "Price inside the entry range", price !== null && stop !== null && chaseLimit !== null && price > stop && price <= chaseLimit,
		price === null ? "No current price." : price <= stop ? `Price ${money(price)} is at or below the stop ${money(stop)}.` : price > chaseLimit ? `Price ${money(price)} ran past ${money(chaseLimit)}; don't chase.` : `Price ${money(price)}; range up to ${money(chaseLimit)}.`);

	const shares = num(plan.shares);
	const levelsOk = entry > 0 && stop > 0 && target > 0 && stop < entry && entry < target && shares > 0 && (settings.allow_fractional || Number.isInteger(shares));
	add("levels", "Valid entry, stop, target and size", levelsOk, levelsOk ? `${shares} sh, entry ${money(entry)}, stop ${money(stop)}, target ${money(target)}.` : "The plan's levels or share count aren't valid.");

	const rr = entry && stop && target && entry > stop ? (target - entry) / (entry - stop) : 0;
	const minRr = Math.max(MIN_REWARD_RISK, num(settings.min_reward_risk) || 0);
	add("reward_risk", `Reward/risk at least ${minRr}:1`, rr + 1e-9 >= minRr, `${round(rr, 2)}:1.`);

	const cost = num(plan.position_cost) ?? (shares && entry ? shares * entry : null);
	const settled = num(account.cash?.usable_settled);
	add("settled_cash", "Enough settled cash", cost !== null && settled !== null && settled + 1e-9 >= cost, `${money(cost)} needed, ${money(settled)} settled.`);

	const risk = num(plan.risk_with_costs) ?? num(plan.planned_risk);
	const budget = num(today.risk_budget);
	add("daily_risk", "Inside the daily risk budget", risk !== null && budget !== null && risk <= budget + 0.005, `${money(risk)} planned against ${money(budget)} available.`);
	const trades = num(today.trades) ?? 0;
	const maxTrades = num(settings.max_trades_per_day) ?? 0;
	add("trade_count", "Trades left today", trades < maxTrades, `${trades} of ${maxTrades} used.`);

	const blackout = (dashboard?.events?.today || []).find((ev) => {
		const at = Date.parse(ev.at);
		return now >= at - DEFAULT_PARAMS.eventBlackoutBeforeMin * MINUTE && now <= at + DEFAULT_PARAMS.eventBlackoutAfterMin * MINUTE;
	});
	add("no_blackout", "No event blackout", !blackout, blackout ? `${blackout.name} at ${clock.etClock(blackout.at)} ET.` : "None now.");

	const live = liveEligibility({ feedCanConfirm: !!dashboard?.data?.can_confirm && data.feed_can_confirm !== false, versionStatus: dashboard?.strategy?.status, prefs });
	add("live_eligible", "Validated strategy, enabled for live alerts, full-market data", live.live, live.live ? "Yes." : `Paper only: ${live.why.join("; ")}.`, true);

	const blocking = checks.filter((c) => !c.ok && !c.live_only).map((c) => c.detail);
	const brokerToday = account.cash?.broker_settled_today;
	return {
		actionable: blocking.length === 0,
		mode: live.live && !isPaperSetup(evaluation) ? "live" : "paper",
		checks,
		blocking,
		paper_because: live.live ? (isPaperSetup(evaluation) ? ["the IEX feed can watch but not confirm"] : []) : live.why,
		ledger_only: brokerToday === null || brokerToday === undefined,
		checked_at: new Date(now).toISOString(),
	};
}

// ---------------------------------------------------------------------------
// Text — rendered from stored figures only
// ---------------------------------------------------------------------------

const WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
function sharesText(n) {
	if (Number.isInteger(n) && n >= 0 && n <= 10) return `${WORDS[n]} share${n === 1 ? "" : "s"}`;
	return `${n} shares`;
}

/** { title, body } for a notification. `ledgerOnly`: the broker's balance wasn't verified today. */
function render(n, { ledgerOnly = false, paperBecause = [] } = {}) {
	const p = n.payload || {};
	const sym = p.symbol || "";
	const paper = n.mode === "paper";
	const tag = paper ? "ATHENA PAPER / EXPERIMENTAL" : "ATHENA";
	switch (n.event) {
		case "ENTRY_CONFIRMED": {
			const why = paperBecause.length ? paperBecause : p.paper_reason ? [p.paper_reason] : [];
			const body = [
				`${p.setup_type}. Entry ${money(p.entry)}, stop ${money(p.stop)}, target ${money(p.target)}.`,
				`${sharesText(p.shares)} (~${money(p.position_cost)}), ${money(p.planned_risk)} planned risk, ${p.reward_risk}:1.`,
				`Signal ${clock.etClock(p.signal_at)} ET, entry window ends ${clock.etClock(p.expires_at)} ET.`,
				ledgerOnly ? "Sized from Athena's ledger; Webull's balance wasn't verified today." : "",
				paper ? `Not a live trade alert${why.length ? `: ${why.join("; ")}` : ""}.` : "Review before entering.",
			].filter(Boolean).join(" ");
			return { title: `${tag}: ${sym} setup ${paper ? "lined up" : "confirmed"}`, body };
		}
		case "SETUP_FORMING":
			return { title: `${tag}: ${sym} setup forming`, body: `${p.reason}${p.next_step ? ` ${p.next_step}` : ""} Nothing to act on yet.` };
		case "SETUP_INVALIDATED":
			return { title: `${tag}: ${sym} setup no longer valid`, body: `${p.reason} Don't act on the earlier alert.` };
		case "SETUP_EXPIRED":
			return { title: `${tag}: ${sym} setup expired`, body: `${p.reason} The earlier alert is no longer actionable.` };
		case "RISK_LIMIT_REACHED":
			return { title: `ATHENA: ${p.title || "Risk limit reached"}`, body: p.reason || "No further setups qualify today." };
		case "TEST":
			return { title: "ATHENA: trading test", body: "Trading notifications reach this device. Nothing here is a signal." };
		default:
			return { title: "ATHENA", body: p.reason || "" };
	}
}

/** Where tapping the notification lands. */
function deepLink(n) {
	const q = new URLSearchParams({ n: n.uuid });
	if (n.payload?.signal_uuid) q.set("setup", n.payload.signal_uuid);
	return `/family/trading?${q}`;
}

module.exports = {
	ENTRY_WINDOW_MIN, EXPIRY_POLICY, MAX_EVALUATION_AGE_MS, MIN_REWARD_RISK, TERMINAL,
	cutoffAt, expiryFor, isExpired, expiredResult, isPaperSetup, stateKey, liveEligibility, planFrom,
	candidatesFromEvent, candidateFromRiskAlert, revalidate, render, deepLink,
};
