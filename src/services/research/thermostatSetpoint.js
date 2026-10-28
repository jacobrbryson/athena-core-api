const nest = require("../connectors/nest");
const history = require("../nestHistory");
const credentials = require("../credentials");
const { windowMean, bedroomDevice } = require("../sleepClimate");

/**
 * Thermostat setpoint against heating time (docs/capabilities/research.md).
 *
 * Nest reports no energy, so this measures the thing the setpoint actually
 * changes: how many hours a day the system spent heating, from the readings
 * athena_nest_reading keeps. Each day is paired with the heat setpoint it ran
 * at, and days are compared by setpoint band. All arithmetic, no model.
 *
 * Outdoor temperature is not stored over time, so it is not controlled for:
 * colder days both raise heating time and invite higher setpoints. The finding
 * says so, and confidence is never above low until weather is captured.
 */

const MIN_DAYS = 14;
const MIN_BAND_DAYS = 3;
const BAND_F = 2;
const DAY_MS = 86_400_000;
const CARRY_MS = 3 * 3_600_000;
const CACHE_MS = 6 * 3_600_000;

const cache = new Map();
const toF = (c) => (c * 9) / 5 + 32;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (v, d = 0) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

/** The house thermostat: not the bedroom one when there are several. */
function houseDevice(devices = []) {
	const usable = devices.filter((d) => !d.notReporting);
	if (usable.length <= 1) return usable[0] || null;
	const bedroom = bedroomDevice(usable);
	return usable.find((d) => d !== bedroom) || usable[0];
}

/** One entry per UTC day with heating hours and the mean heat setpoint; uncovered or setpoint-less days drop out. */
function pairDays(readings, from, days) {
	const marked = readings.map((r) => ({
		...r,
		heating: r.hvac === null ? null : r.hvac === "HEATING" ? 1 : 0,
		// A setpoint only means something while the thermostat is in a heating mode.
		heatSet: r.mode === "HEAT" || r.mode === "HEATCOOL" ? r.heatC : null,
	}));
	const out = [];
	for (let i = 0; i < days; i += 1) {
		const start = new Date(from.getTime() + i * DAY_MS);
		const end = new Date(start.getTime() + DAY_MS);
		const duty = windowMean(marked, start, end, "heating");
		const setC = windowMean(marked, start, end, "heatSet");
		if (duty === null || setC === null) continue;
		out.push({ date: start.toISOString().slice(0, 10), heatingHours: duty * 24, setpointF: toF(setC) });
	}
	return out;
}

function bandOf(f) {
	const from = Math.floor(f / BAND_F) * BAND_F;
	return { fromF: from, toF: from + BAND_F - 1 };
}

function summarize(days) {
	if (days.length < MIN_DAYS) return { status: "gathering", have: days.length, needed: MIN_DAYS };
	const groups = new Map();
	for (const d of days) {
		const b = bandOf(d.setpointF);
		if (!groups.has(b.fromF)) groups.set(b.fromF, { ...b, list: [] });
		groups.get(b.fromF).list.push(d);
	}
	const bands = [...groups.values()]
		.sort((a, b) => a.fromF - b.fromF)
		.map((g) => ({
			fromF: g.fromF,
			toF: g.toF,
			days: g.list.length,
			avgHeatingHours: round(mean(g.list.map((d) => d.heatingHours)), 1),
		}));
	const eligible = bands.filter((b) => b.days >= MIN_BAND_DAYS);
	if (eligible.length < 2) {
		return { status: "flat", have: days.length, needed: MIN_DAYS, bands, reason: "Too few setpoint bands to compare yet." };
	}
	const low = eligible[0];
	const high = eligible[eligible.length - 1];
	return {
		status: "ready",
		have: days.length,
		needed: MIN_DAYS,
		bands,
		low,
		high,
		hoursSaved: round(high.avgHeatingHours - low.avgHeatingHours, 1),
		confidence: "low",
	};
}

function sentence(result, title) {
	if (result.status === "gathering") {
		return `I have ${result.have} of the ${result.needed} days I need from the ${title}, each with a heating setpoint and a full day of readings.`;
	}
	if (result.status !== "ready") return "Your days so far don't spread across enough heating setpoints to compare.";
	const { low, high, hoursSaved } = result;
	const dir = hoursSaved >= 0 ? "fewer" : "more";
	return (
		`On days the ${title} was set to ${low.fromF}–${low.toF}°F the heat ran ${low.avgHeatingHours} hours, ` +
		`${Math.abs(hoursSaved)} ${dir} hours than on days set to ${high.fromF}–${high.toF}°F (${low.days} and ${high.days} days). ` +
		`Outdoor temperature isn't accounted for, so cold days can look like higher setpoints — low confidence.`
	);
}

async function analyze(profileId, { days = 60, now = new Date(), fresh = false } = {}) {
	const hit = cache.get(profileId);
	if (!fresh && hit && now.getTime() - hit.at < CACHE_MS) return hit.result;
	const link = await credentials.status(profileId, nest.PROVIDER);
	if (link?.status !== "active") return { status: "not_linked" };
	const device = houseDevice(await nest.storedDevices(profileId));
	if (!device) return { status: "no_device" };
	const title = nest.deviceTitle(device);
	const midnight = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
	const from = new Date(midnight.getTime() - days * DAY_MS);
	const readings = await history.between(profileId, new Date(from.getTime() - CARRY_MS), midnight, { device: device.name });
	const summary = summarize(pairDays(readings, from, days));
	const result = { ...summary, device: { name: device.name, title }, sentence: sentence(summary, title), checkedAt: now.toISOString() };
	cache.set(profileId, { at: now.getTime(), result });
	return result;
}

function _reset() {
	cache.clear();
}

module.exports = { analyze, houseDevice, pairDays, summarize, sentence, MIN_DAYS, _reset };
