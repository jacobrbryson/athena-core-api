/**
 * Opening-range breakout + VWAP trend continuation, long only.
 *
 * evaluate() is a pure function of what was known at `asOf`: closed candles,
 * the latest quote, the market context and the account's limits. The live
 * engine, the backtester and signal replay all call it, so a signal can be
 * reproduced exactly from its stored inputs and parameters. No model is
 * involved; a model may only explain the result afterwards.
 *
 * Every threshold is a parameter (DEFAULT_PARAMS, documented inline). A change
 * of parameters is a new strategy version (strategyVersions.js), never an edit.
 *
 * Condition states: "pass" | "fail" | "pending". Only a full set of passes,
 * on fresh data from a feed allowed to confirm, gives ENTRY_CONFIRMED.
 * docs/architecture/trading.md has the full rules in prose.
 */

const ind = require("./indicators");
const { sizePosition } = require("./risk");
const { hhmm, etClock } = require("./marketClock");

const STRATEGY_KEY = "orb_vwap";

const DEFAULT_PARAMS = Object.freeze({
	// Opening range: 9:30 to 9:30 + this. No entry signal before it ends.
	openingRangeMinutes: 15,
	// Minimum 1-minute bars inside the range for it to count (gaps = no trades on the feed).
	openingRangeMinBars: 12,
	// VWAP is "flat to rising" when its change over this many 1-minute bars,
	// as a fraction of price, is at least vwapMinSlope (slightly negative = flat allowed).
	vwapSlopeLookback: 10,
	vwapMinSlope: -0.0003,
	// Swing-low pivots need this many closed bars on each side.
	pivotStrength: 2,
	// A breakout is a CLOSED 1-minute bar above ORH by this fraction.
	breakoutBuffer: 0.0005,
	// The breakout has failed if a later bar closes this far below ORH.
	failTolerance: 0.002,
	// A retest is a bar whose low comes within this fraction above ORH (or below it)…
	retestTolerance: 0.0015,
	// …and closes no more than holdTolerance below ORH. Confirmation is a later
	// closed bar above the retest bar's high.
	holdTolerance: 0.001,
	// Volume: relative volume at the same time of day, and the breakout bar
	// against the session's average bar so far.
	minRelativeVolume: 1.5,
	breakoutVolumeMultiple: 1.2,
	rvolLookbackDays: 10,
	// Spread: as a fraction of mid, and as a share of the stop distance.
	maxSpreadPct: 0.002,
	maxSpreadOfRisk: 0.25,
	// Spread this wide is AVOID, not WAIT.
	avoidSpreadPct: 0.006,
	// Stop: below the retest low (or the last higher low) by this fraction, and
	// no tighter than minStopAtr × 1-minute ATR (a tighter one is noise).
	stopBuffer: 0.0005,
	minStopAtr: 0.5,
	atrPeriod: 14,
	// Overextended when price is more than this many ATRs above VWAP.
	maxExtensionAtr: 4,
	// AVOID when one 1-minute ATR is more than this fraction of price.
	maxAtrPct: 0.015,
	// Liquidity floor.
	minPrice: 5,
	minAvgDailyDollarVolume: 20_000_000,
	// Confirmed entries go stale once price runs this many R past entry.
	maxChaseR: 0.5,
	// SETUP_FORMING when price is within this fraction below ORH, above VWAP.
	approachPct: 0.003,
	// Time limits, ET.
	noNewEntriesAfter: "15:00",
	// Event blackout around scheduled high-impact events.
	eventBlackoutBeforeMin: 30,
	eventBlackoutAfterMin: 15,
	// Data freshness. A bar older than this (end to now) or a quote older than
	// this is stale; stale data can never confirm.
	maxBarAgeSec: 120,
	maxQuoteAgeSec: 30,
	// Feeds whose data may produce ENTRY_CONFIRMED. IEX alone is ~2–3% of
	// volume — its VWAP and volume are not the market's — so it can WATCH but
	// not confirm.
	confirmFeeds: ["sip"],
	// Market filter: long thesis conflicts when SPY and QQQ are both below VWAP.
	requireMarketAboveVwap: true,
	// Count the session high so far as overhead resistance for reward/risk.
	sessionHighIsResistance: true,
	// Backtests have no historical quotes; this spread is assumed instead.
	modelSpreadPct: 0.0005,
});

const STATUS = Object.freeze({
	WATCH: "WATCH",
	SETUP_FORMING: "SETUP_FORMING",
	ENTRY_CONFIRMED: "ENTRY_CONFIRMED",
	WAIT: "WAIT",
	AVOID: "AVOID",
	EXIT_INVALIDATED: "EXIT_INVALIDATED",
	// Set by the lifecycle (lifecycle.js), never by evaluate(): the setup's
	// entry window or the day's entry cutoff passed. Terminal, like
	// EXIT_INVALIDATED.
	EXPIRED: "EXPIRED",
});

/** The ten entry conditions; all must pass on fresh, confirmable data. */
const ENTRY_CONDITIONS = Object.freeze(["above_vwap", "vwap_rising", "higher_lows", "breakout", "retest_hold", "volume", "spread", "risk_budget", "reward_risk", "event_data"]);

const money = (x) => (x === null || x === undefined ? "—" : `$${Number(x).toFixed(2)}`);
const pct = (x, dp = 2) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(dp)}%`);

/**
 * @param {object} input
 * @param {string} input.symbol
 * @param {number} input.asOf               epoch ms of the evaluation
 * @param {object} input.session            marketClock.sessionFor(date)
 * @param {Array}  input.bars               1-minute bars (premarket + session), any may be unfinished
 * @param {object} [input.quote]            { bid, ask, t } latest NBBO (or IEX top) quote
 * @param {string} input.feed               'sip' | 'iex' | 'delayed_sip'
 * @param {boolean} [input.simulated]       backtest: quote is modelled, quote age not checked
 * @param {Array}  [input.priorDays]        [{ bars }] prior sessions' regular-hours 1-minute bars
 * @param {object} [input.prevDay]          { h, l, c } prior session
 * @param {number} [input.avgDailyDollarVolume]
 * @param {object} [input.market]           { spy: { above_vwap }, qqq: { above_vwap } }
 * @param {Array}  [input.events]           [{ at, name }] scheduled events today
 * @param {object} input.account            { settledCash, riskBudget, rewardRisk, costs, allowFractional, tradesToday, maxTradesPerDay, accountValue }
 * @param {object} [input.previous]         { status, confirmed: { entry, stop, target, at } }
 * @param {object} [input.params]
 */
function evaluate(input) {
	const params = { ...DEFAULT_PARAMS, ...(input.params || {}) };
	const { asOf, session, account } = input;
	const openAt = Date.parse(session.open_at);
	const closeAt = Date.parse(session.close_at);
	const orEnd = openAt + params.openingRangeMinutes * ind.MINUTE;

	const closed = ind.closedBars(input.bars || [], asOf);
	const sessionBars = closed.filter((b) => b.t >= openAt && b.t < closeAt);
	const premarket = closed.filter((b) => b.t < openAt && b.t >= openAt - 330 * ind.MINUTE);
	const last = sessionBars[sessionBars.length - 1] || null;

	const conditions = [];
	const add = (id, label, state, detail, value = null, threshold = null) =>
		conditions.push({ id, label, state, detail, value, threshold });
	const indicators = {};
	const levels = {};
	const result = (status, reason, next, extra = {}) => ({
		symbol: input.symbol,
		status,
		reason,
		next_step: next,
		evaluated_at: new Date(asOf).toISOString(),
		strategy: STRATEGY_KEY,
		conditions,
		indicators,
		levels,
		data,
		sizing: null,
		...extra,
	});

	// ---- data quality ------------------------------------------------------
	const lastBarEnd = last ? last.t + ind.MINUTE : null;
	const barAge = lastBarEnd ? Math.max(0, (asOf - lastBarEnd) / 1000) : null;
	const quote = input.simulated && last
		? { bid: last.c * (1 - params.modelSpreadPct / 2), ask: last.c * (1 + params.modelSpreadPct / 2), t: asOf, modelled: true }
		: input.quote || null;
	// Clocks differ by a second or two; a quote stamped "after" now is as fresh as now, never fresher.
	const quoteAge = quote?.t ? Math.max(0, (asOf - quote.t) / 1000) : null;
	const feedCanConfirm = params.confirmFeeds.includes(input.feed);
	const data = {
		feed: input.feed,
		feed_can_confirm: feedCanConfirm,
		last_bar_at: last ? new Date(last.t).toISOString() : null,
		bar_age_s: barAge === null ? null : Math.round(barAge),
		quote_at: quote?.t ? new Date(quote.t).toISOString() : null,
		quote_age_s: quoteAge === null ? null : Math.round(quoteAge),
		quote_modelled: !!quote?.modelled,
		stale: false,
		problems: [],
	};
	if (asOf >= openAt + 2 * ind.MINUTE) {
		if (!last) data.problems.push("no session candles yet");
		else if (barAge > params.maxBarAgeSec) data.problems.push(`last candle is ${Math.round(barAge)}s old`);
	}
	if (!input.simulated) {
		if (!quote || !(quote.bid > 0) || !(quote.ask > 0)) data.problems.push("no usable quote");
		else if (quoteAge > params.maxQuoteAgeSec) data.problems.push(`quote is ${Math.round(quoteAge)}s old`);
	}
	data.stale = data.problems.length > 0;

	// Expired is terminal whatever the candles say: the setup can't re-form today.
	if (input.previous?.status === STATUS.EXPIRED) {
		return result(STATUS.EXPIRED, input.previous.reason || "This setup expired.", "One setup per symbol per day; nothing further today.", { confirmed: input.previous.confirmed || null });
	}

	// ---- before the decision window ---------------------------------------
	if (!session.trading) return result(STATUS.WAIT, "The market is closed today.", "Nothing to do until the next session.");
	if (asOf < openAt) return result(STATUS.WATCH, "Premarket. No entries before the opening range completes.", `Opening range forms ${etClock(openAt)}–${etClock(orEnd)} ET.`);
	if (asOf >= closeAt) return result(STATUS.WAIT, "The regular session has closed.", "No overnight positions; nothing to do until tomorrow.");

	const vwaps = ind.vwapSeries(sessionBars);
	const vwap = vwaps[vwaps.length - 1] ?? null;
	const slope = ind.vwapSlope(vwaps, params.vwapSlopeLookback);
	const atr = ind.atr(sessionBars, params.atrPeriod);
	const or = ind.openingRange(sessionBars, openAt, params.openingRangeMinutes);
	const price = last?.c ?? null;
	Object.assign(indicators, {
		price: ind.round(price),
		vwap: ind.round(vwap),
		vwap_slope: ind.round(slope, 6),
		atr_1m: ind.round(atr),
		session_volume: sessionBars.reduce((s, b) => s + b.v, 0),
	});
	if (or) Object.assign(levels, { or_high: ind.round(or.high), or_low: ind.round(or.low) });
	if (premarket.length) levels.premarket_high = ind.round(Math.max(...premarket.map((b) => b.h)));
	if (input.prevDay?.h) levels.prev_day_high = ind.round(input.prevDay.h);
	if (input.prevDay?.c) levels.prev_close = ind.round(input.prevDay.c);
	if (vwap !== null) levels.vwap = ind.round(vwap);

	// Relative volume to this minute vs the same minute on prior days.
	const minutesIn = Math.floor((Math.min(asOf, closeAt) - openAt) / ind.MINUTE);
	const history = (input.priorDays || []).slice(0, params.rvolLookbackDays).map((day) => {
		const dayOpen = day.bars[0] ? day.open_at ?? day.bars[0].t : null;
		return dayOpen ? ind.cumulativeVolume(day.bars, dayOpen + minutesIn * ind.MINUTE) : null;
	});
	const rvol = ind.relativeVolume(indicators.session_volume, history);
	indicators.relative_volume = ind.round(rvol, 2);
	indicators.rvol_baseline_days = history.filter((x) => x > 0).length;

	if (asOf < orEnd || !or) {
		add("opening_range", "Opening range complete", "pending", `Forming until ${etClock(orEnd)} ET.`);
		return result(STATUS.WATCH, "Observing the opening range. No entry signals in the first 15 minutes.", `Wait for the range to finish at ${etClock(orEnd)} ET.`);
	}
	if (or.bars < params.openingRangeMinBars) data.problems.push(`opening range has ${or.bars} of ${params.openingRangeMinutes} candles`);
	data.stale = data.problems.length > 0;

	// ---- the ten entry conditions -----------------------------------------
	const afterOr = sessionBars.filter((b) => b.t >= orEnd);
	const breakoutLevel = or.high * (1 + params.breakoutBuffer);
	const breakoutIdx = afterOr.findIndex((b) => b.c > breakoutLevel);
	const breakout = breakoutIdx >= 0 ? afterOr[breakoutIdx] : null;
	const sinceBreakout = breakout ? afterOr.slice(breakoutIdx + 1) : [];
	const failedBreakout = breakout && sinceBreakout.some((b) => b.c < or.high * (1 - params.failTolerance));

	// 1. above VWAP
	const aboveVwap = price !== null && vwap !== null && price > vwap;
	add("above_vwap", "Price above VWAP", aboveVwap ? "pass" : "fail", `Last close ${money(price)} vs VWAP ${money(vwap)}.`, ind.round(price), ind.round(vwap));

	// 2. VWAP flat to rising
	if (slope === null) add("vwap_rising", "VWAP flat to rising", "pending", "Not enough candles for a slope yet.");
	else add("vwap_rising", "VWAP flat to rising", slope >= params.vwapMinSlope ? "pass" : "fail", `VWAP moved ${pct(slope, 3)} over ${params.vwapSlopeLookback} min.`, ind.round(slope, 6), params.vwapMinSlope);

	// 3. higher lows
	const lows = ind.swingLows(sessionBars, params.pivotStrength);
	const recentLows = lows.slice(-2);
	let higherLows = "pending";
	if (recentLows.length === 2) higherLows = recentLows[1].low > recentLows[0].low ? "pass" : "fail";
	// A close below the last swing low breaks the structure even before a new pivot prints.
	if (higherLows === "pass" && price !== null && price < recentLows[1].low) higherLows = "fail";
	add("higher_lows", "Higher lows", higherLows,
		recentLows.length === 2 ? `Swing lows ${money(recentLows[0].low)} → ${money(recentLows[1].low)}${higherLows === "fail" && price < recentLows[1].low ? `, now below ${money(recentLows[1].low)}` : ""}.` : "Fewer than two confirmed swing lows so far.");
	indicators.swing_lows = recentLows.map((x) => ({ at: new Date(x.t).toISOString(), low: ind.round(x.low) }));

	// 4. breakout of the opening-range high on a closed candle
	let breakoutState = "pending";
	if (breakout && !failedBreakout) breakoutState = "pass";
	if (failedBreakout) breakoutState = "fail";
	add("breakout", "Closed above opening-range high", breakoutState,
		breakout ? `${etClock(breakout.t)} candle closed ${money(breakout.c)} above ${money(or.high)}${failedBreakout ? ", then closed back below it" : ""}.` : `No closed candle above ${money(or.high)} yet.`,
		breakout ? ind.round(breakout.c) : ind.round(price), ind.round(or.high));
	if (breakout) indicators.breakout_at = new Date(breakout.t).toISOString();

	// 5. pullback retests and holds the level, then resumes
	let retest = null;
	let confirmBar = null;
	if (breakout && !failedBreakout) {
		for (let i = 0; i < sinceBreakout.length; i++) {
			const b = sinceBreakout[i];
			if (b.l <= or.high * (1 + params.retestTolerance) && b.c >= or.high * (1 - params.holdTolerance)) {
				retest = b;
				confirmBar = sinceBreakout.slice(i + 1).find((x) => x.c > b.h) || null;
				if (confirmBar) break;
			}
		}
	}
	let retestState = "pending";
	if (failedBreakout) retestState = "fail";
	else if (retest && confirmBar) retestState = "pass";
	add("retest_hold", "Pullback held the breakout level", retestState,
		failedBreakout ? "The level didn't hold."
			: retest && confirmBar ? `Retest low ${money(retest.l)} held ${money(or.high)}; ${etClock(confirmBar.t)} candle closed ${money(confirmBar.c)} above the retest high.`
				: retest ? `Retest at ${etClock(retest.t)} held; waiting for a close above ${money(retest.h)}.`
					: breakout ? `Waiting for a pullback toward ${money(or.high)} that holds.` : "Needs a breakout first.");
	if (retest) levels.retest_low = ind.round(retest.l);

	// 6. volume confirms
	let volumeState = "pending";
	let volumeDetail = "Needs a breakout candle and a same-time-of-day baseline.";
	if (breakout) {
		const before = sessionBars.filter((b) => b.t < breakout.t);
		const avgBar = before.length ? before.reduce((s, b) => s + b.v, 0) / before.length : null;
		const mult = avgBar ? breakout.v / avgBar : null;
		indicators.breakout_volume_multiple = ind.round(mult, 2);
		if (rvol === null) volumeDetail = `No relative-volume baseline (${indicators.rvol_baseline_days} prior days).`;
		else {
			const ok = rvol >= params.minRelativeVolume && mult !== null && mult >= params.breakoutVolumeMultiple;
			volumeState = ok ? "pass" : "fail";
			volumeDetail = `Relative volume ${rvol.toFixed(2)}× (need ${params.minRelativeVolume}×); breakout candle ${mult === null ? "—" : mult.toFixed(2)}× the average candle (need ${params.breakoutVolumeMultiple}×).`;
		}
	} else if (rvol !== null) volumeDetail = `Relative volume ${rvol.toFixed(2)}× so far; judged on the breakout candle.`;
	add("volume", "Volume confirms", volumeState, volumeDetail, indicators.relative_volume, params.minRelativeVolume);

	// Structural stop, entry and the room above.
	const lastHigherLow = higherLows === "pass" ? recentLows[1].low : null;
	const structureLow = retest ? retest.l : lastHigherLow;
	const stop = structureLow ? structureLow * (1 - params.stopBuffer) : null;
	const entry = confirmBar
		? !input.simulated && quote?.ask > 0 && !data.stale ? Math.max(quote.ask, confirmBar.c) : confirmBar.c
		: price;
	const riskPerShare = stop && entry ? entry - stop : null;
	if (stop) levels.stop = ind.round(stop);
	if (confirmBar) levels.entry = ind.round(entry);

	// 7. spread acceptable
	const spread = quote?.bid > 0 && quote?.ask > 0 ? quote.ask - quote.bid : null;
	const mid = spread !== null ? (quote.ask + quote.bid) / 2 : null;
	const spreadPct = spread !== null ? spread / mid : null;
	indicators.spread = ind.round(spread);
	indicators.spread_pct = ind.round(spreadPct, 5);
	let spreadState = "pending";
	let spreadDetail = "No quote.";
	if (spread !== null) {
		const ofRisk = riskPerShare ? spread / riskPerShare : null;
		const ok = spreadPct <= params.maxSpreadPct && (ofRisk === null || ofRisk <= params.maxSpreadOfRisk);
		spreadState = ok ? "pass" : "fail";
		spreadDetail = `${money(spread)} (${pct(spreadPct, 3)} of price${ofRisk === null ? "" : `, ${Math.round(ofRisk * 100)}% of the stop distance`})${quote.modelled ? ", modelled" : ""}.`;
	}
	add("spread", "Spread acceptable", spreadState, spreadDetail, indicators.spread_pct, params.maxSpreadPct);

	// 8. a structural stop that fits the risk budget
	let sizing = null;
	let riskState = "pending";
	let riskDetail = "Needs a structural stop (a held retest or a higher low).";
	if (stop && entry && riskPerShare > 0) {
		const noiseFloor = atr ? params.minStopAtr * atr : 0;
		const resistance = nearestResistance(entry, levels, sessionBars, params);
		if (resistance !== null) levels.resistance = ind.round(resistance);
		sizing = sizePosition({
			entry, stop, settledCash: account.settledCash, riskBudget: account.riskBudget, rewardRisk: account.rewardRisk,
			spread: spread || 0, allowFractional: account.allowFractional, costs: account.costs, accountValue: account.accountValue, resistance,
		});
		if (riskPerShare < noiseFloor) {
			riskState = "fail";
			riskDetail = `Stop ${money(stop)} is ${money(riskPerShare)} away, inside normal noise (${params.minStopAtr}× ATR = ${money(noiseFloor)}).`;
		} else if (!sizing.ok) {
			riskState = "fail";
			riskDetail = sizing.reasons.join(" ");
		} else {
			riskState = "pass";
			riskDetail = `${sizing.shares} share${sizing.shares === 1 ? "" : "s"}, stop ${money(stop)} (${money(riskPerShare)}/share), about ${money(sizing.est_loss_with_costs)} at risk with costs.`;
		}
		if (sizing.ok) Object.assign(levels, { target: sizing.target });
	}
	add("risk_budget", "Stop fits the risk budget", riskState, riskDetail, sizing?.est_loss_with_costs ?? null, ind.round(account.riskBudget, 2));

	// 9. reward/risk to the first resistance
	let rrState = "pending";
	let rrDetail = "Needs entry and stop.";
	if (sizing?.ok) {
		const room = sizing.room_to_resistance_r;
		const ok = room === null || room >= account.rewardRisk;
		rrState = ok ? "pass" : "fail";
		rrDetail = room === null
			? `Target ${money(sizing.target)} (${account.rewardRisk}R); no resistance overhead in view.`
			: `Resistance ${money(levels.resistance)} is ${room.toFixed(2)}R above entry (need ${account.rewardRisk}R).`;
	}
	add("reward_risk", `Reward/risk at least ${account.rewardRisk}:1`, rrState, rrDetail, sizing?.room_to_resistance_r ?? null, account.rewardRisk);

	// 10. no event or data problem
	const blackout = (input.events || []).find((e) => {
		const at = Date.parse(e.at);
		return asOf >= at - params.eventBlackoutBeforeMin * ind.MINUTE && asOf <= at + params.eventBlackoutAfterMin * ind.MINUTE;
	});
	const dataOk = !data.stale && feedCanConfirm;
	// Kept with the data so a stored event can tell a feed that can't confirm
	// from an event blackout, which fail the same condition.
	data.blackout = blackout ? blackout.name : null;
	add("event_data", "No event or data issue", blackout || !dataOk ? "fail" : "pass",
		blackout ? `${blackout.name} at ${etClock(blackout.at)} ET is inside the blackout window.`
			: data.stale ? `Data problem: ${data.problems.join("; ")}.`
				: !feedCanConfirm ? `The ${input.feed?.toUpperCase()} feed can watch but not confirm (allowed: ${params.confirmFeeds.join(", ")}).`
					: "Fresh data; no scheduled event nearby.");

	// ---- gates outside the ten --------------------------------------------
	const spy = input.market?.spy;
	const qqq = input.market?.qqq;
	const marketWeak = params.requireMarketAboveVwap && spy && qqq && spy.above_vwap === false && qqq.above_vwap === false;
	add("market", "Market not working against longs", !spy || !qqq ? "pending" : marketWeak ? "fail" : "pass",
		!spy || !qqq ? "SPY/QQQ context unavailable." : `SPY ${spy.above_vwap ? "above" : "below"} VWAP, QQQ ${qqq.above_vwap ? "above" : "below"} VWAP.`);

	const extension = atr && vwap && price ? (price - vwap) / atr : null;
	indicators.extension_atr = ind.round(extension, 2);
	const extended = extension !== null && extension > params.maxExtensionAtr;
	add("not_extended", "Not overextended", extension === null ? "pending" : extended ? "fail" : "pass",
		extension === null ? "Needs ATR." : `${extension.toFixed(1)} ATRs above VWAP (limit ${params.maxExtensionAtr}).`);

	const atrPct = atr && price ? atr / price : null;
	const illiquid = (price !== null && price < params.minPrice) || (input.avgDailyDollarVolume !== undefined && input.avgDailyDollarVolume !== null && input.avgDailyDollarVolume < params.minAvgDailyDollarVolume);
	const wild = atrPct !== null && atrPct > params.maxAtrPct;
	const wideSpread = spreadPct !== null && spreadPct > params.avoidSpreadPct;
	add("tradeable", "Liquid and orderly", illiquid || wild || wideSpread ? "fail" : "pass",
		illiquid ? `Below the liquidity floor (price ≥ ${money(params.minPrice)}, ≥ $${(params.minAvgDailyDollarVolume / 1e6).toFixed(0)}M/day).`
			: wild ? `1-minute ATR is ${pct(atrPct)} of price (limit ${pct(params.maxAtrPct)}).`
				: wideSpread ? `Spread ${pct(spreadPct, 3)} is past the avoid line (${pct(params.avoidSpreadPct, 2)}).` : "Liquidity and volatility within limits.");

	const limitHit = account.tradesToday >= account.maxTradesPerDay;
	const noBudget = !(account.riskBudget > 0);
	add("daily_limits", "Daily limits", limitHit || noBudget ? "fail" : "pass",
		limitHit ? `${account.tradesToday} of ${account.maxTradesPerDay} trades used today.` : noBudget ? "The daily loss limit is used up." : `${account.tradesToday} of ${account.maxTradesPerDay} trades used; ${money(account.riskBudget)} of risk available.`);

	const cutoff = hhmm(params.noNewEntriesAfter);
	const pastCutoff = (asOf - openAt) / ind.MINUTE >= cutoff - hhmm("09:30");

	// ---- lifecycle of a confirmed setup -----------------------------------
	const confirmed = input.previous?.confirmed || null;
	if (input.previous?.status === STATUS.EXIT_INVALIDATED) {
		return result(STATUS.EXIT_INVALIDATED, input.previous.reason || "This setup already ended today.", "One setup per symbol per day; nothing further today.", { sizing, confirmed });
	}
	if (confirmed && last) {
		const hitStop = sessionBars.some((b) => b.t >= Date.parse(confirmed.at) && b.l <= confirmed.stop);
		const hitTarget = sessionBars.some((b) => b.t >= Date.parse(confirmed.at) && b.h >= confirmed.target);
		if (hitStop) return result(STATUS.EXIT_INVALIDATED, `Reached the stop ${money(confirmed.stop)}.`, "Setup over. Stops can fill worse than their price.", { sizing, confirmed, exit: "stop" });
		if (hitTarget) return result(STATUS.EXIT_INVALIDATED, `Reached the target ${money(confirmed.target)}.`, "Setup over.", { sizing, confirmed, exit: "target" });
		if (!aboveVwap || failedBreakout) return result(STATUS.EXIT_INVALIDATED, !aboveVwap ? `Closed below VWAP ${money(vwap)} after confirming.` : "Closed back below the breakout level after confirming.", "The thesis broke; setup over.", { sizing, confirmed, exit: "invalidated" });
		if (price > confirmed.entry + params.maxChaseR * (confirmed.entry - confirmed.stop)) {
			return result(STATUS.WAIT, `Ran past ${money(confirmed.entry + params.maxChaseR * (confirmed.entry - confirmed.stop))} without a fill at the planned entry.`, "Don't chase. The plan's stop and target are still tracked.", { sizing, confirmed });
		}
		// Confirmed and intact: the plan stands until a stop, target or
		// invalidation above ends it. Conditions keep being shown as they are now.
		return result(STATUS.ENTRY_CONFIRMED, data.stale ? `Confirmed earlier; data is now stale (${data.problems.join("; ")}).` : "Still within the confirmed plan.",
			`Plan: entry ${money(confirmed.entry)}, stop ${money(confirmed.stop)}, target ${money(confirmed.target)}.`, { sizing, confirmed });
	}

	// ---- classify ----------------------------------------------------------
	const state = (id) => conditions.find((c) => c.id === id)?.state;
	const tenIds = ENTRY_CONDITIONS;
	const allTen = tenIds.every((id) => state(id) === "pass");

	if (state("tradeable") === "fail") return result(STATUS.AVOID, conditions.find((c) => c.id === "tradeable").detail, "Not a candidate today.", { sizing, confirmed });
	if (state("daily_limits") === "fail") return result(STATUS.AVOID, conditions.find((c) => c.id === "daily_limits").detail, "No more trades today.", { sizing, confirmed });
	if (riskState === "fail" && sizing && !sizing.ok) return result(STATUS.AVOID, riskDetail, "The risk budget can't support even one share at a structural stop.", { sizing, confirmed });
	if (pastCutoff) return result(STATUS.WAIT, `No new entries after ${params.noNewEntriesAfter} ET.`, "No overnight positions; done for the day.", { sizing });

	if (allTen && state("market") !== "fail" && state("not_extended") !== "fail") {
		return result(STATUS.ENTRY_CONFIRMED, "All entry conditions passed on closed candles.",
			`Plan: about ${money(sizing.entry)}, stop ${money(sizing.stop)}, target ${money(sizing.target)}, ${sizing.shares} share${sizing.shares === 1 ? "" : "s"}. Your decision; Athena places nothing.`,
			{ sizing, confirmed: { entry: sizing.entry, stop: sizing.stop, target: sizing.target, at: new Date(confirmBar.t).toISOString() } });
	}

	// Everything passes but data or feed: say exactly that.
	const allButData = tenIds.filter((id) => id !== "event_data").every((id) => state(id) === "pass");
	if (allButData && !blackout && !dataOk) return result(STATUS.WAIT, `Conditions line up, but ${data.stale ? "the data is stale" : `the ${input.feed?.toUpperCase()} feed can't confirm`}.`, data.stale ? "Wait for fresh data." : "A confirmation needs the full-market (SIP) feed.", { sizing });
	if (blackout) return result(STATUS.WAIT, `${blackout.name} at ${etClock(blackout.at)} ET.`, "Wait until the event has passed.", { sizing });
	if (data.stale) return result(STATUS.WAIT, `Data ${last ? "is stale" : "unavailable"}: ${data.problems.join("; ")}.`, "No signal is judged on stale data; wait for fresh quotes and candles.", { sizing });
	if (failedBreakout) return result(STATUS.WAIT, `The breakout over ${money(or.high)} failed.`, `It would need to reclaim ${money(or.high)} and hold a retest.`, { sizing });
	if (!aboveVwap) return result(STATUS.WAIT, `Below VWAP ${money(vwap)}; buyers don't have control.`, `Needs a close back above VWAP ${money(vwap)} and a higher low.`, { sizing });
	if (marketWeak) return result(STATUS.WAIT, "SPY and QQQ are both below VWAP; the market is working against longs.", "Wait for the market to steady.", { sizing });
	if (extended) return result(STATUS.WAIT, `Overextended: ${extension.toFixed(1)} ATRs above VWAP.`, "Wait for a pullback; don't chase.", { sizing });
	if (state("vwap_rising") === "fail") return result(STATUS.WAIT, "VWAP is falling.", "Needs VWAP to flatten or turn up.", { sizing });
	if (higherLows === "fail") return result(STATUS.WAIT, "Price is making lower lows.", "Needs a higher low first.", { sizing });

	const near = price >= or.high * (1 - params.approachPct);
	if (breakoutState === "pass" || near) {
		const pending = conditions.filter((c) => tenIds.includes(c.id) && c.state !== "pass").map((c) => c.label.toLowerCase());
		return result(STATUS.SETUP_FORMING, breakout ? `Broke ${money(or.high)} at ${etClock(breakout.t)}.` : `Within ${pct(params.approachPct, 1)} of the range high ${money(or.high)}.`,
			pending.length ? `Still needed: ${pending.join(", ")}.` : "Waiting on the next closed candle.", { sizing });
	}
	return result(STATUS.WATCH, `Above VWAP, below the range high ${money(or.high)}.`, `Needs a closed candle above ${money(or.high)}.`, { sizing });
}

/**
 * The nearest overhead level above `entry`: premarket high, prior-day high,
 * the session high so far, and confirmed swing highs.
 */
function nearestResistance(entry, levels, sessionBars, params) {
	const candidates = [levels.premarket_high, levels.prev_day_high];
	if (params.sessionHighIsResistance && sessionBars.length) candidates.push(Math.max(...sessionBars.map((b) => b.h)));
	for (const s of ind.swingHighs(sessionBars, params.pivotStrength)) candidates.push(s.high);
	// A level within a hair of entry is the breakout itself, not resistance.
	const above = candidates.filter((x) => Number.isFinite(x) && x > entry * 1.0005);
	return above.length ? Math.min(...above) : null;
}

module.exports = { STRATEGY_KEY, DEFAULT_PARAMS, STATUS, ENTRY_CONDITIONS, evaluate, nearestResistance };
