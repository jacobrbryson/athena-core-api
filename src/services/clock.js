/**
 * The current date and time, stated plainly for the model.
 *
 * Without this, nothing in the system prompt says what "now" is: the calendar
 * block lists events as "Wed 2026-09-16 09:00" but never names today, so the
 * model fills the gap from its training prior and announces a confident wrong
 * date ("Since today is Monday, September 14..."). Every downstream answer that
 * depends on the day — "first appointment", "tomorrow", "this week" — inherits
 * the error while looking perfectly reasonable.
 *
 * Day boundaries follow the person's timezone, the same rule memory recall uses
 * for "yesterday" (see memoryStore/timeRange.js).
 */

const DEFAULT_TZ = process.env.ATHENA_DEFAULT_TZ || "America/New_York";

/** A usable IANA zone: the candidate if Intl accepts it, else the default. */
function resolveTimeZone(candidate) {
	for (const tz of [candidate, DEFAULT_TZ, "UTC"]) {
		if (typeof tz !== "string" || !tz.trim()) continue;
		try {
			new Intl.DateTimeFormat("en-US", { timeZone: tz });
			return tz;
		} catch {
			// Not a zone Intl knows; try the next fallback.
		}
	}
	return "UTC";
}

/**
 * Parts of `now` in `timeZone`:
 *   { weekday: "Wednesday", date: "September 16, 2026", iso: "2026-09-16",
 *     time: "3:42 PM", timeZone: "America/New_York" }
 */
function describeNow(now = new Date(), timeZone = DEFAULT_TZ) {
	const tz = resolveTimeZone(timeZone);
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			weekday: "long",
			year: "numeric",
			month: "long",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
			hour12: true,
		})
			.formatToParts(now)
			.map(({ type, value }) => [type, value])
	);
	// The ISO day has to come from the same zone, not toISOString() — at 9pm
	// Eastern the UTC date is already tomorrow.
	const ymd = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		})
			.formatToParts(now)
			.map(({ type, value }) => [type, value])
	);
	return {
		weekday: parts.weekday,
		date: `${parts.month} ${parts.day}, ${parts.year}`,
		iso: `${ymd.year}-${ymd.month}-${ymd.day}`,
		time: `${parts.hour}:${parts.minute} ${parts.dayPeriod}`,
		timeZone: tz,
	};
}

/** One short line — "Wed 2026-09-16 15:42" — to head a grounding block. */
function nowLine(now = new Date(), timeZone = DEFAULT_TZ) {
	const tz = resolveTimeZone(timeZone);
	const p = Object.fromEntries(
		new Intl.DateTimeFormat("en-GB", {
			timeZone: tz,
			weekday: "short",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		})
			.formatToParts(now)
			.map(({ type, value }) => [type, value])
	);
	const hour = p.hour === "24" ? "00" : p.hour;
	return `${p.weekday} ${p.year}-${p.month}-${p.day} ${hour}:${p.minute}`;
}

/**
 * The system-prompt block. Deliberately blunt about precedence: a model that
 * has a date in context will still override it with a remembered one unless it
 * is told not to.
 */
function buildClockBlock({ now = new Date(), timeZone = DEFAULT_TZ } = {}) {
	const n = describeNow(now, timeZone);
	return `# Right now
Today is **${n.weekday}, ${n.date}** (${n.iso}). The local time is ${n.time}, ${n.timeZone}.

This is the real current date and time. It is authoritative and it overrides
anything you believe about the date from any other source. Never guess the date,
never infer it from an event, a memory, or a previous message, and never state a
day or date that contradicts the line above. Work out "today", "tomorrow",
"this Friday", "last week" and every other relative day by counting from it.`;
}

/** Minutes `tz` is ahead of UTC at `date` (e.g. -240 for EDT). */
function tzOffsetMinutes(tz, date) {
	try {
		const local = new Date(date.toLocaleString("en-US", { timeZone: tz }));
		const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
		return Math.round((local - utc) / 60000);
	} catch {
		return 0;
	}
}

/**
 * The instant of midnight starting the calendar day that contains `date` in
 * `timeZone`. With no zone, falls back to the server's own local midnight —
 * which on Cloud Run is UTC midnight, and is why this exists.
 */
function startOfDayIn(date, timeZone) {
	if (!timeZone) {
		const local = new Date(date);
		local.setHours(0, 0, 0, 0);
		return local;
	}
	const tz = resolveTimeZone(timeZone);
	const offset = tzOffsetMinutes(tz, date);
	const shifted = new Date(date.getTime() + offset * 60000);
	const midnight = Date.UTC(
		shifted.getUTCFullYear(),
		shifted.getUTCMonth(),
		shifted.getUTCDate()
	);
	return new Date(midnight - offset * 60000);
}

/** `start` advanced by `days` CALENDAR days in `timeZone` (DST-aware). */
function addDaysIn(start, days, timeZone) {
	const guess = new Date(start.getTime() + days * 86_400_000);
	if (!timeZone) return guess;
	const tz = resolveTimeZone(timeZone);
	const drift = tzOffsetMinutes(tz, start) - tzOffsetMinutes(tz, guess);
	return new Date(guess.getTime() + drift * 60000);
}

module.exports = {
	DEFAULT_TZ,
	resolveTimeZone,
	describeNow,
	nowLine,
	buildClockBlock,
	tzOffsetMinutes,
	startOfDayIn,
	addDaysIn,
};
