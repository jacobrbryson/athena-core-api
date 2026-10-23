/**
 * Performance statistics over closed positions (or backtest trades). Pure.
 * Input rows: { pl, fees, planned_risk, r, followed_plan, setup_type, regime, exit_at }.
 * Statistics describe the past; nothing here forecasts.
 */

const { etParts } = require("./marketClock");

const cents = (x) => Math.round(x * 100) / 100;
const r3 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

function stats(trades) {
	const n = trades.length;
	const wins = trades.filter((t) => t.pl > 0);
	const losses = trades.filter((t) => t.pl < 0);
	const grossWin = wins.reduce((s, t) => s + t.pl, 0);
	const grossLoss = -losses.reduce((s, t) => s + t.pl, 0);
	const net = trades.reduce((s, t) => s + t.pl, 0);
	const rs = trades.map((t) => t.r).filter((x) => Number.isFinite(x));
	const judged = trades.filter((t) => t.followed_plan === true || t.followed_plan === false);
	// Max drawdown of the cumulative P/L, in order of exit.
	let peak = 0;
	let equity = 0;
	let maxDd = 0;
	for (const t of [...trades].sort((a, b) => String(a.exit_at).localeCompare(String(b.exit_at)))) {
		equity += t.pl;
		peak = Math.max(peak, equity);
		maxDd = Math.max(maxDd, peak - equity);
	}
	return {
		trades: n,
		wins: wins.length,
		losses: losses.length,
		net_pl: cents(net),
		fees: cents(trades.reduce((s, t) => s + (t.fees || 0), 0)),
		win_rate: n ? r3(wins.length / n) : null,
		avg_win: wins.length ? cents(grossWin / wins.length) : null,
		avg_loss: losses.length ? cents(-grossLoss / losses.length) : null,
		// Undefined with no losing trade; null rather than Infinity.
		profit_factor: grossLoss ? r3(grossWin / grossLoss) : null,
		max_drawdown: cents(maxDd),
		avg_r: rs.length ? r3(rs.reduce((s, x) => s + x, 0) / rs.length) : null,
		expectancy: n ? cents(net / n) : null,
		rule_compliance: judged.length ? r3(judged.filter((t) => t.followed_plan).length / judged.length) : null,
		judged: judged.length,
	};
}

function groupBy(trades, key) {
	const groups = new Map();
	for (const t of trades) {
		const k = t[key] || "unknown";
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(t);
	}
	return [...groups].map(([k, list]) => ({ key: k, ...stats(list) }));
}

/** Cumulative P/L after each trade, for the equity curve. */
function equityCurve(trades, startingCapital = 0) {
	let equity = startingCapital;
	return [...trades]
		.sort((a, b) => String(a.exit_at).localeCompare(String(b.exit_at)))
		.map((t) => ({ at: t.exit_at, equity: cents((equity += t.pl)), pl: cents(t.pl) }));
}

/** One row per ET date: P/L and trade count, for the calendar. */
function byDay(trades) {
	const days = new Map();
	for (const t of trades) {
		const d = etParts(t.exit_at).date;
		const cur = days.get(d) || { date: d, pl: 0, trades: 0 };
		cur.pl += t.pl;
		cur.trades += 1;
		days.set(d, cur);
	}
	return [...days.values()].map((d) => ({ ...d, pl: cents(d.pl) })).sort((a, b) => a.date.localeCompare(b.date));
}

function summary(trades, { startingCapital = 0 } = {}) {
	return {
		overall: stats(trades),
		by_setup: groupBy(trades, "setup_type"),
		by_regime: groupBy(trades, "regime"),
		equity: equityCurve(trades, startingCapital),
		days: byDay(trades),
	};
}

module.exports = { stats, groupBy, equityCurve, byDay, summary };
