/**
 * U.S. equity session clock in America/New_York, with no network dependency.
 *
 * The holiday and early-close table is NYSE's published schedule. Dates past
 * the table are treated as ordinary weekdays and flagged `calendar_verified:
 * false`, so the dashboard can say so instead of being quietly wrong about a
 * holiday nobody typed in yet. When Alpaca's calendar is reachable, the data
 * adapter cross-checks today against it (alpaca.js → calendarDay).
 */

const ET = "America/New_York";

// NYSE full-day closures.
const HOLIDAYS = new Set([
	"2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
	"2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
	"2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
	"2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
// 1:00 PM ET closes.
const EARLY_CLOSES = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);
const TABLE_THROUGH = "2027-12-31";

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const EARLY_CLOSE_MIN = 13 * 60;
const PREMARKET_MIN = 4 * 60;
const AFTERHOURS_END_MIN = 20 * 60;

const fmt = new Intl.DateTimeFormat("en-US", {
	timeZone: ET, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
	hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
});

/** { date: "2026-10-23", minutes: 585, seconds, weekday: "Fri" } for an instant, in ET. */
function etParts(at = new Date()) {
	const p = Object.fromEntries(fmt.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
	return {
		date: `${p.year}-${p.month}-${p.day}`,
		minutes: Number(p.hour) * 60 + Number(p.minute),
		seconds: Number(p.second),
		weekday: p.weekday,
	};
}

/** The UTC instant of an ET wall-clock time on an ET date. */
function etToUtc(date, minutes) {
	const [y, m, d] = date.split("-").map(Number);
	const hh = Math.floor(minutes / 60);
	const mm = minutes % 60;
	// ET is UTC-4 or UTC-5; whichever candidate reads back as the asked wall time is it.
	for (const offset of [4, 5]) {
		const guess = new Date(Date.UTC(y, m - 1, d, hh + offset, mm));
		const back = etParts(guess);
		if (back.date === date && back.minutes === minutes) return guess;
	}
	return new Date(Date.UTC(y, m - 1, d, hh + 5, mm));
}

function isWeekend(date) {
	const day = new Date(`${date}T12:00:00Z`).getUTCDay();
	return day === 0 || day === 6;
}

/** Is this ET date a trading day? */
function isTradingDay(date) {
	return !isWeekend(date) && !HOLIDAYS.has(date);
}

function addDays(date, n) {
	const d = new Date(`${date}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

/** The next trading day strictly after `date`. */
function nextTradingDay(date) {
	let d = addDays(date, 1);
	while (!isTradingDay(d)) d = addDays(d, 1);
	return d;
}

/** The trading day strictly before `date`. */
function previousTradingDay(date) {
	let d = addDays(date, -1);
	while (!isTradingDay(d)) d = addDays(d, -1);
	return d;
}

/** The last `n` trading days before `date`, newest first. */
function previousTradingDays(date, n) {
	const out = [];
	let d = date;
	while (out.length < n) {
		d = previousTradingDay(d);
		out.push(d);
	}
	return out;
}

/**
 * U.S. equities settle T+1: proceeds of a sale on `tradeDate` settle on the
 * next trading day (bank holidays that are not market holidays are not
 * modelled; Webull's own settled-cash figure is the check).
 */
function settlementDate(tradeDate) {
	return nextTradingDay(tradeDate);
}

/** Session times for an ET date, as minutes after ET midnight and as instants. */
function sessionFor(date) {
	const trading = isTradingDay(date);
	const earlyClose = EARLY_CLOSES.has(date);
	const close = earlyClose ? EARLY_CLOSE_MIN : CLOSE_MIN;
	return {
		date,
		trading,
		early_close: earlyClose,
		calendar_verified: date <= TABLE_THROUGH,
		open_min: OPEN_MIN,
		close_min: close,
		open_at: trading ? etToUtc(date, OPEN_MIN).toISOString() : null,
		close_at: trading ? etToUtc(date, close).toISOString() : null,
	};
}

/**
 * Where the market is right now: closed | premarket | open | afterhours.
 * Returns the session too, so callers don't recompute it.
 */
function phase(at = new Date()) {
	const { date, minutes } = etParts(at);
	const session = sessionFor(date);
	let name = "closed";
	if (session.trading) {
		if (minutes >= PREMARKET_MIN && minutes < OPEN_MIN) name = "premarket";
		else if (minutes >= OPEN_MIN && minutes < session.close_min) name = "open";
		else if (minutes >= session.close_min && minutes < AFTERHOURS_END_MIN) name = "afterhours";
	}
	return { phase: name, session, et_minutes: minutes, et_date: date };
}

/** "10:02 AM" in ET for an instant — what the dashboard and Athena say. */
function etClock(at) {
	return new Date(at).toLocaleTimeString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });
}

/** "HH:MM" → minutes after midnight. */
function hhmm(text) {
	const [h, m] = String(text).split(":").map(Number);
	return h * 60 + (m || 0);
}

module.exports = {
	ET,
	TABLE_THROUGH,
	etParts,
	etToUtc,
	etClock,
	hhmm,
	isTradingDay,
	nextTradingDay,
	previousTradingDay,
	previousTradingDays,
	settlementDate,
	sessionFor,
	phase,
	addDays,
};
