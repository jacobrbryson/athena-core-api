/**
 * After the fact: what happened to each signal, measured from the stored
 * candles of its own day. Written into the signal's outcome_* columns, never
 * into its events — the original assessment stays exactly as it was made.
 *
 * Confirmed signals use their confirmed entry, stop and target. Signals that
 * never confirmed get a hypothetical long at the first price after the
 * opening range, with the opening-range low as the stop and a 2R target —
 * the answer to "how often did the setups I passed on work anyway?".
 * Run nightly (jobs/nightly.js → tradingOutcomes) and again with retention.
 */

const store = require("./store");
const clock = require("./marketClock");
const ind = require("./indicators");
const strategy = require("./strategy");
const pool = require("../../helpers/db");

const FLAT_MIN = 15 * 60 + 55;
const HYPOTHETICAL_R = 2;

/** Pure: walk candles after `from` until stop, target or the flat time. */
function measure(bars, { entry, stop, target, from, flatAt }) {
	const risk = entry - stop;
	if (!(risk > 0)) return { outcome: "no_trigger", r: null, mfe_r: null, mae_r: null };
	let mfe = 0;
	let mae = 0;
	let last = null;
	for (const b of bars) {
		if (b.t < from || b.t >= flatAt) continue;
		last = b;
		mfe = Math.max(mfe, (b.h - entry) / risk);
		mae = Math.min(mae, (b.l - entry) / risk);
		// A candle touching both counts as the stop: we can't know the order inside it.
		if (b.l <= stop) return { outcome: "stop_first", r: -1, mfe_r: ind.round(mfe, 3), mae_r: ind.round(mae, 3) };
		if (b.h >= target) return { outcome: "target_first", r: ind.round((target - entry) / risk, 3), mfe_r: ind.round(mfe, 3), mae_r: ind.round(mae, 3) };
	}
	if (!last) return { outcome: "no_trigger", r: null, mfe_r: null, mae_r: null };
	return { outcome: "neither", r: ind.round((last.c - entry) / risk, 3), mfe_r: ind.round(mfe, 3), mae_r: ind.round(mae, 3) };
}

async function measureAll({ before = clock.etParts().date } = {}) {
	const pending = await store.unmeasuredSignals(before);
	let measured = 0;
	for (const s of pending) {
		const session = clock.sessionFor(s.session_date);
		if (!session.trading) continue;
		const open = Date.parse(session.open_at);
		const flatAt = Math.min(Date.parse(session.close_at), clock.etToUtc(s.session_date, FLAT_MIN).getTime());
		const bars = await store.candles(s.symbol, { feed: s.feed, from: open, to: Date.parse(session.close_at) });
		if (!bars.length) {
			await store.setOutcome(s.id, { outcome: "no_trigger", r: null, mfe_r: null, mae_r: null });
			continue;
		}
		let o;
		if (s.ever_confirmed) {
			o = measure(bars, { entry: s.confirmed_entry, stop: s.confirmed_stop, target: s.confirmed_target, from: Date.parse(s.confirmed_at) + 60_000, flatAt });
		} else {
			const orEnd = open + strategy.DEFAULT_PARAMS.openingRangeMinutes * 60_000;
			const range = bars.filter((b) => b.t < orEnd);
			const startAt = Math.max(orEnd, s.first_at ? Date.parse(s.first_at) : orEnd);
			const entryBar = ind.closedBars(bars, startAt).pop();
			if (!range.length || !entryBar) o = { outcome: "no_trigger", r: null, mfe_r: null, mae_r: null };
			else {
				const stop = Math.min(...range.map((b) => b.l));
				const entry = entryBar.c;
				o = measure(bars, { entry, stop, target: entry + HYPOTHETICAL_R * (entry - stop), from: entryBar.t + 60_000, flatAt });
			}
		}
		await store.setOutcome(s.id, o);
		measured += 1;
	}
	return { pending: pending.length, measured };
}

/**
 * Retention: candles and symbol snapshots are kept TRADING_RETENTION_DAYS
 * (default 400) so a year of signals can be replayed; market snapshots, which
 * are only context, for 90. Alpaca's terms allow storing data for one's own
 * use; nothing here redistributes it.
 */
async function prune({ days = Number(process.env.TRADING_RETENTION_DAYS) || 400 } = {}) {
	const [c] = await pool.query("DELETE FROM trading_candles WHERE bar_start < UTC_TIMESTAMP() - INTERVAL ? DAY LIMIT 50000", [days]);
	const [s] = await pool.query("DELETE FROM trading_market_snapshots WHERE kind = 'symbol' AND taken_at < UTC_TIMESTAMP() - INTERVAL ? DAY LIMIT 50000", [days]);
	const [m] = await pool.query("DELETE FROM trading_market_snapshots WHERE kind = 'market' AND taken_at < UTC_TIMESTAMP() - INTERVAL 90 DAY LIMIT 50000");
	return { candles: c.affectedRows, symbol_snapshots: s.affectedRows, market_snapshots: m.affectedRows };
}

/** Nightly: measure outcomes, refresh yesterday's summaries, prune. */
async function nightly() {
	const outcomes = await measureAll();
	const [profiles] = await pool.query("SELECT DISTINCT profile_id FROM trading_accounts");
	const engine = require("./engine");
	const yesterday = clock.previousTradingDay(clock.addDays(clock.etParts().date, 1));
	for (const { profile_id } of profiles) await engine.summarizeDay(profile_id, yesterday).catch(() => {});
	return { ...outcomes, retention: await prune() };
}

module.exports = { measure, measureAll, prune, nightly };
