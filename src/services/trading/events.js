/**
 * Scheduled high-impact events that can invalidate an intraday setup.
 *
 * Coverage is deliberately stated, not implied: the built-in table carries the
 * Federal Reserve's published 2026 FOMC statement times (2:00 PM ET). CPI,
 * jobs-report and earnings dates are NOT built in — no free source this
 * integration uses publishes them reliably — so `coverage()` says so and the
 * dashboard shows it. Extra events (a CPI morning, an earnings date) can be
 * supplied with the TRADING_EXTRA_EVENTS secret as JSON:
 *   [{"date":"2026-11-12","time":"08:30","name":"CPI","impact":"high"}]
 * An event at 08:30 matters for the open even though it is before it.
 */

const secrets = require("../secrets");
const { etToUtc, hhmm } = require("./marketClock");

const FOMC_2026 = ["2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09"];

const BUILT_IN = FOMC_2026.map((date) => ({ date, time: "14:00", name: "FOMC rate decision", impact: "high", source: "federalreserve.gov schedule" }));

let extraCache = { at: 0, list: [] };

async function extraEvents() {
	if (Date.now() - extraCache.at < 10 * 60_000) return extraCache.list;
	let list = [];
	try {
		const raw = await secrets.getSecret("TRADING_EXTRA_EVENTS").catch(() => null);
		const parsed = raw ? JSON.parse(raw) : [];
		list = (Array.isArray(parsed) ? parsed : [])
			.filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e?.date) && /^\d{1,2}:\d{2}$/.test(e?.time) && e?.name)
			.map((e) => ({ date: e.date, time: e.time, name: String(e.name).slice(0, 80), impact: e.impact === "medium" ? "medium" : "high", source: "owner list" }));
	} catch (err) {
		console.warn("[trading] TRADING_EXTRA_EVENTS is not valid JSON:", err.message);
	}
	extraCache = { at: Date.now(), list };
	return list;
}

/** Events on an ET date, each with its UTC instant. */
async function eventsOn(date) {
	const all = [...BUILT_IN, ...(await extraEvents())].filter((e) => e.date === date);
	return all.map((e) => ({ ...e, at: etToUtc(e.date, hhmm(e.time)).toISOString() })).sort((a, b) => a.at.localeCompare(b.at));
}

/** What the calendar covers, for the dashboard's honesty line. */
function coverage() {
	return "FOMC decisions built in; CPI, jobs and earnings dates only if added to the owner's event list";
}

module.exports = { BUILT_IN, eventsOn, coverage };
