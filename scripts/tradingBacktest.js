#!/usr/bin/env node
/**
 * Backtest the opening-range/VWAP strategy on historical 1-minute SIP candles
 * from Alpaca, split chronologically into development / validation /
 * out-of-sample periods (60/20/20), with the account's cost model.
 *
 *   node scripts/tradingBacktest.js --symbols AMD,INTC,F,PLTR,SOFI --from 2025-06-01 --to 2026-09-30
 *   … --save           store the three runs in trading_backtest_runs (writes to the DB)
 *   … --risk 4 --cash 423 --daily 8 --trades 2 --rr 2 --slippage 0.01
 *
 * Choose symbols by a rule fixed in advance (e.g. "the 10 most active under
 * $50 at the start of the period"), not by today's winners — picking names
 * that did well and testing them on their own past is survivorship bias. The
 * run records the list so a reader can judge. Results are evidence about the
 * past, never a promise; the out-of-sample figures are the ones that count.
 */

require("dotenv").config();
const alpaca = require("../src/services/trading/alpaca");
const clock = require("../src/services/trading/marketClock");
const strategy = require("../src/services/trading/strategy");
const backtest = require("../src/services/trading/backtest");
const events = require("../src/services/trading/events");

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

async function fetchDays(symbol, dates) {
	const first = clock.previousTradingDays(dates[0], 12).pop();
	const out = new Map();
	// Month by month keeps each request well inside the page limit.
	let cursor = first;
	const last = dates[dates.length - 1];
	while (cursor <= last) {
		const monthEnd = clock.addDays(`${cursor.slice(0, 7)}-01`, 40).slice(0, 7) + "-01";
		const end = monthEnd > last ? clock.addDays(last, 1) : monthEnd;
		const got = await alpaca.bars([symbol], { timeframe: "1Min", start: clock.etToUtc(cursor, 4 * 60).toISOString(), end: clock.etToUtc(end, 0).toISOString(), feed: "sip" });
		for (const b of got[symbol] || []) {
			const p = clock.etParts(b.t);
			if (p.minutes < 4 * 60 || p.minutes >= 16 * 60) continue;
			if (!out.has(p.date)) out.set(p.date, []);
			out.get(p.date).push(b);
		}
		cursor = end;
		process.stdout.write(".");
	}
	return out;
}

async function main() {
	const symbols = String(arg("symbols", "")).toUpperCase().split(",").map((s) => s.trim()).filter(Boolean);
	const from = arg("from");
	const to = arg("to");
	if (!symbols.length || !/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "")) {
		console.error("usage: node scripts/tradingBacktest.js --symbols A,B,C --from YYYY-MM-DD --to YYYY-MM-DD [--save]");
		process.exit(2);
	}
	const account = {
		startingCash: Number(arg("cash", 423)), maxRiskPerTrade: Number(arg("risk", 4)), maxDailyLoss: Number(arg("daily", 8)),
		maxTradesPerDay: Number(arg("trades", 2)), rewardRisk: Number(arg("rr", 2)), allowFractional: false,
		costs: { commission_per_order: 0, sec_fee_rate: 0.0000278, taf_fee_per_share: 0.000166, slippage_per_share: Number(arg("slippage", 0.01)) },
	};
	const dates = [];
	for (let d = from; d <= to; d = clock.addDays(d, 1)) if (clock.isTradingDay(d)) dates.push(d);
	console.log(`${dates.length} sessions, ${symbols.length} symbols, SIP 1-minute candles from Alpaca`);

	const data = {};
	for (const s of [...symbols, "SPY", "QQQ"]) {
		process.stdout.write(`${s} `);
		data[s] = await fetchDays(s, dates);
		console.log();
	}

	const regular = (date, bars) => {
		const session = clock.sessionFor(date);
		const open = Date.parse(session.open_at);
		const close = Date.parse(session.close_at);
		return { open, bars: (bars || []).filter((b) => b.t >= open && b.t < close) };
	};
	const days = [];
	for (const date of dates) {
		const session = clock.sessionFor(date);
		const priorDates = clock.previousTradingDays(date, strategy.DEFAULT_PARAMS.rvolLookbackDays);
		const syms = {};
		for (const s of symbols) {
			const bars = data[s].get(date);
			if (!bars?.length) continue;
			const priorDays = priorDates.map((d) => {
				const r = regular(d, data[s].get(d));
				return { date: d, open_at: r.open, bars: r.bars };
			}).filter((d) => d.bars.length);
			const y = priorDays[0];
			const dollar = priorDays.map((d) => d.bars.reduce((sum, b) => sum + (b.vw ?? b.c) * b.v, 0));
			syms[s] = {
				bars, priorDays,
				prevDay: y ? { h: Math.max(...y.bars.map((b) => b.h)), l: Math.min(...y.bars.map((b) => b.l)), c: y.bars[y.bars.length - 1].c } : null,
				avgDailyDollarVolume: dollar.length ? dollar.reduce((a, b) => a + b, 0) / dollar.length : null,
			};
		}
		days.push({ date, session, symbols: syms, spyBars: data.SPY.get(date) || [], qqqBars: data.QQQ.get(date) || [], events: await events.eventsOn(date) });
	}

	const split = backtest.splitDates(dates);
	const results = {};
	for (const [name, list] of Object.entries(split)) {
		if (!list.length) continue;
		const set = new Set(list);
		results[name] = { from: list[0], to: list[list.length - 1], ...backtest.run(days.filter((d) => set.has(d.date)), { account }) };
		const m = results[name].metrics;
		console.log(`\n${name.toUpperCase()} ${list[0]} → ${list[list.length - 1]} (${list.length} sessions)`);
		console.log(`  trades ${m.trades} · win rate ${m.win_rate === null ? "—" : `${(m.win_rate * 100).toFixed(1)}%`} · avg R ${m.avg_r ?? "—"} · profit factor ${m.profit_factor ?? "—"}`);
		console.log(`  net $${m.net_pl} after $${m.fees} fees · max drawdown $${m.max_drawdown} · confirmations ${m.confirmations} · missed fills ${m.missed_fills}`);
	}
	console.log("\nOnly the OUT_OF_SAMPLE period is evidence; development figures are fitted by construction.");

	if (flag("save")) {
		const store = require("../src/services/trading/store");
		const version = await store.ensureStrategyVersion(strategy.STRATEGY_KEY, strategy.DEFAULT_PARAMS, "Opening-range breakout (15 min) + VWAP trend continuation, long only, closed-candle confirmation.");
		for (const [name, r] of Object.entries(results)) {
			await store.saveBacktestRun({
				strategy_version_id: version.id, split: name, period_start: r.from, period_end: r.to, symbols, data_source: alpaca.SOURCE, feed: "sip",
				cost_model: { ...account.costs, spread_model_pct: strategy.DEFAULT_PARAMS.modelSpreadPct, account }, metrics: { ...r.metrics, by_regime: r.by_regime }, trades: { trades: r.trades, missed: r.missed }, status: "finished",
			});
		}
		console.log(`Saved ${Object.keys(results).length} runs against strategy v${version.version}.`);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
