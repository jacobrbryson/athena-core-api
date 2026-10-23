const pool = require("../helpers/db");

/**
 * Nest readings over time (athena_nest_reading, migration 0087).
 *
 * connectors/nest.js keeps one last-known row per thermostat; this keeps the
 * readings behind it, so the bedroom-vs-sleep comparison (sleepClimate.js)
 * and the heating-keeping-up check (hvacHealth.js) have something to read.
 *
 * Written from the same two paths that move the device row — a Pub/Sub push
 * and a sync — and thinned so a chatty thermostat can't fill the table: at
 * most one row per device per ten minutes, except that a change of what the
 * system is doing (hvac, mode, eco, setpoint) is always written, because the
 * instant a heating run starts and stops is what hvacHealth measures from.
 *
 * Never throws into its caller: history is a side record, and a failed write
 * must not stop the device row — which drives the offline alert — moving.
 */

const MIN_GAP_MS = 10 * 60_000;
const RETENTION_DAYS = 120;
const HVAC = new Set(["HEATING", "COOLING", "OFF"]);

const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** The columns a set of readings maps to; null when there is nothing real to keep. */
function rowOf(readings = {}) {
	if (!readings || readings.notReporting) return null;
	const row = {
		temperature_c: round2(readings.temperatureC),
		humidity: Number.isFinite(readings.humidityPercent) ? Math.round(readings.humidityPercent) : null,
		hvac: HVAC.has(readings.hvac) ? readings.hvac : null,
		mode: typeof readings.mode === "string" ? readings.mode.slice(0, 16) : null,
		heat_c: round2(readings.heatC),
		cool_c: round2(readings.coolC),
		eco: typeof readings.eco === "string" ? readings.eco.slice(0, 16) : null,
	};
	if (row.temperature_c === null && row.hvac === null && row.mode === null) return null;
	return row;
}

/** Does `next` say something different about what the system is doing? */
function changed(prev, next) {
	if (!prev) return true;
	return (
		prev.hvac !== next.hvac ||
		prev.mode !== next.mode ||
		prev.eco !== next.eco ||
		num(prev.heat_c) !== next.heat_c ||
		num(prev.cool_c) !== next.cool_c
	);
}

/**
 * Keep one reading if it is due. Returns true when a row was written.
 * An event older than the newest stored reading is dropped, as the device
 * row does, so a redelivery can't write history out of order.
 */
async function record(profileId, deviceName, readings, at = new Date()) {
	try {
		const row = rowOf(readings);
		const when = at instanceof Date ? at : new Date(at);
		if (!row || Number.isNaN(when.getTime())) return false;
		const [last] = await pool.query(
			`SELECT at, hvac, mode, eco, heat_c, cool_c FROM athena_nest_reading
			 WHERE profile_id = ? AND device_name = ? ORDER BY at DESC LIMIT 1`,
			[profileId, deviceName]
		);
		const prev = last[0] || null;
		if (prev) {
			const gap = when.getTime() - new Date(prev.at).getTime();
			if (gap < 0) return false;
			if (gap < MIN_GAP_MS && !changed(prev, row)) return false;
		}
		const [result] = await pool.query(
			`INSERT IGNORE INTO athena_nest_reading
				(profile_id, device_name, at, temperature_c, humidity, hvac, mode, heat_c, cool_c, eco)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[profileId, deviceName, when, row.temperature_c, row.humidity, row.hvac, row.mode, row.heat_c, row.cool_c, row.eco]
		);
		return result.affectedRows > 0;
	} catch (err) {
		console.warn("[nestHistory] write failed:", err.message);
		return false;
	}
}

function toReading(r) {
	return {
		device: r.device_name,
		at: new Date(r.at),
		temperatureC: num(r.temperature_c),
		humidity: num(r.humidity),
		hvac: r.hvac || null,
		mode: r.mode || null,
		heatC: num(r.heat_c),
		coolC: num(r.cool_c),
		eco: r.eco || null,
	};
}

/** Readings for one device (or all of a person's) between two instants, oldest first. */
async function between(profileId, from, to, { device = null } = {}) {
	const [rows] = await pool.query(
		`SELECT device_name, at, temperature_c, humidity, hvac, mode, heat_c, cool_c, eco
		 FROM athena_nest_reading
		 WHERE profile_id = ? AND at >= ? AND at <= ?${device ? " AND device_name = ?" : ""}
		 ORDER BY at`,
		device ? [profileId, from, to, device] : [profileId, from, to]
	);
	return rows.map(toReading);
}

async function prune(days = RETENTION_DAYS) {
	const [result] = await pool.query(
		"DELETE FROM athena_nest_reading WHERE at < DATE_SUB(NOW(), INTERVAL ? DAY)",
		[days]
	);
	return { pruned: result.affectedRows || 0 };
}

module.exports = { record, between, prune, rowOf, changed, MIN_GAP_MS, RETENTION_DAYS };
