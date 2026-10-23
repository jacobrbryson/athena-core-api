/**
 * Alpaca Market Data (docs.alpaca.markets) — the licensed source for every
 * price, candle, quote and headline the trading module shows. Nothing is ever
 * synthesized here: a missing figure stays missing and is reported as such.
 *
 * Keys are app-level secrets (services/secrets): ALPACA_API_KEY_ID and
 * ALPACA_API_SECRET_KEY, from an Alpaca account (a paper account's keys work
 * for data). ALPACA_DATA_FEED picks the feed:
 *   iex          free plan, real-time, but only the IEX exchange (~2–3% of
 *                volume). Fine to watch with; strategy.js won't confirm on it.
 *   sip          Algo Trader Plus ($99/mo): every U.S. exchange, real-time.
 *   delayed_sip  free, full-market, 15 minutes late. Never confirms.
 * Historical bars older than 15 minutes are SIP on every plan, which is what
 * backtests use.
 *
 * This module only reads market data. It holds no trading endpoint and can't
 * place an order: the only non-data path is the read-only assets/calendar API.
 */

const secrets = require("../secrets");

const DATA_BASE = "https://data.alpaca.markets";
const TRADING_BASE = "https://paper-api.alpaca.markets"; // assets + calendar only (read)
const STREAM_BASE = "wss://stream.data.alpaca.markets/v2";
const SOURCE = "alpaca";

function fail(message, code = "provider_error", extra = {}) {
	return Object.assign(new Error(message), { code, ...extra });
}

async function credentials() {
	const [key, secret, feed] = await Promise.all([
		secrets.getSecret("ALPACA_API_KEY_ID").catch(() => null),
		secrets.getSecret("ALPACA_API_SECRET_KEY").catch(() => null),
		secrets.getSecret("ALPACA_DATA_FEED", { optional: true }).catch(() => null),
	]);
	if (!key || !secret) throw fail("Market data isn't configured (no Alpaca key).", "not_configured");
	const f = String(feed || "iex").toLowerCase();
	return { key, secret, feed: ["iex", "sip", "delayed_sip"].includes(f) ? f : "iex" };
}

async function configured() {
	try {
		const c = await credentials();
		return { configured: true, feed: c.feed };
	} catch {
		return { configured: false, feed: null };
	}
}

async function get(base, path, query = {}) {
	const { key, secret } = await credentials();
	const url = new URL(path, base);
	for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
	const res = await fetch(url, { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
	if (res.status === 429) throw fail("Alpaca rate limit", "rate_limited", { providerStatus: 429 });
	if (res.status === 401 || res.status === 403) throw fail("Alpaca refused the key", "unauthorized", { providerStatus: res.status });
	if (!res.ok) throw fail(`Alpaca ${res.status}`, "provider_error", { providerStatus: res.status });
	return res.json();
}

const toBar = (b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw ?? null, n: b.n ?? null });

/** Multi-symbol candles, all pages. { SYM: [bar] } with t as epoch ms. */
async function bars(symbols, { timeframe = "1Min", start, end, feed } = {}) {
	const out = Object.fromEntries(symbols.map((s) => [s, []]));
	if (!symbols.length) return out;
	const useFeed = feed || (await credentials()).feed;
	let page;
	for (let i = 0; i < 40; i++) {
		const body = await get(DATA_BASE, "/v2/stocks/bars", {
			symbols: symbols.join(","), timeframe, start, end, limit: 10000, adjustment: "raw", feed: useFeed, page_token: page, sort: "asc",
		});
		for (const [sym, list] of Object.entries(body.bars || {})) (out[sym] ||= []).push(...list.map(toBar));
		page = body.next_page_token;
		if (!page) break;
	}
	return out;
}

/** Latest trade, quote, minute and daily bars per symbol. */
async function snapshots(symbols, { feed } = {}) {
	if (!symbols.length) return {};
	const useFeed = feed || (await credentials()).feed;
	const body = await get(DATA_BASE, "/v2/stocks/snapshots", { symbols: symbols.join(","), feed: useFeed });
	const map = body.snapshots || body;
	const out = {};
	for (const [sym, s] of Object.entries(map || {})) {
		if (!s) continue;
		out[sym] = {
			symbol: sym,
			trade: s.latestTrade ? { p: s.latestTrade.p, t: Date.parse(s.latestTrade.t) } : null,
			quote: s.latestQuote ? quoteOf(s.latestQuote) : null,
			minute: s.minuteBar ? toBar(s.minuteBar) : null,
			daily: s.dailyBar ? toBar(s.dailyBar) : null,
			prevDaily: s.prevDailyBar ? toBar(s.prevDailyBar) : null,
		};
	}
	return { feed: useFeed, data: out };
}

const quoteOf = (q) => ({ bid: q.bp, ask: q.ap, bid_size: q.bs, ask_size: q.as, t: Date.parse(q.t) });

/** Latest quotes only (cheaper than snapshots). */
async function latestQuotes(symbols, { feed } = {}) {
	if (!symbols.length) return {};
	const useFeed = feed || (await credentials()).feed;
	const body = await get(DATA_BASE, "/v2/stocks/quotes/latest", { symbols: symbols.join(","), feed: useFeed });
	return Object.fromEntries(Object.entries(body.quotes || {}).map(([s, q]) => [s, quoteOf(q)]));
}

/** Screener: today's most active by volume, and top movers. Symbols only; snapshots supply the numbers. */
async function screener({ top = 50 } = {}) {
	const [active, movers] = await Promise.all([
		get(DATA_BASE, "/v1beta1/screener/stocks/most-actives", { by: "volume", top }).catch((e) => ({ error: e })),
		get(DATA_BASE, "/v1beta1/screener/stocks/movers", { top }).catch((e) => ({ error: e })),
	]);
	const symbols = new Set();
	for (const a of active.most_actives || []) symbols.add(a.symbol);
	for (const g of movers.gainers || []) symbols.add(g.symbol);
	return { symbols: [...symbols], updated_at: active.last_updated || movers.last_updated || null, partial: !!(active.error || movers.error) };
}

/** Recent headlines (Benzinga via Alpaca), newest first. */
async function news(symbols, { since, limit = 50 } = {}) {
	if (!symbols.length) return [];
	const body = await get(DATA_BASE, "/v1beta1/news", { symbols: symbols.join(","), start: since, limit, sort: "desc" });
	return (body.news || []).map((n) => ({
		id: n.id, headline: n.headline, summary: n.summary || null, source: n.source || null, url: n.url || null,
		symbols: n.symbols || [], created_at: n.created_at, updated_at: n.updated_at || null,
	}));
}

const nameCache = new Map();
/** Company name from the assets list; null if unknown. */
async function assetName(symbol) {
	if (nameCache.has(symbol)) return nameCache.get(symbol);
	try {
		const a = await get(TRADING_BASE, `/v2/assets/${encodeURIComponent(symbol)}`);
		const info = { name: a.name || null, exchange: a.exchange || null, tradable: a.tradable !== false, status: a.status || null };
		nameCache.set(symbol, info);
		return info;
	} catch {
		return { name: null, exchange: null, tradable: null, status: null };
	}
}

/** Alpaca's market calendar for one date: { open, close } in ET "HH:MM", or null if closed. */
async function calendarDay(date) {
	const list = await get(TRADING_BASE, "/v2/calendar", { start: date, end: date });
	const day = (Array.isArray(list) ? list : []).find((d) => d.date === date);
	return day ? { open: day.open, close: day.close } : null;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * One WebSocket per process (Alpaca's free plan allows one). Holds the latest
 * quote and the closed minute bars it has seen, reconnects with backoff, and
 * reports when it last heard anything so callers can tell live from stale.
 * REST remains the source of truth for history: a reconnect never "fills in"
 * a gap from memory — the engine re-reads bars over REST.
 */
function createStream({ WebSocket = require("ws"), onBar } = {}) {
	const state = { socket: null, status: "idle", wanted: new Set(), subscribed: new Set(), quotes: new Map(), lastMessageAt: 0, attempts: 0, feed: null, error: null, timer: null };

	async function connect() {
		if (state.socket || state.status === "stopped") return;
		if (state.status === "idle-stopped") state.status = "idle";
		let creds;
		try {
			creds = await credentials();
		} catch (err) {
			state.status = "not_configured";
			state.error = err.message;
			return;
		}
		state.feed = creds.feed;
		state.status = "connecting";
		const ws = new WebSocket(`${STREAM_BASE}/${creds.feed}`);
		state.socket = ws;
		ws.on("message", (raw) => {
			state.lastMessageAt = Date.now();
			let msgs;
			try {
				msgs = JSON.parse(raw.toString());
			} catch {
				return;
			}
			for (const m of Array.isArray(msgs) ? msgs : [msgs]) handle(m, ws, creds);
		});
		ws.on("close", () => {
			state.socket = null;
			state.subscribed.clear();
			if (state.status === "stopped" || state.status === "idle-stopped") return;
			state.status = "reconnecting";
			// 1s, 2s, 4s … capped at 60s.
			const delay = Math.min(60_000, 1000 * 2 ** state.attempts++);
			state.timer = setTimeout(connect, delay);
			state.timer.unref?.();
		});
		ws.on("error", (err) => {
			state.error = err.message;
		});
	}

	function handle(m, ws, creds) {
		if (m.T === "success" && m.msg === "connected") ws.send(JSON.stringify({ action: "auth", key: creds.key, secret: creds.secret }));
		else if (m.T === "success" && m.msg === "authenticated") {
			state.status = "live";
			state.attempts = 0;
			syncSubscriptions();
		} else if (m.T === "error") {
			state.error = `${m.code}: ${m.msg}`;
			// 402 auth failed / 406 connection limit: stop hammering; REST still works.
			if ([401, 402, 404, 406, 409].includes(m.code)) {
				state.status = "stopped";
				state.stoppedAt = Date.now();
				try {
					ws.close();
				} catch {}
			}
		} else if (m.T === "q") state.quotes.set(m.S, { bid: m.bp, ask: m.ap, bid_size: m.bs, ask_size: m.as, t: Date.parse(m.t) });
		else if (m.T === "b") onBar?.(m.S, toBar(m));
		else if (m.T === "subscription") state.subscribed = new Set([...(m.quotes || [])]);
	}

	function syncSubscriptions() {
		const ws = state.socket;
		if (!ws || state.status !== "live") return;
		const add = [...state.wanted].filter((s) => !state.subscribed.has(s));
		const drop = [...state.subscribed].filter((s) => !state.wanted.has(s));
		if (add.length) ws.send(JSON.stringify({ action: "subscribe", quotes: add, bars: add }));
		if (drop.length) ws.send(JSON.stringify({ action: "unsubscribe", quotes: drop, bars: drop }));
	}

	return {
		/** Symbols to follow; the free plan caps this at 30. */
		want(symbols) {
			state.wanted = new Set([...symbols].slice(0, 30));
			// After a refusal, wait five minutes before trying again.
			if (state.status === "stopped" && state.stoppedAt && Date.now() - state.stoppedAt > 300_000) state.status = "idle";
			if (!state.socket) connect();
			else syncSubscriptions();
		},
		quote(symbol) {
			return state.quotes.get(symbol) || null;
		},
		info() {
			return { status: state.status, feed: state.feed, last_message_at: state.lastMessageAt ? new Date(state.lastMessageAt).toISOString() : null, symbols: [...state.wanted], error: state.error };
		},
		stop() {
			state.status = "idle-stopped";
			clearTimeout(state.timer);
			try {
				state.socket?.close();
			} catch {}
			state.socket = null;
		},
		_state: state,
	};
}

module.exports = { SOURCE, configured, credentials, bars, snapshots, latestQuotes, screener, news, assetName, calendarDay, createStream };
