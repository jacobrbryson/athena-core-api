const nest = require("./connectors/nest");
const whoop = require("./connectors/whoop");
const history = require("./nestHistory");
const credentials = require("./credentials");

/**
 * Bedroom climate against sleep (docs/capabilities/sleep-climate.md).
 *
 * Pairs each WHOOP night with what the bedroom thermostat read while it
 * lasted (athena_nest_reading), then compares recovery and sleep performance
 * across temperature bands. All arithmetic, no model: the finding is a count
 * of the person's own nights, and it is worded as a pattern, never a cause.
 *
 * Nothing is said until there are enough paired nights to mean anything
 * (MIN_NIGHTS), and a band needs MIN_BAND nights before it can be "best".
 */

const MIN_NIGHTS = 14;
const MIN_BAND = 3;
const BAND_F = 2;
const CARRY_MS = 3 * 3_600_000; // a reading this long before bed still describes the room
const CACHE_MS = 6 * 3_600_000;

const cache = new Map(); // profileId -> { at, result }

const toF = (c) => (c * 9) / 5 + 32;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (v, d = 0) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

/** The thermostat this person sleeps near: chosen, named "bed…", or the only one. */
function bedroomDevice(devices = []) {
	const usable = devices.filter((d) => !d.notReporting);
	return (
		usable.find((d) => d.sleepDevice) ||
		usable.find((d) => /bed/i.test(`${d.room || ""} ${d.displayName || ""}`)) ||
		(usable.length === 1 ? usable[0] : null)
	);
}

/**
 * Time-weighted mean of a stepwise series over [start, end]: each reading
 * holds until the next one, which is how Nest reports (it sends on change).
 * Returns null when nothing describes the start of the night.
 */
function windowMean(readings, start, end, field) {
	const s = start.getTime();
	const e = end.getTime();
	if (!(e > s)) return null;
	const pts = readings.filter((r) => Number.isFinite(r[field]));
	let i = pts.findIndex((r) => r.at.getTime() > s);
	if (i === -1) i = pts.length;
	const before = pts[i - 1];
	if (!before && (!pts[i] || pts[i].at.getTime() - s > 30 * 60_000)) return null;
	if (before && s - before.at.getTime() > CARRY_MS && !(pts[i] && pts[i].at.getTime() < e)) return null;
	let cursor = s;
	let value = before ? before[field] : pts[i][field];
	let sum = 0;
	for (; i < pts.length && pts[i].at.getTime() < e; i += 1) {
		const t = pts[i].at.getTime();
		sum += value * (t - cursor);
		cursor = t;
		value = pts[i][field];
	}
	sum += value * (e - cursor);
	return sum / (e - s);
}

/** Each scored night with its bedroom mean; nights the thermostat didn't cover drop out. */
function pairNights(sleeps, recoveries, readings) {
	const recoveryBySleep = new Map(recoveries.filter((r) => r.sleep_id).map((r) => [String(r.sleep_id), r]));
	const nights = [];
	for (const s of sleeps) {
		if (s.nap || !s.start || !s.end) continue;
		const start = new Date(s.start);
		const end = new Date(s.end);
		const c = windowMean(readings, start, end, "temperatureC");
		if (c === null) continue;
		const humidity = windowMean(readings, start, end, "humidity");
		const rec = s.id ? recoveryBySleep.get(String(s.id)) : null;
		nights.push({
			date: s.date,
			tempF: toF(c),
			humidity,
			performance: Number.isFinite(s.sleep_performance_percent) ? s.sleep_performance_percent : null,
			recovery: Number.isFinite(rec?.recovery_score) ? rec.recovery_score : null,
		});
	}
	return nights;
}

function bandOf(f) {
	const from = Math.floor(f / BAND_F) * BAND_F;
	return { fromF: from, toF: from + BAND_F - 1 };
}

/** Bands, the best one and how it compares with every other night. */
function summarize(nights) {
	if (nights.length < MIN_NIGHTS) {
		return { status: "gathering", nights: nights.length, needed: MIN_NIGHTS };
	}
	const groups = new Map();
	for (const n of nights) {
		const b = bandOf(n.tempF);
		const key = b.fromF;
		if (!groups.has(key)) groups.set(key, { ...b, list: [] });
		groups.get(key).list.push(n);
	}
	const bands = [...groups.values()]
		.sort((a, b) => a.fromF - b.fromF)
		.map((g) => ({
			fromF: g.fromF,
			toF: g.toF,
			nights: g.list.length,
			avgRecovery: round(mean(g.list.map((n) => n.recovery).filter((v) => v !== null))),
			avgPerformance: round(mean(g.list.map((n) => n.performance).filter((v) => v !== null))),
			avgHumidity: round(mean(g.list.map((n) => n.humidity).filter((v) => v !== null))),
		}));

	// Recovery is the outcome that matters the next day; performance stands in
	// when WHOOP hasn't scored recovery for enough of them.
	const metric = nights.filter((n) => n.recovery !== null).length >= MIN_NIGHTS ? "avgRecovery" : "avgPerformance";
	const field = metric === "avgRecovery" ? "recovery" : "performance";
	const eligible = bands.filter((b) => b.nights >= MIN_BAND && b[metric] !== null);
	if (eligible.length < 2) {
		return { status: "flat", nights: nights.length, bands, metric, reason: "Too few temperature bands to compare yet." };
	}
	const best = eligible.reduce((a, b) => (b[metric] > a[metric] ? b : a));
	const rest = nights.filter((n) => bandOf(n.tempF).fromF !== best.fromF && n[field] !== null);
	const restAvg = mean(rest.map((n) => n[field]));
	const delta = round(best[metric] - restAvg);
	const confidence = nights.length >= 30 && best.nights >= 6 && delta >= 5 ? "moderate" : "low";
	return {
		status: "ready",
		nights: nights.length,
		metric,
		bands,
		best: { ...best, delta, othersAvg: round(restAvg) },
		confidence,
	};
}

function sentence(result, deviceTitle) {
	if (result.status === "gathering") {
		return `I have ${result.nights} of the ${result.needed} nights I need from the ${deviceTitle} before I can compare temperatures with your sleep.`;
	}
	if (result.status !== "ready") return "Your nights so far don't spread across enough bedroom temperatures to compare.";
	const what = result.metric === "avgRecovery" ? "recovery" : "sleep performance";
	const b = result.best;
	const dir = b.delta >= 0 ? "higher" : "lower";
	return (
		`On nights the ${deviceTitle} averaged ${b.fromF}–${b.toF}°F, your ${what} averaged ${b[result.metric]}%, ` +
		`${Math.abs(b.delta)} points ${dir} than your other nights (${b.nights} of ${result.nights} nights; ` +
		`${result.confidence} confidence — a pattern in your nights, not proof of cause).`
	);
}

/**
 * The comparison for one person. `status` is one of:
 *   not_linked — Nest or WHOOP isn't linked (both are needed)
 *   no_device  — no usable thermostat to read the bedroom from
 *   gathering  — fewer than MIN_NIGHTS paired nights so far
 *   flat       — enough nights, but not spread over enough bands
 *   ready      — a best band and how it compares
 */
async function analyze(profileId, { days = 60, now = new Date(), fresh = false } = {}) {
	const hit = cache.get(profileId);
	if (!fresh && hit && now.getTime() - hit.at < CACHE_MS) return hit.result;

	// Both links must be live: stored thermostat rows are never read without
	// an active Nest link, the rule the Property panel and chat keep too.
	const [nestLink, whoopLink] = await Promise.all([
		credentials.status(profileId, nest.PROVIDER),
		credentials.status(profileId, "whoop"),
	]);
	if (nestLink?.status !== "active" || whoopLink?.status !== "active") return { status: "not_linked" };
	const device = bedroomDevice(await nest.storedDevices(profileId));
	if (!device) return { status: "no_device" };
	const title = nest.deviceTitle(device);
	const from = new Date(now.getTime() - days * 86_400_000);
	const [{ sleep, recovery }, readings] = await Promise.all([
		whoop.sleepHistory(profileId, { days }),
		history.between(profileId, new Date(from.getTime() - CARRY_MS), now, { device: device.name }),
	]);
	const nights = pairNights(sleep, recovery, readings);
	const summary = summarize(nights);
	const result = {
		...summary,
		device: { name: device.name, title },
		sentence: sentence(summary, title),
		checkedAt: now.toISOString(),
	};
	cache.set(profileId, { at: now.getTime(), result });
	return result;
}

/** One line for the chat prompt, or null — never throws, never waits long. */
async function promptLine(profileId, { timeoutMs = 4000 } = {}) {
	try {
		const result = await Promise.race([
			analyze(profileId),
			new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs).unref?.()),
		]);
		if (!result || result.status === "no_device" || result.status === "not_linked") return null;
		return `Bedroom temperature vs. sleep (from the person's own nights; to act on it, offer a set_thermostat card for bedtime): ${result.sentence}`;
	} catch {
		return null;
	}
}

/** Drop one person's cached comparison (their bedroom thermostat changed). */
function forget(profileId) {
	cache.delete(profileId);
}

function _reset() {
	cache.clear();
}

module.exports = {
	analyze,
	promptLine,
	bedroomDevice,
	windowMean,
	pairNights,
	summarize,
	sentence,
	MIN_NIGHTS,
	forget,
	_reset,
};
