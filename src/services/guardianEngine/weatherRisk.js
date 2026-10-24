/**
 * Is weather coming that could wreck an open patio umbrella?
 *
 * Two NWS sources, both already used elsewhere: the hourly forecast
 * (weather.hourlyRows — wind is the higher of sustained and gust) and the
 * active alerts over the point (pulsepoint/nws.alertsForPlace). Either one is
 * enough to say "at risk". Neither answering is "unknown", never "calm": the
 * caller decides what unknown means for its check.
 *
 * Thresholds are per household (the storm watch's settings) with
 * conservative defaults — many umbrella makers say close it above about
 * 20 mph — so the owner can loosen them for a sturdier one.
 */
const weather = require("../weather");
const nws = require("../pulsepoint/nws");

const DEFAULTS = {
	gustMph: 20,
	/** Thunder in the forecast counts at this chance of precipitation or more. */
	stormChance: 30,
	/** How far ahead "approaching" looks. */
	lookaheadHours: 6,
	/** Urgent (delivered through quiet hours) when the risk starts within this. */
	urgentWithinHours: 6,
};
const DANGEROUS_ALERT = /thunderstorm|tornado|high wind|wind advisory|extreme wind|hurricane|tropical storm|squall|derecho|gale|storm warning|dust storm/i;

function thresholdsOf(config = {}) {
	const n = (v, lo, hi, d) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Math.round(Number(v)) : d);
	return {
		gustMph: n(config.gustMph, 5, 100, DEFAULTS.gustMph),
		stormChance: n(config.stormChance, 0, 100, DEFAULTS.stormChance),
		lookaheadHours: n(config.lookaheadHours, 1, 24, DEFAULTS.lookaheadHours),
		urgentWithinHours: n(config.urgentWithinHours, 0, 24, DEFAULTS.urgentWithinHours),
	};
}

/** "around 7 PM" from an NWS time written in the point's own offset. */
function clockOf(iso) {
	const at = weather.local(iso);
	if (!at) return null;
	return `${at.hour % 12 || 12} ${at.hour < 12 ? "AM" : "PM"}`;
}

/**
 * Assess one place. Returns
 *   { known, atRisk, urgent, reasons: [{ kind, text, at }], earliestAt, localDate, checkedAt, sources }
 * `read` is for tests.
 */
async function assess(place, config = {}, { now = new Date(), read = {} } = {}) {
	const t = thresholdsOf(config);
	const hourly = read.hourly || weather.hourlyRows;
	const alerts = read.alerts || nws.alertsForPlace;
	const nowMs = now.getTime();
	const untilMs = nowMs + t.lookaheadHours * 3_600_000;
	const out = { known: false, atRisk: false, urgent: false, reasons: [], earliestAt: null, localDate: null, checkedAt: now.toISOString(), sources: { forecast: "unavailable", alerts: "unavailable" }, thresholds: t };
	if (!place || !Number.isFinite(Number(place.latitude)) || !Number.isFinite(Number(place.longitude))) {
		out.sources = { forecast: "no_place", alerts: "no_place" };
		return out;
	}
	const [sky, active] = await Promise.all([
		hourly(place.latitude, place.longitude).catch(() => null),
		alerts(place).catch(() => null),
	]);
	let earliest = null;
	const consider = (ms, iso) => {
		if (!Number.isFinite(ms)) return;
		if (earliest === null || ms < earliest.ms) earliest = { ms, iso };
	};
	if (sky?.hours?.length) {
		out.sources.forecast = "ok";
		for (const h of sky.hours) {
			const at = weather.local(h.start);
			if (!at || at.ms + 3_600_000 <= nowMs || at.ms > untilMs) continue;
			if (Number.isFinite(h.windMph) && h.windMph >= t.gustMph) {
				out.reasons.push({ kind: "wind", text: `gusts up to ${h.windMph} mph around ${clockOf(h.start)}`, at: h.start, value: h.windMph });
				consider(Math.max(at.ms, nowMs), h.start);
			}
			if (/thunder/i.test(h.shortForecast || "") && (h.precipitationChance ?? 0) >= t.stormChance) {
				out.reasons.push({ kind: "thunder", text: `thunderstorms around ${clockOf(h.start)}`, at: h.start, value: h.precipitationChance });
				consider(Math.max(at.ms, nowMs), h.start);
			}
		}
	}
	if (Array.isArray(active)) {
		out.sources.alerts = "ok";
		for (const a of active) {
			if (!DANGEROUS_ALERT.test(a.event || "")) continue;
			const onset = Date.parse(a.onset || "") || nowMs;
			if (onset > untilMs) continue;
			out.reasons.push({ kind: "alert", text: `a ${a.event}`, at: a.onset || null, alertId: a.id });
			consider(Math.max(onset, nowMs), a.onset || now.toISOString());
		}
	}
	out.known = out.sources.forecast === "ok" || out.sources.alerts === "ok";
	// Collapse the hourly repeats: one line per kind, soonest first.
	const firstOfKind = new Map();
	for (const r of out.reasons) if (!firstOfKind.has(r.kind)) firstOfKind.set(r.kind, r);
	out.reasons = [...firstOfKind.values()].sort((a, b) => (a.kind === "alert" ? -1 : b.kind === "alert" ? 1 : 0));
	if (earliest) {
		out.atRisk = true;
		out.earliestAt = new Date(earliest.ms).toISOString();
		out.urgent = earliest.ms - nowMs <= t.urgentWithinHours * 3_600_000;
		// The storm's local date names the occurrence: one storm watch per day.
		// NWS writes its times in the point's own offset, so the date is in the string.
		out.localDate = weather.local(earliest.iso)?.date || new Date(earliest.ms).toISOString().slice(0, 10);
	}
	return out;
}

/** One phrase for a notification: "a Severe Thunderstorm Warning", "gusts up to 35 mph around 7 PM". */
function phrase(risk) {
	if (!risk?.reasons?.length) return "rough weather on the way";
	return risk.reasons.slice(0, 2).map((r) => r.text).join(" and ");
}

module.exports = { assess, phrase, thresholdsOf, DEFAULTS, DANGEROUS_ALERT };
