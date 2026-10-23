/**
 * Market scanner: from Alpaca's most-active and top-gainer lists, the few
 * liquid, affordable names worth watching today. A high score means "worth
 * watching", never "worth buying" — the strategy decides that, later, from
 * closed candles.
 *
 * Long-only, so losers are not scanned. Every number comes from a snapshot;
 * a symbol missing a figure is skipped, not estimated.
 */

const alpaca = require("./alpaca");
const ind = require("./indicators");

const SCAN_DEFAULTS = Object.freeze({
	top: 5,
	minPrice: 5,
	minPrevDollarVolume: 20_000_000,
	maxSpreadPct: 0.004,
	minGapPct: 0.01,
	maxCandidates: 60,
	// Score weights (documented in docs/architecture/trading.md).
	weights: { volumePace: 2, gap: 1.5, relStrength: 1.5, aboveVwap: 1, catalyst: 1, spread: 1 },
});

// Ordinary listed common stock: 1–5 letters. Skips units, warrants, preferreds.
const PLAIN = /^[A-Z]{1,5}$/;
// Not a common stock, by name: ETFs, ETNs, leveraged/inverse products, and
// warrants, rights and units (BGLWW passes the ticker check). The plan
// trades equities with no leverage; a 3× ETF is leverage in a wrapper. Names
// come from Alpaca's asset list; one without a name is kept out too, since we
// can't tell what it is.
const FUND = /\b(ETFs?|ETNs?|ETP|fund|proshares|direxion|ishares|spdr|graniteshares|roundhill|grayscale|leveraged?|inverse|[1-9]x|warrants?|rights?|units?)\b/i;

function isFundName(name) {
	return !name || FUND.test(name);
}

/** The fraction of a normal day's volume typically traded by `minutesIn` (a U-shaped intraday profile, roughly). */
function expectedVolumeFraction(minutesIn) {
	if (minutesIn <= 0) return 0.02; // premarket: a sliver of a day
	const x = Math.min(1, minutesIn / 390);
	// Heavy first hour, heavy close: x^0.6 front-loads the curve.
	return Math.max(0.05, x ** 0.6);
}

/**
 * Score one snapshot. Returns null if a required figure is missing or the
 * symbol fails a hard filter (with the reason, for the audit trail).
 */
function scoreSnapshot(snap, { spyChange, minutesIn, settledCash, params, hasCatalyst }) {
	const p = { ...SCAN_DEFAULTS, ...params };
	const price = snap.trade?.p;
	const prevClose = snap.prevDaily?.c;
	const prevDollar = snap.prevDaily ? snap.prevDaily.c * snap.prevDaily.v : null;
	const q = snap.quote;
	if (!price || !prevClose || !q?.bid || !q?.ask) return { skip: "missing price, previous close or quote" };
	if (price < p.minPrice) return { skip: `price under $${p.minPrice}` };
	if (settledCash !== null && price > settledCash) return { skip: "one share costs more than settled cash" };
	if (prevDollar !== null && prevDollar < p.minPrevDollarVolume) return { skip: "thin prior-day dollar volume" };
	const spreadPct = (q.ask - q.bid) / ((q.ask + q.bid) / 2);
	if (!(spreadPct >= 0) || spreadPct > p.maxSpreadPct) return { skip: `spread ${(spreadPct * 100).toFixed(2)}%` };

	const change = ind.change(prevClose, price);
	const gap = snap.daily?.o && minutesIn > 0 ? ind.change(prevClose, snap.daily.o) : change;
	const relStrength = spyChange === null ? null : change - spyChange;
	const aboveVwap = snap.daily?.vw ? price > snap.daily.vw : null;
	const volumePace = snap.daily?.v && snap.prevDaily?.v ? snap.daily.v / (snap.prevDaily.v * expectedVolumeFraction(minutesIn)) : null;
	if (change <= 0) return { skip: "not up on the day (long-only)" };
	if (Math.abs(gap) < p.minGapPct && (volumePace ?? 0) < 1.5) return { skip: "no gap and no unusual volume" };

	const w = p.weights;
	const score =
		w.volumePace * Math.min(4, volumePace ?? 0) / 2 +
		w.gap * Math.min(0.15, Math.abs(gap)) * 20 +
		w.relStrength * Math.max(-0.05, Math.min(0.1, relStrength ?? 0)) * 20 +
		w.aboveVwap * (aboveVwap ? 1 : 0) +
		w.catalyst * (hasCatalyst ? 1 : 0) -
		w.spread * spreadPct * 500;

	const reasons = [];
	if (volumePace !== null) reasons.push(`volume pace ${volumePace.toFixed(1)}× a typical day so far`);
	reasons.push(`${gap >= 0 ? "gapped" : "opened"} ${(gap * 100).toFixed(1)}% vs prior close`);
	if (relStrength !== null) reasons.push(`${relStrength >= 0 ? "outperforming" : "lagging"} SPY by ${(Math.abs(relStrength) * 100).toFixed(1)} pts`);
	if (aboveVwap !== null) reasons.push(aboveVwap ? "above VWAP" : "below VWAP");
	if (hasCatalyst) reasons.push("news in the last day");
	return {
		symbol: snap.symbol, score: ind.round(score, 3), reasons,
		metrics: { price, change: ind.round(change, 5), gap: ind.round(gap, 5), rel_strength_spy: ind.round(relStrength, 5), above_vwap: aboveVwap, volume_pace: ind.round(volumePace, 2), spread_pct: ind.round(spreadPct, 5), prev_dollar_volume: prevDollar && Math.round(prevDollar) },
	};
}

/**
 * Run the scan. Returns { ranked, skipped, source_partial, scanned_at }.
 * `extraSymbols` are always considered (the person's manual adds).
 */
async function scan({ feed, minutesIn, settledCash, spyChange, extraSymbols = [], params = {} }) {
	const p = { ...SCAN_DEFAULTS, ...params };
	const list = await alpaca.screener({ top: 50 });
	const universe = [...new Set([...list.symbols, ...extraSymbols])].filter((s) => PLAIN.test(s)).slice(0, p.maxCandidates);
	const snaps = universe.length ? (await alpaca.snapshots(universe, { feed })).data : {};
	const since = new Date(Date.now() - 24 * 3600_000).toISOString();
	const headlines = universe.length ? await alpaca.news(universe, { since, limit: 50 }).catch(() => []) : [];
	const withNews = new Set(headlines.flatMap((n) => n.symbols));

	const ranked = [];
	const skipped = [];
	for (const sym of universe) {
		const snap = snaps[sym];
		if (!snap) {
			skipped.push({ symbol: sym, reason: "no snapshot" });
			continue;
		}
		const r = scoreSnapshot(snap, { spyChange, minutesIn, settledCash, params: p, hasCatalyst: withNews.has(sym) });
		if (r.skip) skipped.push({ symbol: sym, reason: r.skip });
		else ranked.push({ ...r, catalyst: headlines.find((n) => n.symbols.includes(sym)) || null });
	}
	ranked.sort((a, b) => b.score - a.score);
	// Names are looked up only for the candidates that passed, best first.
	const kept = [];
	for (const r of ranked) {
		if (kept.length >= p.top) break;
		const asset = await alpaca.assetName(r.symbol);
		if (isFundName(asset.name)) skipped.push({ symbol: r.symbol, reason: asset.name ? `not a common stock (${asset.name})` : "unknown security type" });
		else if (asset.tradable === false) skipped.push({ symbol: r.symbol, reason: "not tradable" });
		else kept.push({ ...r, company_name: asset.name });
	}
	return { ranked: kept, considered: ranked.length, skipped, source_partial: list.partial, scanned_at: new Date().toISOString() };
}

module.exports = { SCAN_DEFAULTS, scan, scoreSnapshot, expectedVolumeFraction, isFundName };
