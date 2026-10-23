/**
 * Indicator math over candles. Pure functions, no I/O, so the live engine,
 * the backtester and signal replay compute exactly the same numbers.
 *
 * A bar is { t, o, h, l, c, v, vw? } where t is the bar's START in epoch ms.
 * Nothing here looks at an unfinished bar: callers pass closedBars() output,
 * and every function only reads bars at or before the index it reports on.
 */

const MINUTE = 60_000;

/** Bars whose interval has fully elapsed at `asOf`. */
function closedBars(bars, asOf, timeframeMs = MINUTE) {
	return bars.filter((b) => b.t + timeframeMs <= asOf);
}

/** Bars with start in [from, to). */
function between(bars, from, to) {
	return bars.filter((b) => b.t >= from && b.t < to);
}

/** Aggregate 1-minute bars into N-minute bars aligned to `anchor` (the session open). */
function aggregate(bars, minutes, anchor) {
	const size = minutes * MINUTE;
	const out = [];
	let cur = null;
	for (const b of bars) {
		const bucket = anchor + Math.floor((b.t - anchor) / size) * size;
		if (!cur || cur.t !== bucket) {
			if (cur) out.push(finish(cur));
			cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: 0, pv: 0, n: 0 };
		}
		cur.h = Math.max(cur.h, b.h);
		cur.l = Math.min(cur.l, b.l);
		cur.c = b.c;
		cur.v += b.v;
		cur.pv += (b.vw ?? typical(b)) * b.v;
		cur.n += 1;
	}
	if (cur) out.push(finish(cur));
	return out;
}

function finish(cur) {
	const { pv, n, ...bar } = cur;
	return { ...bar, vw: bar.v ? pv / bar.v : bar.c, minutes: n };
}

function typical(b) {
	return (b.h + b.l + b.c) / 3;
}

/**
 * Session VWAP after each bar: cumulative Σ(price·volume)/Σvolume from the
 * open. Each bar's price is its own VWAP when the feed supplies one (Alpaca's
 * `vw`), else (high+low+close)/3. Bars with zero volume carry the last value.
 */
function vwapSeries(bars) {
	let pv = 0;
	let vol = 0;
	const out = [];
	for (const b of bars) {
		pv += (b.vw ?? typical(b)) * b.v;
		vol += b.v;
		out.push(vol ? pv / vol : out.length ? out[out.length - 1] : b.c);
	}
	return out;
}

/**
 * VWAP slope over the last `lookback` values, as a fraction of price:
 * (vwap_now − vwap_then) / vwap_now. Null without enough history.
 */
function vwapSlope(series, lookback) {
	if (series.length <= lookback) return null;
	const now = series[series.length - 1];
	const then = series[series.length - 1 - lookback];
	return now ? (now - then) / now : null;
}

/** Opening range from session bars in [open, open + minutes). Complete only when every minute is in. */
function openingRange(sessionBars, openAt, minutes) {
	const end = openAt + minutes * MINUTE;
	const inRange = sessionBars.filter((b) => b.t >= openAt && b.t < end);
	if (!inRange.length) return null;
	return {
		high: Math.max(...inRange.map((b) => b.h)),
		low: Math.min(...inRange.map((b) => b.l)),
		volume: inRange.reduce((s, b) => s + b.v, 0),
		bars: inRange.length,
		complete: inRange.length >= minutes || sessionBars.some((b) => b.t >= end),
		ends_at: end,
	};
}

/** Average true range of the last `n` bars (simple mean). */
function atr(bars, n = 14) {
	if (bars.length < 2) return null;
	const trs = [];
	for (let i = 1; i < bars.length; i++) {
		const b = bars[i];
		const prev = bars[i - 1].c;
		trs.push(Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev)));
	}
	const tail = trs.slice(-n);
	return tail.reduce((s, x) => s + x, 0) / tail.length;
}

/**
 * Confirmed swing lows: bar i whose low is below the `strength` bars on each
 * side. The right-hand bars must already be closed, so a pivot is only known
 * `strength` bars after it happens — that delay is the price of no look-ahead.
 */
function swingLows(bars, strength = 2) {
	const out = [];
	for (let i = strength; i < bars.length - strength; i++) {
		const low = bars[i].l;
		let pivot = true;
		for (let k = 1; k <= strength && pivot; k++) {
			if (!(low < bars[i - k].l) || !(low <= bars[i + k].l)) pivot = false;
		}
		if (pivot) out.push({ t: bars[i].t, low, index: i });
	}
	return out;
}

/** Confirmed swing highs, the mirror of swingLows. */
function swingHighs(bars, strength = 2) {
	const out = [];
	for (let i = strength; i < bars.length - strength; i++) {
		const high = bars[i].h;
		let pivot = true;
		for (let k = 1; k <= strength && pivot; k++) {
			if (!(high > bars[i - k].h) || !(high >= bars[i + k].h)) pivot = false;
		}
		if (pivot) out.push({ t: bars[i].t, high, index: i });
	}
	return out;
}

/** Total volume of bars that started before `until`. */
function cumulativeVolume(bars, until) {
	return bars.reduce((s, b) => (b.t < until ? s + b.v : s), 0);
}

/**
 * Relative volume at the same time of day: today's cumulative volume since the
 * open divided by the mean cumulative volume to the same minute on prior days.
 * `history` is one number per prior day. Null when there is no baseline.
 */
function relativeVolume(todayCumulative, history) {
	const usable = history.filter((x) => Number.isFinite(x) && x > 0);
	if (!usable.length) return null;
	const mean = usable.reduce((s, x) => s + x, 0) / usable.length;
	return mean ? todayCumulative / mean : null;
}

/** Percent change from a reference price, as a fraction. */
function change(from, to) {
	return from ? (to - from) / from : null;
}

function round(x, dp = 4) {
	if (x === null || x === undefined || !Number.isFinite(x)) return null;
	const f = 10 ** dp;
	return Math.round(x * f) / f;
}

module.exports = {
	MINUTE,
	closedBars,
	between,
	aggregate,
	vwapSeries,
	vwapSlope,
	openingRange,
	atr,
	swingLows,
	swingHighs,
	cumulativeVolume,
	relativeVolume,
	change,
	round,
};
