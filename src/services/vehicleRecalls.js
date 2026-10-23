const pool = require("../helpers/db");

/**
 * Safety recalls for the vehicles on Property → Vehicles, from NHTSA
 * (docs/capabilities/vehicles.md, migration 0090). Free, keyless, public.
 *
 * NHTSA's recalls API answers by make, model and model year. With a VIN we
 * ask its vPIC decoder what the car is first, so a "Bimmer" in the make field
 * doesn't hide a recall; without one, the vehicle's own year/make/model are
 * used. What comes back is every recall for that model year — not whether
 * this car was repaired — so each one starts open until the person marks it
 * done or not applicable. Nothing is sent but the VIN (to decode) and the
 * make/model/year (to look up).
 */

const VPIC = "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues";
const RECALLS = "https://api.nhtsa.gov/recalls/recallsByVehicle";
const TIMEOUT_MS = 15_000;
const STALE_MS = 20 * 3_600_000;
const STATUSES = ["open", "done", "not_applicable"];

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const clip = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

async function getJson(url, fetchImpl = fetch) {
	const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!res.ok) throw new Error(`NHTSA answered ${res.status}`);
	return res.json();
}

/** What NHTSA's decoder says a VIN is, or null. */
async function decodeVin(vin, { fetchImpl } = {}) {
	if (typeof vin !== "string" || !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return null;
	const data = await getJson(`${VPIC}/${encodeURIComponent(vin)}?format=json`, fetchImpl);
	const r = data?.Results?.[0] || {};
	const year = Number(r.ModelYear);
	if (!r.Make || !r.Model || !Number.isInteger(year)) return null;
	return { make: String(r.Make).trim(), model: String(r.Model).trim(), year };
}

/** "19/12/2018" (NHTSA's day/month/year) or ISO -> "2018-12-19". */
function reportedOn(value) {
	const s = String(value || "");
	const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
	if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
	return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function recallOf(r) {
	const campaign = clip(r?.NHTSACampaignNumber, 20);
	if (!campaign) return null;
	return {
		campaign,
		component: clip(r.Component, 200),
		summary: clip(r.Summary, 4000),
		consequence: clip(r.Consequence, 4000),
		remedy: clip(r.Remedy, 4000),
		reported_on: reportedOn(r.ReportReceivedDate),
		park_it: r.parkIt === true ? 1 : 0,
		park_outside: r.parkOutSide === true ? 1 : 0,
	};
}

async function lookup({ make, model, year }, { fetchImpl } = {}) {
	const q = new URLSearchParams({ make, model, modelYear: String(year) });
	const data = await getJson(`${RECALLS}?${q}`, fetchImpl);
	return (data?.results || []).map(recallOf).filter(Boolean);
}

function parse(v) {
	if (!v) return null;
	if (typeof v === "object") return v;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
}

/**
 * Look one vehicle's recalls up and keep any new ones. Returns how many were
 * new. A vehicle with neither a decodable VIN nor year+make+model is skipped.
 */
async function refreshVehicle(row, { fetchImpl } = {}) {
	let who = parse(row.decoded);
	if (!who && row.vin) {
		who = await decodeVin(row.vin, { fetchImpl }).catch(() => null);
		if (who) await pool.query("UPDATE athena_property_vehicle SET decoded = ? WHERE id = ?", [JSON.stringify(who), row.id]);
	}
	if (!who && row.year && row.make && row.model) who = { make: row.make, model: row.model, year: row.year };
	if (!who) return { skipped: true, added: 0 };
	const recalls = await lookup(who, { fetchImpl });
	let added = 0;
	for (const r of recalls) {
		const [result] = await pool.query(
			`INSERT INTO athena_vehicle_recall
				(vehicle_id, campaign, component, summary, consequence, remedy, reported_on, park_it, park_outside)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE component = VALUES(component), summary = VALUES(summary),
				consequence = VALUES(consequence), remedy = VALUES(remedy), park_it = VALUES(park_it), park_outside = VALUES(park_outside)`,
			[row.id, r.campaign, r.component, r.summary, r.consequence, r.remedy, r.reported_on, r.park_it, r.park_outside]
		);
		// 1 = inserted, 2 = updated an existing row (mysql2's ON DUPLICATE count).
		if (result.affectedRows === 1) added += 1;
	}
	await pool.query("UPDATE athena_property_vehicle SET recalls_checked_at = NOW() WHERE id = ?", [row.id]);
	return { skipped: false, added };
}

/** A vehicle's VIN or model changed: forget the old decode and look again. */
async function refreshByUuid(profileId, uuid, { fetchImpl } = {}) {
	await pool.query("UPDATE athena_property_vehicle SET decoded = NULL WHERE profile_id = ? AND uuid = ?", [profileId, uuid]);
	const [rows] = await pool.query(
		"SELECT id, vin, year, make, model, decoded FROM athena_property_vehicle WHERE profile_id = ? AND uuid = ?",
		[profileId, uuid]
	);
	return rows[0] ? refreshVehicle(rows[0], { fetchImpl }) : { skipped: true, added: 0 };
}

/** Nightly: every vehicle not looked up in the last day. One failure never stops the rest. */
async function refreshEveryone({ fetchImpl } = {}) {
	const [rows] = await pool.query(
		`SELECT id, vin, year, make, model, decoded FROM athena_property_vehicle
		 WHERE recalls_checked_at IS NULL OR recalls_checked_at < ?`,
		[new Date(Date.now() - STALE_MS)]
	);
	let checked = 0, added = 0, failed = 0;
	for (const row of rows) {
		try {
			const r = await refreshVehicle(row, { fetchImpl });
			if (!r.skipped) checked += 1;
			added += r.added;
		} catch (err) {
			failed += 1;
			console.warn("[vehicleRecalls] lookup failed:", row.id, err.message);
		}
	}
	return { checked, added, failed };
}

function shape(r) {
	return {
		campaign: r.campaign,
		component: r.component,
		summary: r.summary,
		consequence: r.consequence,
		remedy: r.remedy,
		reportedOn: r.reported_on ? String(r.reported_on instanceof Date ? r.reported_on.toISOString() : r.reported_on).slice(0, 10) : null,
		parkIt: !!r.park_it,
		parkOutside: !!r.park_outside,
		status: r.status,
		firstSeenAt: r.first_seen_at ? new Date(r.first_seen_at).toISOString() : null,
	};
}

/** Recalls per vehicle id, open first then newest. An uninstalled migration reads as none. */
async function forVehicles(ids) {
	const out = new Map();
	if (!ids.length) return out;
	try {
		const [rows] = await pool.query(
			`SELECT * FROM athena_vehicle_recall WHERE vehicle_id IN (?)
			 ORDER BY status = 'open' DESC, reported_on DESC, id DESC`,
			[ids]
		);
		for (const r of rows) out.set(r.vehicle_id, [...(out.get(r.vehicle_id) || []), shape(r)]);
	} catch (err) {
		if (err.code !== "ER_NO_SUCH_TABLE") throw err;
	}
	return out;
}

/** The person marks one done, not applicable, or open again. */
async function setStatus(profileId, vehicleUuid, campaign, status) {
	if (!STATUSES.includes(status)) throw bad("Mark it done, not applicable, or open.");
	const [result] = await pool.query(
		`UPDATE athena_vehicle_recall r JOIN athena_property_vehicle v ON v.id = r.vehicle_id
		 SET r.status = ?, r.status_at = NOW() WHERE v.profile_id = ? AND v.uuid = ? AND r.campaign = ?`,
		[status, profileId, String(vehicleUuid || ""), String(campaign || "")]
	);
	if (!result.affectedRows) throw bad("That recall is no longer on this vehicle.", 404);
}

/** Open recalls first seen in the last `days` — what the vehicle_recall trigger speaks about. */
async function recentOpen(profileId, { days = 14 } = {}) {
	const [rows] = await pool.query(
		`SELECT r.*, v.name AS vehicle_name, v.uuid AS vehicle_uuid FROM athena_vehicle_recall r
		 JOIN athena_property_vehicle v ON v.id = r.vehicle_id
		 WHERE v.profile_id = ? AND r.status = 'open' AND r.first_seen_at >= ?
		 ORDER BY r.park_it DESC, r.park_outside DESC, r.reported_on DESC`,
		[profileId, new Date(Date.now() - days * 86_400_000)]
	);
	return rows;
}

module.exports = {
	decodeVin, lookup, recallOf, reportedOn, refreshVehicle, refreshByUuid, refreshEveryone,
	forVehicles, setStatus, recentOpen, STATUSES,
};
