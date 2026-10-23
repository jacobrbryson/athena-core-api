/**
 * The market-data layer the engine reads through: Alpaca REST for candles
 * (cached, fetched incrementally), the stream for live quotes, and REST quotes
 * when the stream is not live. Every value carries its own timestamp; nothing
 * is carried forward as if it were new.
 */

const alpaca = require("./alpaca");
const store = require("./store");
const clock = require("./marketClock");
const ind = require("./indicators");

const today = new Map(); // `${feed}:${symbol}:${date}` -> { bars, fetchedAt }
const prior = new Map(); // `${feed}:${symbol}:${date}` -> { days, prevDay, avgDailyDollarVolume }
let stream = null;
let lastWanted = 0;

function streamInstance() {
	if (!stream) {
		stream = alpaca.createStream({
			onBar(symbol, bar) {
				// Merge streamed bars into today's cache; REST will re-confirm them.
				for (const [key, entry] of today) {
					if (key.split(":")[1] === symbol) merge(entry.bars, [bar]);
				}
			},
		});
	}
	return stream;
}

function merge(list, incoming) {
	for (const b of incoming) {
		const i = list.findIndex((x) => x.t === b.t);
		if (i >= 0) list[i] = b;
		else list.push(b);
	}
	list.sort((a, b) => a.t - b.t);
}

/** Follow these symbols on the stream while someone is looking. */
function follow(symbols) {
	lastWanted = Date.now();
	streamInstance().want(symbols);
}

/** Stop streaming once nobody has looked for ten minutes. Called opportunistically. */
function idleCheck() {
	if (stream && lastWanted && Date.now() - lastWanted > 10 * 60_000) {
		stream.stop();
		lastWanted = 0;
	}
}

function streamInfo() {
	return stream ? stream.info() : { status: "idle", feed: null, last_message_at: null, symbols: [] };
}

/**
 * Today's 1-minute candles from 4:00 ET premarket, for several symbols.
 * Re-reads from the last cached candle so a candle that was still forming is
 * replaced by its final version. Closed candles are stored for replay.
 */
async function todayBars(symbols, date, feed) {
	const premarketStart = clock.etToUtc(date, 4 * 60).toISOString();
	const need = [];
	let start = null;
	for (const s of symbols) {
		const entry = today.get(`${feed}:${s}:${date}`);
		if (!entry || Date.now() - entry.fetchedAt > 10_000) {
			need.push(s);
			const from = entry?.bars.length ? new Date(entry.bars[entry.bars.length - 1].t).toISOString() : premarketStart;
			if (!start || from < start) start = from;
		}
	}
	if (need.length) {
		const got = await alpaca.bars(need, { timeframe: "1Min", start, feed });
		const now = Date.now();
		for (const s of need) {
			const key = `${feed}:${s}:${date}`;
			const entry = today.get(key) || { bars: [], fetchedAt: 0 };
			merge(entry.bars, got[s] || []);
			entry.fetchedAt = now;
			today.set(key, entry);
			const closed = ind.closedBars(entry.bars, now).filter((b) => b.t > (entry.savedThrough || 0));
			if (closed.length) {
				entry.savedThrough = closed[closed.length - 1].t;
				store.saveCandles(s, "1Min", feed, closed).catch((e) => console.warn("[trading] candle save failed:", e.message));
			}
		}
	}
	return Object.fromEntries(symbols.map((s) => [s, today.get(`${feed}:${s}:${date}`)?.bars || []]));
}

/**
 * Prior sessions' regular-hours candles (the relative-volume baseline), the
 * prior day's high/low/close, and average daily dollar volume. Same feed as
 * live, so relative volume compares like with like. Cached per day.
 */
async function priorSessions(symbols, date, feed, days = 10) {
	const need = symbols.filter((s) => !prior.has(`${feed}:${s}:${date}`));
	if (need.length) {
		const dates = clock.previousTradingDays(date, days);
		const start = clock.etToUtc(dates[dates.length - 1], 9 * 60 + 30).toISOString();
		const end = clock.etToUtc(dates[0], 16 * 60).toISOString();
		const got = await alpaca.bars(need, { timeframe: "1Min", start, end, feed });
		for (const s of need) {
			const byDay = dates.map((d) => {
				const session = clock.sessionFor(d);
				const open = Date.parse(session.open_at);
				const close = Date.parse(session.close_at);
				return { date: d, open_at: open, bars: (got[s] || []).filter((b) => b.t >= open && b.t < close) };
			}).filter((d) => d.bars.length);
			const last = byDay[0];
			const prevDay = last ? { h: Math.max(...last.bars.map((b) => b.h)), l: Math.min(...last.bars.map((b) => b.l)), c: last.bars[last.bars.length - 1].c } : null;
			const dollar = byDay.map((d) => d.bars.reduce((sum, b) => sum + (b.vw ?? b.c) * b.v, 0));
			prior.set(`${feed}:${s}:${date}`, {
				days: byDay, prevDay, avgDailyDollarVolume: dollar.length ? dollar.reduce((a, b) => a + b, 0) / dollar.length : null,
			});
		}
		// Keep the cache to today's entries only.
		for (const key of prior.keys()) if (!key.endsWith(`:${date}`)) prior.delete(key);
		for (const key of today.keys()) if (!key.endsWith(`:${date}`)) today.delete(key);
	}
	return Object.fromEntries(symbols.map((s) => [s, prior.get(`${feed}:${s}:${date}`) || { days: [], prevDay: null, avgDailyDollarVolume: null }]));
}

/** Latest quote per symbol: the stream's if it is live and fresher, else REST. */
async function quotes(symbols, feed) {
	const s = stream?.info().status === "live" ? stream : null;
	const out = {};
	const missing = [];
	for (const sym of symbols) {
		const q = s?.quote(sym);
		if (q && Date.now() - q.t < 15_000) out[sym] = { ...q, via: "stream" };
		else missing.push(sym);
	}
	if (missing.length) {
		const rest = await alpaca.latestQuotes(missing, { feed }).catch(() => ({}));
		for (const sym of missing) if (rest[sym]) out[sym] = { ...rest[sym], via: "rest" };
	}
	return out;
}

module.exports = { follow, idleCheck, streamInfo, todayBars, priorSessions, quotes, _caches: { today, prior } };
