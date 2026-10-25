/**
 * The Guardian protocols, as code. Each is a versioned definition: its
 * triggers, its checks, what it needs connected, and the defaults a household
 * may override in athena_guard_protocol.config.
 *
 * The household's settings are cleaned here (normalizeConfig) and nowhere
 * else, the same rule the action registry follows: what the panel sends is
 * untrusted until this returns it, and a field this does not return cannot
 * reach the engine. Recipients are narrowed to approved household adults by
 * the caller, which knows the allowlist.
 */
const { DEFAULT_TZ, resolveTimeZone } = require("../clock");
const policy = require("./policy");
const weatherRisk = require("./weatherRisk");

const COMMON = {
	recipients: [],
	quiet: { from: 22, to: 7 },
	escalateAfterMinutes: 30,
	retries: 2,
	retryDelaySeconds: 20,
	minConfidence: 0.75,
	maxEvidenceAgeSeconds: 120,
	autonomy: {},
	simulation: false,
};

const PROTOCOLS = {
	nightly_sweep: {
		id: "nightly_sweep",
		version: 1,
		label: "Nightly Guardian Sweep",
		describe: "At lights-out, check that the garage doors are closed — and the patio umbrella is down when the weather calls for it.",
		triggers: [{ kind: "schedule" }],
		checks: ["garage_door", "patio_umbrella"],
		requires: ["camera"],
		defaults: {
			...COMMON,
			// 9 PM on the owner's choice (2026-10-25), with the evening report.
			schedule: { time: "21:00", timeZone: DEFAULT_TZ },
			/**
			 * Owner, 2026-10-25: a push every evening at the sweep — all clear or
			 * not — and a morning one about the night. The evening report carries
			 * the sweep's own alerts, so a problem found at 9 PM is one push, not two.
			 */
			reports: { evening: true, morning: true, morningTime: "06:00" },
			// Lights-out is the point; a sweep that waited for morning would be useless.
			quiet: { from: 0, to: 0 },
			/** A sweep not run within this of its time is reported as missed, never run late and silent. */
			overdueAfterMinutes: 15,
			garageDoors: [],
			includeUmbrella: true,
		},
	},
	storm_umbrella: {
		id: "storm_umbrella",
		version: 1,
		label: "Storm umbrella watch",
		describe: "When storms or strong gusts are on the way, check the backyard camera and say if the patio umbrella is still up — at any hour, not just at lights-out.",
		triggers: [{ kind: "weather" }],
		checks: ["patio_umbrella"],
		requires: ["camera", "weather"],
		defaults: {
			...COMMON,
			escalateAfterMinutes: 0,
			umbrella: null,
			placeUuid: null,
			weather: { ...weatherRisk.DEFAULTS },
		},
	},
};

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const text = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const SERIAL = /^[A-Za-z0-9_-]{4,40}$/;
const KEY = /^[a-z0-9_-]{1,40}$/;
/** "21:00" stays "21:00"; "9:05" becomes "09:05"; anything else is null. */
function clockTime(v) {
	const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v || "").trim());
	return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}
const int = (v, lo, hi, d) => {
	const n = Number(v);
	return Number.isInteger(n) && n >= lo && n <= hi ? n : d;
};

function subjectOf(raw, fallbackKey) {
	if (!raw || typeof raw !== "object") return null;
	const serial = text(raw.serial, 40);
	if (serial && !SERIAL.test(serial)) throw bad("That camera id doesn't look right.");
	const key = text(raw.key, 40)?.toLowerCase() || fallbackKey;
	if (!KEY.test(key)) throw bad("Use letters, numbers, dashes or underscores for the short name.");
	const name = text(raw.name, 60);
	if (!name) throw bad("Give each thing to check a name.");
	return { key, name, serial, region: text(raw.region, 200) };
}

/**
 * The household's settings for one protocol, cleaned and filled with
 * defaults. Throws a 400 whose message is safe to show.
 */
function normalizeConfig(protocolId, input = {}) {
	const def = PROTOCOLS[protocolId];
	if (!def) throw bad("Unknown protocol.");
	const d = def.defaults;
	const out = {
		recipients: Array.isArray(input.recipients) ? [...new Set(input.recipients.map((r) => String(r).trim()).filter((r) => /^\d{1,12}$/.test(r)))].slice(0, 12) : [...d.recipients],
		quiet: {
			from: int(input.quiet?.from, 0, 23, d.quiet.from),
			to: int(input.quiet?.to, 0, 23, d.quiet.to),
		},
		escalateAfterMinutes: int(input.escalateAfterMinutes, 0, 720, d.escalateAfterMinutes),
		retries: int(input.retries, 0, 3, d.retries),
		retryDelaySeconds: int(input.retryDelaySeconds, 0, 120, d.retryDelaySeconds),
		minConfidence: Number.isFinite(Number(input.minConfidence)) && Number(input.minConfidence) >= 0.5 && Number(input.minConfidence) <= 0.99 ? Number(input.minConfidence) : d.minConfidence,
		maxEvidenceAgeSeconds: int(input.maxEvidenceAgeSeconds, 30, 600, d.maxEvidenceAgeSeconds),
		autonomy: policy.normalizeRestrictions(input.autonomy),
		simulation: input.simulation === true,
	};
	if (protocolId === "nightly_sweep") {
		out.schedule = {
			time: clockTime(input.schedule?.time) || d.schedule.time,
			timeZone: resolveTimeZone(input.schedule?.timeZone || d.schedule.timeZone),
		};
		const r = input.reports || {};
		out.reports = {
			evening: typeof r.evening === "boolean" ? r.evening : d.reports.evening,
			morning: typeof r.morning === "boolean" ? r.morning : d.reports.morning,
			morningTime: clockTime(r.morningTime) || d.reports.morningTime,
		};
		out.overdueAfterMinutes = int(input.overdueAfterMinutes, 5, 120, d.overdueAfterMinutes);
		const doors = Array.isArray(input.garageDoors) ? input.garageDoors.slice(0, 6) : d.garageDoors;
		out.garageDoors = doors.map((door, i) => subjectOf(door, `door-${i + 1}`)).filter(Boolean);
		if (new Set(out.garageDoors.map((x) => x.key)).size !== out.garageDoors.length) throw bad("Two garage doors share a short name.");
		out.includeUmbrella = input.includeUmbrella !== false;
	}
	if (protocolId === "storm_umbrella") {
		out.umbrella = input.umbrella ? subjectOf(input.umbrella, "umbrella") : null;
		out.placeUuid = text(input.placeUuid, 36);
		out.weather = weatherRisk.thresholdsOf(input.weather || {});
	}
	return out;
}

/**
 * Minutes `timeZone` is ahead of UTC at `date`, from Intl's own parts — not
 * by re-parsing a locale string, which goes wrong by an hour around a DST
 * change on any machine whose own zone isn't UTC.
 */
function offsetMinutes(timeZone, date) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
			.formatToParts(date)
			.map((p) => [p.type, p.value])
	);
	const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
	return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/** The instant a local wall-clock time happens on a local date in a zone (DST-aware). */
function zonedInstant(localDate, hhmm, timeZone) {
	const [h, m] = hhmm.split(":").map(Number);
	const guess = Date.UTC(Number(localDate.slice(0, 4)), Number(localDate.slice(5, 7)) - 1, Number(localDate.slice(8, 10)), h, m);
	// Two passes settle the offset across a DST change.
	let at = guess - offsetMinutes(timeZone, new Date(guess)) * 60_000;
	at = guess - offsetMinutes(timeZone, new Date(at)) * 60_000;
	return new Date(at);
}

/** The local calendar date ("2026-10-23") of an instant in a zone. */
function localDateOf(date, timeZone) {
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Local hour (0-23) of an instant in a zone. */
function localHourOf(date, timeZone) {
	return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(date)) % 24;
}

/** "10:04 PM" in the household's zone. */
function clockIn(date, timeZone) {
	return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
}

/** Is `date` inside the quiet window? from === to means there is none. */
function inQuiet(quiet, date, timeZone) {
	if (!quiet || quiet.from === quiet.to) return false;
	const h = localHourOf(date, timeZone);
	return quiet.from < quiet.to ? h >= quiet.from && h < quiet.to : h >= quiet.from || h < quiet.to;
}

/** When the quiet window that contains `date` ends. */
function quietEnds(quiet, date, timeZone) {
	const today = localDateOf(date, timeZone);
	const end = zonedInstant(today, `${String(quiet.to).padStart(2, "0")}:00`, timeZone);
	if (end > date) return end;
	// Past today's end means the window runs into tomorrow morning; twelve
	// hours on is always tomorrow's date for a window that has started.
	const tomorrow = localDateOf(new Date(date.getTime() + 12 * 3_600_000), timeZone);
	return zonedInstant(tomorrow, `${String(quiet.to).padStart(2, "0")}:00`, timeZone);
}

module.exports = { PROTOCOLS, normalizeConfig, clockTime, zonedInstant, localDateOf, localHourOf, clockIn, inQuiet, quietEnds, get: (id) => PROTOCOLS[id] || null };
