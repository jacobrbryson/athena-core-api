/**
 * Historical simulation of the strategy, minute by minute, through the SAME
 * strategy.evaluate() the live engine uses. Pure: data in, trades and metrics
 * out. scripts/tradingBacktest.js fetches the candles and stores the run.
 *
 * Honesty rules built in:
 *  - No look-ahead: at each minute evaluate() sees only candles that closed
 *    before it; fills happen on the NEXT candle's open.
 *  - Costs: slippage on both fills, a modelled spread (no historical quotes),
 *    commission and sell-side fees from the account's cost model.
 *  - Failed fills: a next open beyond the chase limit is a missed trade, kept
 *    in the results, not silently skipped.
 *  - Exits: a candle that touches both stop and target counts as the stop; a
 *    gap through the stop fills at the open. Flat by 15:55 ET.
 *  - The symbol list is whatever the caller chose. Picking today's winners and
 *    testing them on their past is survivorship bias; the run records the list
 *    so the reader can judge.
 */

const strategy = require("./strategy");
const ind = require("./indicators");
const { riskBudget, estimateFees } = require("./risk");
const analytics = require("./analytics");

const FLAT_AT_MIN = 15 * 60 + 55 - (9 * 60 + 30); // minutes after the open

function marketAt(bars, asOf) {
	if (!bars?.length) return null;
	const closed = ind.closedBars(bars, asOf);
	if (!closed.length) return null;
	const vw = ind.vwapSeries(closed);
	return { above_vwap: closed[closed.length - 1].c > vw[vw.length - 1] };
}

/**
 * @param {Array} days  [{ date, session, symbols: { SYM: { bars, priorDays, prevDay, avgDailyDollarVolume } }, spyBars, qqqBars, events }]
 * @param {object} opts { params, account: { startingCash, maxRiskPerTrade, maxDailyLoss, maxTradesPerDay, rewardRisk, allowFractional, costs } }
 */
function run(days, { params = {}, account }) {
	const p = { ...strategy.DEFAULT_PARAMS, ...params };
	const trades = [];
	const missed = [];
	let confirmations = 0;
	let cash = account.startingCash;

	for (const day of days) {
		const openAt = Date.parse(day.session.open_at);
		const closeAt = Date.parse(day.session.close_at);
		const flatAt = Math.min(closeAt - 5 * ind.MINUTE, openAt + FLAT_AT_MIN * ind.MINUTE);
		let tradesToday = 0;
		let realizedToday = 0;
		// Settled cash: today's sale proceeds are not reusable today (T+1).
		const settledAtOpen = cash;
		let spentToday = 0;
		const state = {};

		for (const [symbol, data] of Object.entries(day.symbols)) state[symbol] = { previous: null, position: null, data };

		for (let asOf = openAt + p.openingRangeMinutes * ind.MINUTE; asOf <= flatAt; asOf += ind.MINUTE) {
			const market = { spy: marketAt(day.spyBars, asOf), qqq: marketAt(day.qqqBars, asOf) };
			for (const [symbol, s] of Object.entries(state)) {
				const bars = s.data.bars;
				if (s.position) {
					manage(s, bars, asOf, flatAt);
					if (s.position?.closed) {
						const t = s.position;
						trades.push(t);
						realizedToday += t.pl;
						cash += t.pl;
						s.position = null;
					}
					continue;
				}
				if (s.done) continue;
				const budget = riskBudget({ maxRiskPerTrade: account.maxRiskPerTrade, maxDailyLoss: account.maxDailyLoss, realizedLossToday: -Math.min(0, realizedToday), openPlannedRisk: openRisk(state) });
				const result = strategy.evaluate({
					symbol, asOf, session: day.session, bars, feed: "sip", simulated: true,
					priorDays: s.data.priorDays, prevDay: s.data.prevDay, avgDailyDollarVolume: s.data.avgDailyDollarVolume,
					market, events: day.events || [],
					account: {
						settledCash: settledAtOpen - spentToday, riskBudget: budget, rewardRisk: account.rewardRisk,
						costs: account.costs, allowFractional: account.allowFractional, tradesToday, maxTradesPerDay: account.maxTradesPerDay, accountValue: cash,
					},
					previous: s.previous, params: p,
				});
				const changed = result.status !== s.previous?.status;
				s.previous = { status: result.status, confirmed: result.confirmed || s.previous?.confirmed || null, reason: result.reason };
				if (result.status === strategy.STATUS.EXIT_INVALIDATED) s.done = true;
				if (result.status !== strategy.STATUS.ENTRY_CONFIRMED || !changed || !result.sizing?.ok) continue;
				confirmations += 1;
				// Fill on the next candle's open, if it opens inside the chase limit.
				const next = bars.find((b) => b.t >= asOf);
				const plan = result.sizing;
				if (!next) continue;
				const slip = account.costs.slippage_per_share || 0;
				const halfSpread = (next.o * p.modelSpreadPct) / 2;
				const fill = next.o + slip + halfSpread;
				if (fill > plan.entry + p.maxChaseR * plan.risk_per_share || next.o <= plan.stop) {
					missed.push({ symbol, date: day.date, at: new Date(next.t).toISOString(), planned_entry: plan.entry, next_open: ind.round(next.o), reason: next.o <= plan.stop ? "opened below the stop" : "opened past the chase limit" });
					s.done = true;
					continue;
				}
				s.position = {
					symbol, date: day.date, setup_type: strategy.STRATEGY_KEY, regime: market.spy?.above_vwap && market.qqq?.above_vwap ? "bullish" : "mixed",
					shares: plan.shares, entry: fill, entry_at: new Date(next.t).toISOString(), planned_entry: plan.entry, stop: plan.stop, target: plan.target,
					planned_risk: plan.shares * (plan.entry - plan.stop), entered_bar: next.t, slip, halfSpread,
				};
				spentToday += plan.shares * fill;
				tradesToday += 1;
				s.done = true; // one setup per symbol per day
			}
		}
		// Anything still open is closed at the flat time.
		for (const s of Object.values(state)) {
			if (s.position) {
				manage(s, s.data.bars, flatAt + ind.MINUTE, flatAt, true);
				if (s.position?.closed) {
					trades.push(s.position);
					cash += s.position.pl;
				}
			}
		}
	}

	const rows = trades.map((t) => ({ ...t, r: t.planned_risk ? t.pl / t.planned_risk : null }));
	return {
		metrics: {
			...analytics.stats(rows),
			confirmations,
			missed_fills: missed.length,
			ending_cash: Math.round(cash * 100) / 100,
			days: days.length,
		},
		by_regime: analytics.groupBy(rows, "regime"),
		trades: rows.map(({ entered_bar, slip, halfSpread, closed, ...t }) => ({ ...t, entry: ind.round(t.entry), exit: ind.round(t.exit) })),
		missed,
	};

	function manage(s, bars, asOf, flat, forceFlat = false) {
		const pos = s.position;
		const closedNow = bars.filter((b) => b.t >= pos.entered_bar && b.t + ind.MINUTE <= asOf && !pos.seen?.has(b.t));
		pos.seen = pos.seen || new Set();
		for (const b of closedNow) {
			pos.seen.add(b.t);
			let exit = null;
			let reason = null;
			if (b.o <= pos.stop) [exit, reason] = [b.o - pos.slip - pos.halfSpread, "stop"];
			else if (b.l <= pos.stop) [exit, reason] = [pos.stop - pos.slip - pos.halfSpread, "stop"];
			else if (b.h >= pos.target) [exit, reason] = [pos.target, "target"];
			else if (b.t + ind.MINUTE > flat || forceFlat) [exit, reason] = [b.c - pos.slip - pos.halfSpread, "end_of_day"];
			if (exit !== null) return close(pos, exit, reason, b.t + ind.MINUTE);
		}
		if (forceFlat) {
			const lastBar = bars.filter((b) => b.t < asOf).pop();
			if (lastBar) close(pos, lastBar.c - pos.slip - pos.halfSpread, "end_of_day", lastBar.t + ind.MINUTE);
		}
	}

	function close(pos, exit, reason, at) {
		const fees = estimateFees(pos.shares, exit, account.costs);
		Object.assign(pos, { exit, exit_reason: reason, exit_at: new Date(at).toISOString(), fees, pl: pos.shares * (exit - pos.entry) - fees, closed: true });
		delete pos.seen;
	}

	function openRisk(state) {
		return Object.values(state).reduce((sum, s) => sum + (s.position ? s.position.planned_risk : 0), 0);
	}
}

/** Split an ordered list of ET dates into development / validation / out-of-sample. */
function splitDates(dates, fractions = [0.6, 0.2, 0.2]) {
	const n = dates.length;
	const a = Math.floor(n * fractions[0]);
	const b = a + Math.floor(n * fractions[1]);
	return { development: dates.slice(0, a), validation: dates.slice(a, b), out_of_sample: dates.slice(b) };
}

module.exports = { run, splitDates, marketAt };
