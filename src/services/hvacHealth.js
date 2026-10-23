const nest = require("./connectors/nest");
const history = require("./nestHistory");
const credentials = require("./credentials");

/**
 * Is the heating (or cooling) keeping up? (docs/capabilities/nest.md)
 *
 * Reads the thermostat history (athena_nest_reading) as runs: a stretch of
 * readings where the system said HEATING, or COOLING, from the reading that
 * started it to the one that stopped it — or to now, if it is still running.
 * Two things are worth saying, and both are measurements, never a diagnosis:
 *
 *   not_keeping_up      a run of at least 45 minutes that has moved the room
 *                       less than half a degree toward a setpoint it still
 *                       hasn't reached.
 *   slower_than_usual   the last two days' runs warm (or cool) the room at
 *                       half the rate or less of that thermostat's own
 *                       30-day median. Outdoor temperature isn't stored over
 *                       time, so a hard cold snap can read as slower; the
 *                       wording says so rather than guessing a fault.
 *
 * Everything here is arithmetic on stored rows; no model, no API call.
 */

const HOUR = 3_600_000;
const RECENT_MS = 48 * HOUR;
const BASELINE_MS = 30 * 24 * HOUR;
const MIN_RUN_MIN = 45;
const MIN_PROGRESS_F = 0.5;
const STILL_SHORT_F = 1;
const RATE_MIN_RUN_MIN = 15;
const MIN_BASELINE_RUNS = 5;
const MIN_RECENT_RUNS = 2;
const SLOW_RATIO = 0.5;

const cToF = (c) => (c * 9) / 5 + 32;
const deltaF = (c) => (c * 9) / 5;

function median(xs) {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Runs from one device's readings, oldest first. `current` is the device's
 * live state, which closes an open run at `now` with today's temperature.
 */
function runsOf(readings, { now = new Date(), current = null } = {}) {
	const runs = [];
	let run = null;
	let lastTemp = null;
	const close = (endAt, endTemp) => {
		if (!run) return;
		run.endAt = endAt;
		if (Number.isFinite(endTemp)) run.endC = endTemp;
		runs.push(run);
		run = null;
	};
	for (const r of readings) {
		const active = r.hvac === "HEATING" || r.hvac === "COOLING";
		if (run && r.hvac !== run.hvac) close(r.at, Number.isFinite(r.temperatureC) ? r.temperatureC : run.endC);
		if (active && !run) {
			const startC = Number.isFinite(r.temperatureC) ? r.temperatureC : lastTemp;
			run = {
				hvac: r.hvac,
				startAt: r.at,
				startC,
				endC: startC,
				targetC: r.hvac === "HEATING" ? r.heatC : r.coolC,
				open: false,
			};
		} else if (run && Number.isFinite(r.temperatureC)) {
			run.endC = r.temperatureC;
			const target = run.hvac === "HEATING" ? r.heatC : r.coolC;
			if (Number.isFinite(target)) run.targetC = target;
		}
		if (Number.isFinite(r.temperatureC)) lastTemp = r.temperatureC;
	}
	if (run) {
		const live = current && current.hvac === run.hvac ? current : null;
		if (live || !current) {
			run.open = true;
			close(now, live && Number.isFinite(live.temperatureC) ? live.temperatureC : run.endC);
		} else {
			// The stored state has moved on but no reading recorded the stop;
			// end the run at its last reading rather than inventing a duration.
			const last = readings[readings.length - 1];
			close(last.at, run.endC);
		}
	}
	return runs.map((r) => {
		const minutes = (r.endAt.getTime() - r.startAt.getTime()) / 60_000;
		const sign = r.hvac === "HEATING" ? 1 : -1;
		const progressF = Number.isFinite(r.startC) && Number.isFinite(r.endC) ? sign * deltaF(r.endC - r.startC) : null;
		const shortF = Number.isFinite(r.targetC) && Number.isFinite(r.endC) ? sign * deltaF(r.targetC - r.endC) : null;
		const rateFPerHour = progressF !== null && minutes >= RATE_MIN_RUN_MIN ? progressF / (minutes / 60) : null;
		return { ...r, minutes, progressF, shortF, rateFPerHour };
	});
}

/** What, if anything, is worth saying about one device's runs. */
function judge(runs, { now = new Date() } = {}) {
	const issues = [];
	const recentFrom = now.getTime() - RECENT_MS;
	const recent = runs.filter((r) => r.startAt.getTime() >= recentFrom);

	const stuck = recent
		.filter((r) => r.minutes >= MIN_RUN_MIN && r.progressF !== null && r.progressF < MIN_PROGRESS_F && r.shortF !== null && r.shortF >= STILL_SHORT_F)
		.sort((a, b) => b.startAt - a.startAt)[0];
	if (stuck) {
		issues.push({
			kind: "not_keeping_up",
			hvac: stuck.hvac,
			since: stuck.startAt.toISOString(),
			stillRunning: stuck.open,
			evidence: {
				minutes: Math.round(stuck.minutes),
				startF: Math.round(cToF(stuck.startC) * 10) / 10,
				nowF: Math.round(cToF(stuck.endC) * 10) / 10,
				targetF: Number.isFinite(stuck.targetC) ? Math.round(cToF(stuck.targetC)) : null,
			},
		});
	}

	for (const hvac of ["HEATING", "COOLING"]) {
		const rate = (list) => list.filter((r) => r.hvac === hvac && r.rateFPerHour !== null && r.progressF > 0).map((r) => r.rateFPerHour);
		const base = rate(runs.filter((r) => r.startAt.getTime() < recentFrom));
		const lately = rate(recent);
		if (base.length < MIN_BASELINE_RUNS || lately.length < MIN_RECENT_RUNS) continue;
		const usual = median(base);
		const now2 = median(lately);
		if (usual > 0 && now2 <= usual * SLOW_RATIO && !issues.some((i) => i.hvac === hvac)) {
			const first = recent.filter((r) => r.hvac === hvac).sort((a, b) => a.startAt - b.startAt)[0];
			issues.push({
				kind: "slower_than_usual",
				hvac,
				since: first.startAt.toISOString(),
				evidence: {
					usualFPerHour: Math.round(usual * 10) / 10,
					recentFPerHour: Math.round(now2 * 10) / 10,
					usualRuns: base.length,
					recentRuns: lately.length,
				},
			});
		}
	}
	return issues;
}

/** Every device's issues for one person; [] when Nest isn't linked. */
async function assess(profileId, { now = new Date() } = {}) {
	const link = await credentials.status(profileId, nest.PROVIDER);
	if (link?.status !== "active") return [];
	const devices = (await nest.storedDevices(profileId)).filter((d) => d.connectivity !== "OFFLINE" && !d.notReporting);
	if (!devices.length) return [];
	const readings = await history.between(profileId, new Date(now.getTime() - BASELINE_MS), now);
	const out = [];
	for (const d of devices) {
		const mine = readings.filter((r) => r.device === d.name);
		if (!mine.length) continue;
		const current = { hvac: d.readings?.hvac || null, temperatureC: d.readings?.temperatureC };
		for (const issue of judge(runsOf(mine, { now, current }), { now })) {
			out.push({ device: d.name, title: nest.deviceTitle(d), room: d.room || null, ...issue });
		}
	}
	return out;
}

function describe(issue) {
	const what = issue.hvac === "HEATING" ? "heat" : "cooling";
	if (issue.kind === "not_keeping_up") {
		const e = issue.evidence;
		return (
			`${issue.title}: the ${what} ${issue.stillRunning ? "has been running" : "ran"} ${e.minutes} minutes ` +
			`and the room moved from ${e.startF}°F to ${e.nowF}°F${e.targetF ? `, still short of ${e.targetF}°F` : ""}.`
		);
	}
	const e = issue.evidence;
	return (
		`${issue.title}: over the last two days the ${what} has moved the room about ${e.recentFPerHour}°F an hour, ` +
		`against its usual ${e.usualFPerHour}°F (outdoor temperature isn't accounted for, so a cold snap can look like this).`
	);
}

/** One block for the chat prompt, or null. Never throws. */
async function promptLine(profileId) {
	try {
		const issues = await assess(profileId);
		if (!issues.length) return null;
		return [
			"Heating/cooling performance (measured from the thermostat's own readings; say what was seen, never guess a cause; offer to help report it as a Property issue):",
			...issues.map((i) => `- ${describe(i)}`),
		].join("\n");
	} catch {
		return null;
	}
}

module.exports = { assess, runsOf, judge, describe, promptLine, MIN_RUN_MIN };
