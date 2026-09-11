/**
 * Natural-language time ranges for recall: "yesterday", "last week",
 * "this morning", "in June", "3 days ago", "last summer", "on Tuesday".
 *
 * Returns { from: Date, to: Date, label } or null. Day boundaries are computed
 * in the user's timezone (default ATHENA_DEFAULT_TZ, America/New_York) so
 * "yesterday" at 9pm Eastern doesn't mean the UTC day.
 */

const DEFAULT_TZ = process.env.ATHENA_DEFAULT_TZ || "America/New_York";
const DAY = 86_400_000;

const MONTHS = [
	"january", "february", "march", "april", "may", "june",
	"july", "august", "september", "october", "november", "december",
];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Minutes the zone is ahead of UTC at `date` (e.g. -240 for EDT). */
function tzOffsetMinutes(tz, date) {
	try {
		const local = new Date(date.toLocaleString("en-US", { timeZone: tz }));
		const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
		return Math.round((local - utc) / 60000);
	} catch {
		return 0;
	}
}

/** UTC instant of local midnight for the local calendar day containing `date`. */
function startOfLocalDay(date, tz) {
	const offset = tzOffsetMinutes(tz, date);
	const local = new Date(date.getTime() + offset * 60000);
	const midnightLocalAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
	return new Date(midnightLocalAsUtc - offset * 60000);
}

function localParts(date, tz) {
	const local = new Date(date.getTime() + tzOffsetMinutes(tz, date) * 60000);
	return { year: local.getUTCFullYear(), month: local.getUTCMonth(), weekday: local.getUTCDay() };
}

function localDate(year, month, day, tz) {
	const guess = new Date(Date.UTC(year, month, day));
	return new Date(guess.getTime() - tzOffsetMinutes(tz, guess) * 60000);
}

function parseTimeRange(text, { now = new Date(), tz = DEFAULT_TZ } = {}) {
	if (typeof text !== "string" || !text.trim()) return null;
	const t = text.toLowerCase();
	const today = startOfLocalDay(now, tz);
	const range = (from, to, label) => ({ from, to, label });

	if (/\bthis morning\b/.test(t)) return range(today, new Date(today.getTime() + DAY / 2), "this morning");
	if (/\b(tonight|this evening)\b/.test(t)) return range(new Date(today.getTime() + DAY / 2), new Date(today.getTime() + DAY), "this evening");
	if (/\btoday\b/.test(t)) return range(today, new Date(today.getTime() + DAY), "today");
	if (/\blast night\b/.test(t)) return range(new Date(today.getTime() - DAY / 3), new Date(today.getTime() + DAY / 6), "last night");
	if (/\byesterday\b/.test(t)) return range(new Date(today.getTime() - DAY), today, "yesterday");

	const ago = t.match(/\b(\d{1,3}|a|an|one|two|three|four|five|six|seven)\s+(day|week|month|year)s?\s+ago\b/);
	if (ago) {
		const words = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
		const n = Number(ago[1]) || words[ago[1]] || 1;
		const unitDays = { day: 1, week: 7, month: 30, year: 365 }[ago[2]];
		const center = today.getTime() - n * unitDays * DAY;
		const slack = Math.max(1, Math.round(unitDays / 2)) * DAY;
		return range(new Date(center - slack), new Date(center + slack + DAY), ago[0]);
	}

	const { year, month, weekday } = localParts(now, tz);
	if (/\bthis week\b/.test(t)) return range(new Date(today.getTime() - weekday * DAY), new Date(today.getTime() + DAY), "this week");
	if (/\blast week\b/.test(t)) {
		const start = today.getTime() - (weekday + 7) * DAY;
		return range(new Date(start), new Date(start + 7 * DAY), "last week");
	}
	if (/\bthis month\b/.test(t)) return range(localDate(year, month, 1, tz), new Date(today.getTime() + DAY), "this month");
	if (/\blast month\b/.test(t)) return range(localDate(year, month - 1, 1, tz), localDate(year, month, 1, tz), "last month");
	if (/\blast year\b/.test(t)) return range(localDate(year - 1, 0, 1, tz), localDate(year, 0, 1, tz), "last year");

	const season = t.match(/\blast (spring|summer|fall|autumn|winter)\b/);
	if (season) {
		const starts = { spring: 2, summer: 5, fall: 8, autumn: 8, winter: 11 };
		const m = starts[season[1]];
		let y = year;
		if (m >= month) y -= 1; // "last summer" in March means the previous year's
		return range(localDate(y, m, 1, tz), localDate(y, m + 3, 1, tz), season[0]);
	}

	const monthMatch = t.match(/\b(?:in|during|back in|since)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
	if (monthMatch) {
		const m = MONTHS.indexOf(monthMatch[1]);
		const y = m > month ? year - 1 : year; // "in June" said in March = last June
		return range(localDate(y, m, 1, tz), localDate(y, m + 1, 1, tz), monthMatch[0]);
	}

	const dayMatch = t.match(/\b(?:on|last)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
	if (dayMatch) {
		const target = WEEKDAYS.indexOf(dayMatch[1]);
		let back = (weekday - target + 7) % 7;
		if (back === 0) back = 7; // "on Monday" said on a Monday = a week ago
		const start = today.getTime() - back * DAY;
		return range(new Date(start), new Date(start + DAY), dayMatch[0]);
	}

	return null;
}

module.exports = { parseTimeRange, startOfLocalDay, tzOffsetMinutes, DEFAULT_TZ };
