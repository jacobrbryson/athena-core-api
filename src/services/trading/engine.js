/**
 * The trading module's orchestration (docs/architecture/trading.md):
 * read market data → evaluate each watched symbol with strategy.evaluate() →
 * persist the decision trail → raise deduplicated alerts → run the paper
 * forward test. Evaluations happen while the dashboard (or a chat question)
 * asks for them, or when the market-hours monitor ticks (monitor.js), at most
 * every 15 s per person. After each one, notifications.process() derives and
 * delivers push notifications from what was stored. Nothing here can place an
 * order.
 */

const alpaca = require("./alpaca");
const marketData = require("./marketData");
const scanner = require("./scanner");
const strategy = require("./strategy");
const store = require("./store");
const clock = require("./marketClock");
const events = require("./events");
const cashMath = require("./cash");
const { riskBudget, estimateFees } = require("./risk");
const ind = require("./indicators");
const analytics = require("./analytics");
const notifications = require("./notifications");

const SECTORS = {
	XLK: "Technology", XLF: "Financials", XLE: "Energy", XLV: "Health care", XLY: "Consumer discretionary", XLP: "Consumer staples",
	XLI: "Industrials", XLU: "Utilities", XLB: "Materials", XLRE: "Real estate", XLC: "Communication",
};
const VOL_PROXY = "VIXY"; // VIX itself is an index Alpaca's stock feed doesn't carry; VIXY tracks VIX futures.
const MAX_WATCH = 8;
const EVAL_EVERY_MS = 15_000;
const STRATEGY_DESCRIPTION = "Opening-range breakout (15 min) + VWAP trend continuation, long only, closed-candle confirmation.";

const cache = new Map(); // profileId -> { at, promise, payload }
const lastMarketSnapshot = new Map(); // profileId -> ms

const money = (x) => (x === null || x === undefined ? "—" : `$${Number(x).toFixed(2)}`);
const cents = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------
// Account state
// ---------------------------------------------------------------------------

/** Cash, limits and today's usage for a person, without touching market data. */
async function accountState(profileId, date = clock.etParts().date) {
	const account = await store.ensureAccount(profileId);
	const entries = await store.ledger(account.id);
	const balances = cashMath.balances(entries, date);
	// Sizing uses the lower of Athena's ledger and Webull's own settled figure
	// when Webull was checked today — the broker is the authority on cash.
	const brokerToday = account.broker_checked_at && clock.etParts(account.broker_checked_at).date === date ? account.broker_settled_cash : null;
	const usable = brokerToday !== null && brokerToday !== undefined ? Math.min(balances.settled, brokerToday) : balances.settled;
	const live = await store.positions(profileId, { mode: "live", from: clock.etToUtc(date, 0) });
	const todays = live.filter((p) => clock.etParts(p.entry_at).date === date);
	const realized = todays.filter((p) => p.status === "closed").reduce((s, p) => s + (p.journal?.realized_pl || 0), 0);
	const open = (await store.positions(profileId, { mode: "live", status: "open" }));
	const openRisk = open.reduce((s, p) => s + Math.max(0, p.shares * (p.entry_price - p.planned_stop)), 0);
	const budget = riskBudget({ maxRiskPerTrade: account.max_risk_per_trade, maxDailyLoss: account.max_daily_loss, realizedLossToday: -Math.min(0, realized), openPlannedRisk: openRisk });
	return {
		account,
		cash: { ...balances, usable_settled: cents(usable), broker_settled_today: brokerToday ?? null, ledger_vs_broker: brokerToday === null || brokerToday === undefined ? null : cents(balances.settled - brokerToday) },
		today: { trades: todays.length, realized_pl: cents(realized), open_planned_risk: cents(openRisk), risk_budget: cents(budget), daily_loss_left: cents(Math.max(0, account.max_daily_loss + Math.min(0, realized) - openRisk)) },
		open_positions: open,
	};
}

// ---------------------------------------------------------------------------
// Market overview
// ---------------------------------------------------------------------------

async function marketOverview(date, feed, bars, now) {
	const symbols = ["SPY", "QQQ", VOL_PROXY, ...Object.keys(SECTORS)];
	const snaps = (await alpaca.snapshots(symbols, { feed })).data;
	const leg = (sym) => {
		const s = snaps[sym];
		const closed = ind.closedBars(bars[sym] || [], now);
		const session = clock.sessionFor(date);
		const sessionBars = session.open_at ? closed.filter((b) => b.t >= Date.parse(session.open_at)) : [];
		const vw = ind.vwapSeries(sessionBars);
		const price = s?.trade?.p ?? null;
		return {
			symbol: sym,
			price,
			price_at: s?.trade?.t ? new Date(s.trade.t).toISOString() : null,
			change: s?.prevDaily?.c && price ? ind.round(ind.change(s.prevDaily.c, price), 5) : null,
			change_from_open: sessionBars.length && price ? ind.round(ind.change(sessionBars[0].o, price), 5) : null,
			vwap: vw.length ? ind.round(vw[vw.length - 1]) : s?.daily?.vw ?? null,
			above_vwap: vw.length ? sessionBars[sessionBars.length - 1].c > vw[vw.length - 1] : null,
			spark: sessionBars.filter((_, i) => i % 5 === 0).map((b) => ind.round(b.c, 2)),
		};
	};
	const spy = leg("SPY");
	const qqq = leg("QQQ");
	const vol = leg(VOL_PROXY);
	const sectors = Object.entries(SECTORS).map(([sym, name]) => {
		const s = snaps[sym];
		const price = s?.trade?.p;
		return { symbol: sym, name, change: s?.prevDaily?.c && price ? ind.round(ind.change(s.prevDaily.c, price), 5) : null, above_vwap: s?.daily?.vw && price ? price > s.daily.vw : null };
	}).sort((a, b) => (b.change ?? -1) - (a.change ?? -1));
	const counted = sectors.filter((s) => s.above_vwap !== null);
	const breadth = counted.length ? { above_vwap: counted.filter((s) => s.above_vwap).length, of: counted.length, basis: "sector ETFs above their VWAP" } : null;
	return { spy, qqq, volatility: { ...vol, note: "VIXY (VIX short-term futures ETF) as the volatility gauge" }, sectors, breadth };
}

function classifyMarket(overview, phase, todaysEvents, now) {
	const reasons = [];
	const { spy, qqq, volatility, breadth } = overview;
	const stale = [spy, qqq].some((l) => !l.price_at || now - Date.parse(l.price_at) > 5 * 60_000);
	let regime = "uncertain";
	if (phase !== "open") reasons.push(`Market is ${phase}.`);
	else if (stale) reasons.push("SPY/QQQ prices are stale.");
	else if (spy.above_vwap === null || qqq.above_vwap === null) reasons.push("Not enough session candles yet.");
	else if (spy.above_vwap && qqq.above_vwap && (spy.change_from_open ?? 0) >= 0) regime = "bullish";
	else if (!spy.above_vwap && !qqq.above_vwap && (spy.change_from_open ?? 0) < 0) regime = "bearish";
	else regime = "mixed";
	if (regime !== "uncertain") reasons.push(`SPY ${spy.above_vwap ? "above" : "below"} VWAP, QQQ ${qqq.above_vwap ? "above" : "below"} VWAP.`);
	const upcoming = todaysEvents.find((e) => Date.parse(e.at) - now < 60 * 60_000 && now - Date.parse(e.at) < 30 * 60_000);
	if (upcoming) reasons.push(`${upcoming.name} at ${clock.etClock(upcoming.at)} ET.`);
	const volUp = volatility.change !== null && volatility.change > 0.06;
	if (volUp) reasons.push(`Volatility gauge up ${(volatility.change * 100).toFixed(1)}%.`);
	let assessment = "CAUTION";
	if (regime === "bearish" || volUp || upcoming) assessment = "UNFAVORABLE";
	else if (regime === "bullish" && (!breadth || breadth.above_vwap / breadth.of >= 0.5) && !(volatility.change > 0.03)) assessment = "FAVORABLE";
	return { regime, assessment, reasons };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

async function refreshWatchlist(profileId, date, phase, minutesIn, settledCash, feed, spyChange) {
	const existing = await store.watchlist(profileId, date);
	const etMin = clock.etParts().minutes;
	const scanWindow = (phase === "premarket" && etMin >= 7 * 60) || (phase === "open" && etMin < 10 * 60 + 30);
	const due = Date.now() - (await store.lastScanAt(profileId, date)) > 15 * 60_000;
	if (!scanWindow || (!due && existing.length)) return { list: existing, scan: null };
	const manual = existing.filter((w) => w.source === "manual").map((w) => w.symbol);
	const scan = await scanner.scan({ feed, minutesIn, settledCash, spyChange, extraSymbols: manual });
	const ranked = await Promise.all(scan.ranked.map(async (r, i) => ({
		symbol: r.symbol, rank: i + 1, score: r.score, company_name: r.company_name,
		reasons: [...r.reasons, ...(r.catalyst ? [`News: ${r.catalyst.headline}`] : [])],
	})));
	// After the opening range, scanner names already watched stay on (their
	// signals are in progress); new names can still join.
	const frozen = minutesIn >= 15 ? existing.filter((w) => w.source === "scanner" && !ranked.some((r) => r.symbol === w.symbol)) : [];
	await store.saveWatchlist(profileId, date, [...ranked, ...frozen.map((w) => ({ ...w, score: w.score }))].slice(0, MAX_WATCH));
	return { list: await store.watchlist(profileId, date), scan };
}

/**
 * Evaluate everything for one person now (throttled). The returned payload is
 * what the dashboard shows and what Athena reads in chat.
 */
async function evaluate(profileId, { force = false } = {}) {
	const hit = cache.get(profileId);
	if (hit?.promise) return hit.promise;
	if (hit && !force && Date.now() - hit.at < EVAL_EVERY_MS) return hit.payload;
	const promise = run(profileId)
		.then((payload) => {
			cache.set(profileId, { at: Date.now(), payload });
			return payload;
		})
		.catch((err) => {
			cache.delete(profileId);
			throw err;
		});
	cache.set(profileId, { ...(hit || {}), promise });
	return promise;
}

async function run(profileId) {
	const now = Date.now();
	const ph = clock.phase(now);
	const date = ph.et_date;
	const session = ph.session;
	const state = await accountState(profileId, date);
	const cfg = await alpaca.configured();
	const base = {
		generated_at: new Date(now).toISOString(),
		market: { phase: ph.phase, et_date: date, session, et_time: clock.etClock(now) },
		data: { source: alpaca.SOURCE, configured: cfg.configured, feed: cfg.feed, can_confirm: cfg.feed ? strategy.DEFAULT_PARAMS.confirmFeeds.includes(cfg.feed) : false, stream: marketData.streamInfo(), realtime: cfg.feed === "sip" || cfg.feed === "iex", delayed: cfg.feed === "delayed_sip" },
		account: publicAccount(state),
		events: { today: await events.eventsOn(date), coverage: events.coverage() },
	};
	marketData.idleCheck();
	if (!cfg.configured) return { ...base, overview: null, watchlist: [], note: "Market data isn't connected yet. The owner adds an Alpaca API key (see the Trading capability notes)." };

	const feed = cfg.feed;
	const version = await store.ensureStrategyVersion(strategy.STRATEGY_KEY, strategy.DEFAULT_PARAMS, STRATEGY_DESCRIPTION);
	const minutesIn = session.open_at ? Math.floor((now - Date.parse(session.open_at)) / 60_000) : 0;

	const indexBars = session.trading && ph.phase !== "closed" ? await marketData.todayBars(["SPY", "QQQ"], date, feed) : {};
	const overview = await marketOverview(date, feed, indexBars, now);
	const mkt = classifyMarket(overview, ph.phase, base.events.today, now);
	const { list, scan } = session.trading && (ph.phase === "premarket" || ph.phase === "open")
		? await refreshWatchlist(profileId, date, ph.phase, minutesIn, state.cash.usable_settled, feed, overview.spy.change)
		: { list: await store.watchlist(profileId, date), scan: null };

	const symbols = list.map((w) => w.symbol).slice(0, MAX_WATCH);
	const openSymbols = state.open_positions.map((p) => p.symbol);
	const live = session.trading && ph.phase !== "closed";
	if (live) marketData.follow([...new Set([...symbols, ...openSymbols, "SPY", "QQQ"])]);

	const all = [...new Set([...symbols, ...openSymbols])];
	const [bars, prior, quotes] = live && all.length
		? await Promise.all([marketData.todayBars(all, date, feed), marketData.priorSessions(symbols, date, feed, strategy.DEFAULT_PARAMS.rvolLookbackDays), marketData.quotes(all, feed)])
		: [{}, {}, {}];
	const snapsForList = all.length ? (await alpaca.snapshots(all, { feed }).catch(() => ({ data: {} }))).data : {};
	const recentNews = symbols.length ? await alpaca.news(symbols, { since: new Date(now - 24 * 3600_000).toISOString(), limit: 30 }).catch(() => []) : [];

	const marketCtx = { spy: { above_vwap: overview.spy.above_vwap }, qqq: { above_vwap: overview.qqq.above_vwap } };
	// Time-expired setups turn EXPIRED before anything reads them as current.
	await store.expireDue(profileId, now);
	const rows = [];
	for (const w of list) {
		const sym = w.symbol;
		const previous = await store.signalState(profileId, date, sym, version.id);
		const result = live ? strategy.evaluate({
			symbol: sym, asOf: now, session, bars: bars[sym] || [], quote: quotes[sym] || null, feed,
			priorDays: prior[sym]?.days || [], prevDay: prior[sym]?.prevDay || null, avgDailyDollarVolume: prior[sym]?.avgDailyDollarVolume ?? null,
			market: marketCtx, events: base.events.today,
			account: {
				settledCash: state.cash.usable_settled, riskBudget: state.today.risk_budget, rewardRisk: state.account.min_reward_risk, costs: state.account.costs,
				allowFractional: state.account.allow_fractional, tradesToday: state.today.trades, maxTradesPerDay: state.account.max_trades_per_day, accountValue: state.cash.total,
			},
			previous,
		}) : null;
		let record = null;
		if (result && ph.phase === "open") record = await persist(profileId, date, version, feed, result, previous, mkt, overview, state);
		const snap = snapsForList[sym];
		const news = recentNews.filter((n) => n.symbols.includes(sym)).slice(0, 3);
		rows.push({
			...w,
			price: snap?.trade?.p ?? null,
			price_at: snap?.trade?.t ? new Date(snap.trade.t).toISOString() : null,
			change: snap?.prevDaily?.c && snap?.trade?.p ? ind.round(ind.change(snap.prevDaily.c, snap.trade.p), 5) : null,
			catalyst: news[0] ? { headline: news[0].headline, source: news[0].source, at: news[0].created_at, url: news[0].url } : null,
			news,
			signal: result ? summarize(result) : previous ? { status: previous.status, reason: previous.reason } : null,
			signal_uuid: record?.uuid || previous?.uuid || null,
		});
	}

	await managePaper(profileId, bars, now);
	await positionAlerts(profileId, state, quotes, date, now);
	await riskAlerts(profileId, state, date);
	await eventAlerts(profileId, state, base.events.today, date, now);

	const payload = {
		...base,
		strategy: { key: strategy.STRATEGY_KEY, version: version.version, status: version.status, params_hash: version.params_hash, params: strategy.DEFAULT_PARAMS },
		overview: { ...overview, ...mkt },
		watchlist: rows,
		scan: scan ? { considered: scan.considered, skipped: scan.skipped.length, scanned_at: scan.scanned_at, source_partial: scan.source_partial } : null,
		no_trade_reason: noTradeReason(rows, mkt, state, ph.phase),
	};
	// The market's state is kept every five minutes (symbols are kept on every status change).
	if (ph.phase === "open" && mkt.regime !== "uncertain" && now - (lastMarketSnapshot.get(profileId) || 0) >= 5 * 60_000) {
		lastMarketSnapshot.set(profileId, now);
		store.insertSnapshot({ session_date: date, kind: "market", taken_at: now, data_source: alpaca.SOURCE, feed, quote_at: overview.spy.price_at, last_bar_at: null, is_stale: false, market_phase: ph.phase, regime: mkt.regime, assessment: mkt.assessment, payload: overview, profile_id: profileId })
			.catch(() => {});
	}
	await notifications.process(profileId, { now, dashboard: payload });
	return payload;
}

/** What the dashboard needs from an evaluation (the full result is in the event log). */
function summarize(r) {
	return { status: r.status, reason: r.reason, next_step: r.next_step, evaluated_at: r.evaluated_at, conditions: r.conditions, indicators: r.indicators, levels: r.levels, sizing: r.sizing, data: r.data, confirmed: r.confirmed || null };
}

function noTradeReason(rows, mkt, state, phase) {
	if (phase !== "open") return null;
	if (state.today.trades >= state.account.max_trades_per_day) return "Daily trade limit reached.";
	if (!(state.today.risk_budget > 0)) return "Daily loss limit reached.";
	if (!rows.length) return "Nothing on the watchlist passed the scanner's filters. A no-trade day is a valid outcome.";
	if (!rows.some((r) => ["ENTRY_CONFIRMED", "SETUP_FORMING"].includes(r.signal?.status))) return mkt.assessment === "UNFAVORABLE" ? "Conditions are unfavorable and nothing is setting up." : "Nothing is setting up right now.";
	return null;
}

/**
 * Persist one evaluation and react to a status change: a snapshot of what was
 * seen, the event, alerts, and the paper forward test.
 */
async function persist(profileId, date, version, feed, result, previous, mkt, overview, state) {
	const changed = previous?.status !== result.status;
	let snapshotId = null;
	if (changed) {
		snapshotId = await store.insertSnapshot({
			profile_id: profileId, session_date: date, kind: "symbol", symbol: result.symbol, taken_at: Date.parse(result.evaluated_at), data_source: alpaca.SOURCE, feed,
			quote_at: result.data.quote_at, last_bar_at: result.data.last_bar_at, is_stale: result.data.stale, market_phase: "open", regime: mkt.regime, assessment: mkt.assessment,
			payload: { indicators: result.indicators, levels: result.levels, data: result.data, market: { spy: overview.spy, qqq: overview.qqq } },
		});
	}
	const rec = await store.recordEvaluation({ profileId, date, versionId: version.id, source: alpaca.SOURCE, feed, result, snapshotId });
	if (!rec.changed) return rec;
	if (!state.account.alerts_enabled) return rec;
	const sym = result.symbol;
	if (result.status === "SETUP_FORMING") {
		await store.insertAlert({ profile_id: profileId, kind: "approaching", dedupe_key: `approach:${date}:${sym}`, signal_id: rec.signal_id, symbol: sym, title: `${sym} setup forming`, body: `${result.reason} ${result.next_step}` });
	}
	if (result.status === "ENTRY_CONFIRMED") {
		const validated = version.status === "validated";
		const s = result.sizing;
		await store.insertAlert({
			profile_id: profileId, kind: "entry_confirmed", dedupe_key: `confirm:${rec.signal_id}`, signal_id: rec.signal_id, symbol: sym, validated,
			title: `${sym} entry conditions confirmed${validated ? "" : " (paper — strategy not yet validated)"}`,
			body: `Plan: ~${money(s?.entry)}, stop ${money(s?.stop)}, target ${money(s?.target)}, ${s?.shares} sh, about ${money(s?.est_loss_with_costs)} at risk. An analytical signal, not an order; nothing is placed.`,
		});
		await openPaper(profileId, state, version, rec, result, mkt);
	}
	if (previous?.status === "ENTRY_CONFIRMED" && result.status !== "ENTRY_CONFIRMED") {
		await store.insertAlert({ profile_id: profileId, kind: "invalidated", dedupe_key: `invalid:${rec.signal_id}:${rec.seq}`, signal_id: rec.signal_id, symbol: sym, title: `${sym} setup ended`, body: result.reason });
	}
	if (result.status === "EXIT_INVALIDATED") await closePaper(profileId, rec.signal_id, result);
	return rec;
}

// ---------------------------------------------------------------------------
// Paper forward test — simulated positions only; no ledger, no broker.
// ---------------------------------------------------------------------------

async function openPaper(profileId, state, version, rec, result, mkt) {
	const s = result.sizing;
	if (!s?.ok) return;
	const date = clock.etParts().date;
	const paperToday = (await store.positions(profileId, { mode: "paper", from: clock.etToUtc(date, 0) })).length;
	if (paperToday >= state.account.max_trades_per_day) return;
	const fill = s.entry + (state.account.costs.slippage_per_share || 0);
	await store.openPosition({
		profile_id: profileId, account_id: state.account.id, mode: "paper", signal_id: rec.signal_id, strategy_version_id: version.id, symbol: result.symbol,
		shares: s.shares, entry_price: fill, entry_at: result.evaluated_at, planned_entry: s.entry, planned_stop: s.stop, planned_target: s.target,
		entry_fees: state.account.costs.commission_per_order || 0, conditions_at_entry: result.conditions, regime_at_entry: mkt.regime,
	});
}

async function closePaper(profileId, signalId, result) {
	const open = (await store.positions(profileId, { mode: "paper", status: "open" })).filter((p) => p.signal_id === signalId);
	for (const p of open) {
		const exit = result.exit === "stop" ? p.planned_stop : result.exit === "target" ? p.planned_target : result.indicators.price;
		await finishPaper(p, exit, result.exit === "stop" || result.exit === "target" ? result.exit : "invalidated", result.evaluated_at);
	}
}

async function finishPaper(p, exitRaw, reason, at) {
	const acct = await store.getAccount(p.profile_id ?? null).catch(() => null);
	const costs = acct?.costs || { slippage_per_share: 0.01 };
	const exit = reason === "target" ? exitRaw : exitRaw - (costs.slippage_per_share || 0);
	const exitFees = estimateFees(p.shares, exit, costs) - (costs.commission_per_order || 0);
	const journal = journalFigures(p, exit, exitFees);
	await store.closePosition(p, { exit_price: exit, exit_at: at, exit_fees: exitFees, exit_reason: reason, journal: { ...journal, followed_plan: true, notes: "Paper forward test (simulated)." } });
}

/**
 * Paper positions close at their stop or target from the candles since entry
 * (a stop touch wins a candle that touched both). This used to follow the
 * signal's EXIT_INVALIDATED, but a confirmed signal can now EXPIRE when its
 * entry window passes while the simulated position is still open.
 */
async function managePaper(profileId, bars, now) {
	for (const p of await store.positions(profileId, { mode: "paper", status: "open" })) {
		const since = ind.closedBars(bars[p.symbol] || [], now).filter((b) => b.t >= Date.parse(p.entry_at));
		const stopBar = since.find((b) => b.l <= p.planned_stop);
		const targetBar = p.planned_target ? since.find((b) => b.h >= p.planned_target) : null;
		const hit = stopBar && (!targetBar || stopBar.t <= targetBar.t) ? { exit: p.planned_stop, reason: "stop", t: stopBar.t } : targetBar ? { exit: p.planned_target, reason: "target", t: targetBar.t } : null;
		if (hit) await finishPaper({ ...p, profile_id: profileId }, hit.exit, hit.reason, new Date(hit.t + ind.MINUTE).toISOString());
	}
}

/** Paper positions still open near the close are flattened at the last price. */
async function flattenPaper(profileId, quotes, now) {
	const ph = clock.phase(now);
	if (ph.phase !== "open" || ph.et_minutes < ph.session.close_min - 5) return;
	for (const p of await store.positions(profileId, { mode: "paper", status: "open" })) {
		const q = quotes[p.symbol];
		if (q?.bid) await finishPaper({ ...p, profile_id: profileId }, q.bid, "end_of_day", new Date(now).toISOString());
	}
}

// ---------------------------------------------------------------------------
// Alerts beyond signal transitions
// ---------------------------------------------------------------------------

async function positionAlerts(profileId, state, quotes, date, now) {
	await flattenPaper(profileId, quotes, now);
	if (!state.account.alerts_enabled) return;
	for (const p of state.open_positions) {
		const q = quotes[p.symbol];
		if (!q?.bid) continue;
		if (q.bid <= p.planned_stop) {
			await store.insertAlert({ profile_id: profileId, kind: "position_stop", dedupe_key: `pos:${p.id}:stop`, position_id: p.id, symbol: p.symbol, title: `${p.symbol} at your stop`, body: `Bid ${money(q.bid)} is at or below your planned stop ${money(p.planned_stop)}. Record the exit once you've made it; Athena doesn't assume a fill.` });
		} else if (p.planned_target && q.bid >= p.planned_target) {
			await store.insertAlert({ profile_id: profileId, kind: "position_target", dedupe_key: `pos:${p.id}:target`, position_id: p.id, symbol: p.symbol, title: `${p.symbol} at your target`, body: `Bid ${money(q.bid)} reached your target ${money(p.planned_target)}. Record the exit once you've made it.` });
		}
	}
	const ph = clock.phase(now);
	if (state.open_positions.length && ph.phase === "open" && ph.et_minutes >= ph.session.close_min - 15) {
		await store.insertAlert({ profile_id: profileId, kind: "position_stop", dedupe_key: `eod:${date}`, symbol: null, title: "Close is 15 minutes away", body: `You have ${state.open_positions.length} open position${state.open_positions.length === 1 ? "" : "s"}; the plan holds nothing overnight.` });
	}
}

async function riskAlerts(profileId, state, date) {
	if (!state.account.alerts_enabled) return;
	const lost = -Math.min(0, state.today.realized_pl);
	const max = state.account.max_daily_loss;
	if (state.today.trades >= state.account.max_trades_per_day) await store.insertAlert({ profile_id: profileId, kind: "trade_limit", dedupe_key: `risk:${date}:trades`, title: "Daily trade limit reached", body: `${state.today.trades} of ${state.account.max_trades_per_day} trades used today. No further setups qualify today.` });
	if (lost >= max) await store.insertAlert({ profile_id: profileId, kind: "daily_risk", dedupe_key: `risk:${date}:full`, title: "Daily loss limit reached", body: `Realized ${money(-lost)} today against a ${money(max)} limit. No further setups qualify today.` });
	else if (lost >= max / 2) await store.insertAlert({ profile_id: profileId, kind: "daily_risk", dedupe_key: `risk:${date}:half`, title: "Half the daily loss limit used", body: `Realized ${money(-lost)} of a ${money(max)} limit; ${money(state.today.daily_loss_left)} left.` });
}

async function eventAlerts(profileId, state, todays, date, now) {
	if (!state.account.alerts_enabled) return;
	for (const e of todays) {
		const until = Date.parse(e.at) - now;
		if (until > 0 && until <= 30 * 60_000) {
			await store.insertAlert({ profile_id: profileId, kind: "event_soon", dedupe_key: `event:${date}:${e.name}:${e.time}`, title: `${e.name} at ${clock.etClock(e.at)} ET`, body: "Scheduled high-impact event; setups pause inside its window." });
		}
	}
}

// ---------------------------------------------------------------------------
// Symbol detail and replay
// ---------------------------------------------------------------------------

/** Candles (1m and 5m), the live evaluation and headlines for one watched symbol. */
async function symbolDetail(profileId, symbol) {
	const payload = await evaluate(profileId);
	const row = payload.watchlist.find((w) => w.symbol === symbol) || null;
	const date = payload.market.et_date;
	const session = payload.market.session;
	if (!payload.data.configured) return { symbol, row, bars_1m: [], bars_5m: [], market: payload.market, data: payload.data };
	let bars = [];
	if (session.trading) bars = (await marketData.todayBars([symbol], date, payload.data.feed))[symbol] || [];
	const now = Date.now();
	const closed = ind.closedBars(bars, now);
	const open = session.open_at ? Date.parse(session.open_at) : null;
	const five = open ? ind.aggregate(closed.filter((b) => b.t >= open), 5, open) : [];
	const vw = open ? ind.vwapSeries(closed.filter((b) => b.t >= open)) : [];
	const sessionClosed = open ? closed.filter((b) => b.t >= open) : [];
	return {
		symbol, row, market: payload.market, data: payload.data, strategy: payload.strategy,
		// Only closed candles, plus the forming one flagged, so the chart never presents an unfinished bar as final.
		bars_1m: closed.map((b) => ({ ...b })).concat(bars.filter((b) => b.t + 60_000 > now).map((b) => ({ ...b, forming: true }))),
		bars_5m: ind.closedBars(five, now, 5 * 60_000),
		vwap_1m: sessionClosed.map((b, i) => ({ t: b.t, v: ind.round(vw[i]) })),
	};
}

/**
 * What Athena knew when she classified a signal: its events, each with the
 * candles that had closed by then, from the stored copies — never later data.
 */
async function replay(profileId, uuid) {
	const s = await store.signalWithEvents(profileId, uuid);
	if (!s) return null;
	const session = clock.sessionFor(s.session_date);
	const from = clock.etToUtc(s.session_date, 4 * 60);
	const to = s.events.length ? Date.parse(s.events[s.events.length - 1].evaluated_at) : Date.parse(session.close_at);
	const candles = await store.candles(s.symbol, { feed: s.feed, from, to });
	return {
		signal: s,
		session,
		frames: s.events.map((e) => {
			const asOf = Date.parse(e.evaluated_at);
			return { ...e, candle_count: ind.closedBars(candles, asOf).length, as_of: e.evaluated_at };
		}),
		candles,
	};
}

// ---------------------------------------------------------------------------
// Manual positions (the person's own executions) and reconciliation
// ---------------------------------------------------------------------------

function journalFigures(p, exit, exitFees) {
	const fees = (p.entry_fees || 0) + (exitFees || 0);
	const pl = p.shares * (exit - p.entry_price) - fees;
	const plannedRisk = p.shares * (p.entry_price - p.planned_stop);
	return {
		realized_pl: cents(pl), fees: cents(fees), planned_risk: cents(plannedRisk),
		realized_risk: exit < p.entry_price ? cents(p.shares * (p.entry_price - exit) + fees) : 0,
		r_multiple: plannedRisk > 0 ? Math.round((pl / plannedRisk) * 1000) / 1000 : null,
		entry_slippage: p.planned_entry ? Math.round((p.entry_price - p.planned_entry) * 1e4) / 1e4 : null,
	};
}

const SYMBOL = /^[A-Z]{1,5}$/;

/** Record a buy the person made at their broker. Returns { position, warnings } or { error }. */
async function recordEntry(profileId, body) {
	const symbol = String(body.symbol || "").toUpperCase().trim();
	const shares = Number(body.shares);
	const price = Number(body.price);
	const stop = Number(body.stop);
	const target = body.target === undefined || body.target === null || body.target === "" ? null : Number(body.target);
	const fees = Number(body.fees || 0);
	const at = body.at ? new Date(body.at) : new Date();
	if (!SYMBOL.test(symbol)) return { error: "Symbol must be 1–5 letters." };
	if (!(shares > 0)) return { error: "Shares must be positive." };
	if (!(price > 0)) return { error: "Price must be positive." };
	if (!(stop > 0) || stop >= price) return { error: "A long position needs a stop below the entry price." };
	if (target !== null && !(target > price)) return { error: "The target must be above the entry price." };
	if (!(fees >= 0)) return { error: "Fees can't be negative." };
	if (Number.isNaN(at.getTime())) return { error: "That time isn't valid." };
	const date = clock.etParts(at).date;
	const state = await accountState(profileId, date);
	if (!state.account.allow_fractional && !Number.isInteger(shares)) return { error: "Fractional shares are off in your settings." };
	const cost = shares * price + fees;
	const entries = await store.ledger(state.account.id);
	const funding = cashMath.fundPurchase(entries, date, cost);
	if (funding.short_by > 0) return { error: `That costs ${money(cost)}, ${money(funding.short_by)} more than the cash recorded. A cash account can't buy on credit; record a deposit or reconcile with Webull first.` };
	const warnings = [];
	if (funding.unsettled_used > 0) warnings.push(`${money(funding.unsettled_used)} of this came from proceeds that settle ${funding.funds_settle_on}. Selling before then would be a good-faith violation.`);
	const plannedRisk = shares * (price - stop);
	if (plannedRisk > state.account.max_risk_per_trade + 0.005) warnings.push(`Planned risk ${money(plannedRisk)} is over your ${money(state.account.max_risk_per_trade)} per-trade limit.`);
	if (state.today.trades >= state.account.max_trades_per_day) warnings.push(`This is trade ${state.today.trades + 1}; your limit is ${state.account.max_trades_per_day} a day.`);
	const version = await store.ensureStrategyVersion(strategy.STRATEGY_KEY, strategy.DEFAULT_PARAMS, STRATEGY_DESCRIPTION);
	const signal = await store.signalState(profileId, date, symbol, version.id);
	const s = signal ? await store.signalWithEvents(profileId, signal.uuid) : null;
	const lastEvent = s?.events[s.events.length - 1];
	const regime = cache.get(profileId)?.payload?.overview?.regime || null;
	const uuid = await store.openPosition({
		profile_id: profileId, account_id: state.account.id, mode: "live", signal_id: signal?.id || null, strategy_version_id: signal ? version.id : null, symbol,
		setup_type: signal ? strategy.STRATEGY_KEY : String(body.setup_type || "discretionary").slice(0, 40), shares, entry_price: price, entry_at: at.toISOString(),
		planned_entry: signal?.confirmed?.entry ?? null, planned_stop: stop, planned_target: target, entry_fees: fees,
		unsettled_funds_used: funding.unsettled_used, funds_settle_on: funding.funds_settle_on,
		conditions_at_entry: lastEvent ? { status: lastEvent.to_status, at: lastEvent.evaluated_at, conditions: lastEvent.conditions } : null, regime_at_entry: regime,
	}, cashMath.buyEntries({ shares, price, fees, tradeDate: date }));
	cache.delete(profileId);
	return { position: await store.position(profileId, uuid), warnings };
}

/** Record the person's sale of a recorded position. */
async function recordExit(profileId, uuid, body) {
	const p = await store.position(profileId, uuid);
	if (!p || p.mode !== "live") return { error: "No such position." };
	if (p.status !== "open") return { error: "That position is already closed." };
	const price = Number(body.price);
	const fees = Number(body.fees || 0);
	const at = body.at ? new Date(body.at) : new Date();
	const reason = ["stop", "target", "manual", "end_of_day", "invalidated"].includes(body.reason) ? body.reason : "manual";
	if (!(price > 0)) return { error: "Price must be positive." };
	if (!(fees >= 0)) return { error: "Fees can't be negative." };
	if (Number.isNaN(at.getTime()) || at < new Date(p.entry_at)) return { error: "The exit can't be before the entry." };
	const date = clock.etParts(at).date;
	const warnings = [];
	if (cashMath.goodFaithViolation(p, date)) warnings.push(`This sale is before the funds used to buy settled (${p.funds_settle_on}): a good-faith violation in a cash account. Webull may restrict the account after several.`);
	if (date !== clock.etParts(p.entry_at).date) warnings.push("Held overnight, which the plan doesn't allow.");
	const journal = journalFigures(p, price, fees);
	const followed = body.followed_plan === undefined || body.followed_plan === null || body.followed_plan === "" ? null : body.followed_plan === true || body.followed_plan === "true";
	const chart = await chartSnapshot(p, at);
	const account = await store.getAccount(profileId);
	const ok = await store.closePosition({ ...p, profile_id: profileId, account_id: account.id }, {
		exit_price: price, exit_at: at.toISOString(), exit_fees: fees, exit_reason: reason,
		journal: { ...journal, profile_id: profileId, followed_plan: followed, notes: body.notes ? String(body.notes).slice(0, 4000) : null, chart_snapshot: chart },
	}, cashMath.sellEntries({ shares: p.shares, price, fees, tradeDate: date }));
	if (!ok) return { error: "That position is already closed." };
	await summarizeDay(profileId, date).catch(() => {});
	cache.delete(profileId);
	return { position: await store.position(profileId, uuid), warnings };
}

/** The stored 1-minute candles around a trade, kept with the journal entry. */
async function chartSnapshot(p, exitAt) {
	const cfg = await alpaca.configured();
	if (!cfg.feed) return null;
	const from = Date.parse(p.entry_at) - 30 * 60_000;
	const to = exitAt.getTime() + 10 * 60_000;
	const bars = await store.candles(p.symbol, { feed: cfg.feed, from, to }).catch(() => []);
	return bars.length ? { feed: cfg.feed, bars: bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]) } : null;
}

/** Cash movement the person made: a deposit or withdrawal. */
async function recordCash(profileId, body) {
	const amount = Number(body.amount);
	const kind = body.kind === "withdrawal" ? "withdrawal" : "deposit";
	if (!(amount > 0) || amount > 1_000_000) return { error: "Amount must be positive." };
	const account = await store.ensureAccount(profileId);
	const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : clock.etParts().date;
	// A deposit is usable once the broker settles it; the person says when (default: today).
	const settles = body.settles_on && /^\d{4}-\d{2}-\d{2}$/.test(body.settles_on) ? body.settles_on : date;
	await store.addLedger(account.id, [{ kind, amount: kind === "withdrawal" ? -amount : amount, trade_date: date, settles_on: kind === "withdrawal" ? date : settles, note: body.note ? String(body.note).slice(0, 200) : null }]);
	cache.delete(profileId);
	return { ok: true };
}

/**
 * Read Webull's cash figures (read-only connector) and remember them. With
 * `apply`, add an adjustment so the ledger's settled cash matches Webull's.
 */
async function reconcile(profileId, { apply = false } = {}) {
	const webull = require("../connectors/webull");
	const snap = await webull.snapshot(profileId, { fresh: true });
	const acct = snap.accounts.find((a) => /cash/i.test(`${a.type} ${a.class} ${a.label}`)) || snap.accounts[0];
	if (!acct) return { error: "Webull lists no account." };
	const b = acct.balance;
	const account = await store.ensureAccount(profileId);
	await store.recordBrokerCheck(account.id, { cash: b.cash, settled_cash: b.settled_cash });
	const date = clock.etParts().date;
	const balances = cashMath.balances(await store.ledger(account.id), date);
	const diff = b.settled_cash === null ? null : cents(b.settled_cash - balances.settled);
	if (apply && diff !== null && Math.abs(diff) >= 0.01) {
		await store.addLedger(account.id, [{ kind: "adjustment", amount: diff, trade_date: date, settles_on: date, note: `Reconciled to Webull settled cash ${money(b.settled_cash)}` }]);
	}
	cache.delete(profileId);
	return { broker: { cash: b.cash, settled_cash: b.settled_cash, buying_power: b.buying_power, checked_at: snap.checked_at, account: acct.label }, ledger_settled: balances.settled, difference: diff, applied: apply && diff !== null && Math.abs(diff) >= 0.01 };
}

function publicAccount(state) {
	const a = state.account;
	return {
		settings: {
			broker: a.broker, account_type: a.account_type, starting_capital: a.starting_capital, max_risk_per_trade: a.max_risk_per_trade, max_daily_loss: a.max_daily_loss,
			max_trades_per_day: a.max_trades_per_day, min_reward_risk: a.min_reward_risk, allow_fractional: a.allow_fractional, alerts_enabled: a.alerts_enabled, costs: a.costs,
		},
		cash: state.cash,
		today: state.today,
		broker: { cash: a.broker_cash, settled_cash: a.broker_settled_cash, checked_at: a.broker_checked_at },
		open_positions: state.open_positions,
	};
}

// ---------------------------------------------------------------------------
// Analytics and daily summaries
// ---------------------------------------------------------------------------

const toTrade = (p) => ({
	pl: p.journal?.realized_pl ?? 0, fees: p.journal?.fees ?? 0, planned_risk: p.journal?.planned_risk ?? null, r: p.journal?.r_multiple ?? null,
	followed_plan: p.journal?.followed_plan ?? null, setup_type: p.setup_type, regime: p.regime_at_entry, exit_at: p.exit_at, symbol: p.symbol,
});

/** Performance for a mode over a period: 'day' | 'week' | 'month' | 'all'. */
async function performance(profileId, { mode = "live", period = "week" } = {}) {
	const date = clock.etParts().date;
	const back = { day: 0, week: 6, month: 29, all: 3650 }[period] ?? 6;
	const from = clock.addDays(date, -back);
	const closed = (await store.positions(profileId, { mode, status: "closed", from: clock.etToUtc(from, 0), limit: 5000 })).filter((p) => p.journal);
	const account = await store.ensureAccount(profileId);
	const signals = await store.signalsBetween(profileId, from, date);
	const measured = signals.filter((s) => s.outcome);
	const confirmed = measured.filter((s) => s.ever_confirmed);
	const rejected = measured.filter((s) => !s.ever_confirmed);
	return {
		mode, period, from, to: date,
		...analytics.summary(closed.map(toTrade), { startingCapital: mode === "live" ? account.starting_capital : 0 }),
		signals: {
			total: signals.length,
			confirmed: signals.filter((s) => s.ever_confirmed).length,
			measured: measured.length,
			confirmed_target_first: confirmed.filter((s) => s.outcome === "target_first").length,
			confirmed_stop_first: confirmed.filter((s) => s.outcome === "stop_first").length,
			rejected_measured: rejected.length,
			rejected_would_have_won: rejected.filter((s) => s.outcome === "target_first").length,
			note: "Outcomes of rejected setups are hypothetical: a long at the first post-range price with the opening-range low as the stop, measured to 2R.",
		},
		summaries: await store.dailySummaries(profileId, from, date),
	};
}

/** Recompute a day's summary rows from positions and signals. */
async function summarizeDay(profileId, date) {
	const signals = await store.signalsForDay(profileId, date);
	for (const mode of ["live", "paper"]) {
		const closed = (await store.positions(profileId, { mode, status: "closed", from: clock.etToUtc(date, 0), to: clock.etToUtc(clock.addDays(date, 1), 0) })).filter((p) => p.journal);
		const t = closed.map(toTrade);
		const s = analytics.stats(t);
		await store.saveDailySummary(profileId, date, mode, {
			trades: s.trades, wins: s.wins, losses: s.losses, realized_pl: s.net_pl, fees: s.fees, r_total: t.reduce((a, x) => a + (x.r || 0), 0),
			plan_followed: t.filter((x) => x.followed_plan === true).length, plan_broken: t.filter((x) => x.followed_plan === false).length,
			signals_confirmed: signals.filter((x) => x.ever_confirmed).length, signals_invalidated: signals.filter((x) => x.status === "EXIT_INVALIDATED").length,
		});
	}
}

module.exports = {
	SECTORS, accountState, evaluate, symbolDetail, replay, recordEntry, recordExit, recordCash, reconcile, performance, summarizeDay,
	classifyMarket, journalFigures, _cache: cache,
};
