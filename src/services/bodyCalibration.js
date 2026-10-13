const { v4: uuidv4 } = require("uuid");
const pool = require("../helpers/db");

/**
 * Reference body measurements a person enters from a lab or clinic, which
 * correct the scale (see services/bodyComposition.js for how). One profile's
 * own rows only; every query is keyed by the caller's profile id.
 */

/** Field -> [min, max] a real adult measurement falls inside. */
const MEASURES = {
	height_cm: [100, 250],
	body_fat_percent: [2, 70],
	skeletal_muscle_kg: [5, 90],
	fat_free_mass_kg: [20, 150],
	body_water_percent: [30, 80],
};
const COLUMNS = `uuid, measured_on, source, ${Object.keys(MEASURES).join(", ")}, created_at`;

function badRequest(message) {
	return Object.assign(new Error(message), { status: 400 });
}

function toPublic(row) {
	const out = { uuid: row.uuid, measured_on: row.measured_on instanceof Date ? row.measured_on.toISOString().slice(0, 10) : String(row.measured_on).slice(0, 10), source: row.source || null };
	for (const field of Object.keys(MEASURES)) out[field] = row[field] === null || row[field] === undefined ? null : Number(row[field]);
	return out;
}

/** Newest first. A database without the table yet reads as no references. */
async function list(profileId) {
	try {
		const [rows] = await pool.query(
			`SELECT ${COLUMNS} FROM body_calibration WHERE profile_id = ? AND deleted_at IS NULL ORDER BY measured_on DESC, id DESC LIMIT 50`,
			[profileId]
		);
		return rows.map(toPublic);
	} catch (err) {
		if (err.code === "ER_NO_SUCH_TABLE") return [];
		throw err;
	}
}

/** Validates and stores one reference. At least one measure is required. */
async function add(profileId, body = {}) {
	const measuredOn = String(body.measured_on || "").slice(0, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(measuredOn) || Number.isNaN(Date.parse(measuredOn))) throw badRequest("A measurement date (YYYY-MM-DD) is required.");
	if (Date.parse(measuredOn) > Date.now() + 86400_000) throw badRequest("The measurement date can't be in the future.");
	const values = {};
	for (const [field, [min, max]] of Object.entries(MEASURES)) {
		const raw = body[field];
		if (raw === null || raw === undefined || raw === "") continue;
		const value = Number(raw);
		if (!Number.isFinite(value) || value < min || value > max) throw badRequest(`${field.replace(/_/g, " ")} must be between ${min} and ${max}.`);
		values[field] = value;
	}
	if (!Object.keys(values).length) throw badRequest("Enter at least one measurement.");
	const source = typeof body.source === "string" && body.source.trim() ? body.source.trim().slice(0, 80) : null;
	const uuid = uuidv4();
	const fields = Object.keys(values);
	await pool.query(
		`INSERT INTO body_calibration (uuid, profile_id, measured_on, source${fields.map((f) => `, ${f}`).join("")})
		 VALUES (?, ?, ?, ?${fields.map(() => ", ?").join("")})`,
		[uuid, profileId, measuredOn, source, ...fields.map((f) => values[f])]
	);
	return toPublic({ uuid, measured_on: measuredOn, source, ...values });
}

async function remove(profileId, uuid) {
	const [result] = await pool.query(
		`UPDATE body_calibration SET deleted_at = NOW(3) WHERE uuid = ? AND profile_id = ? AND deleted_at IS NULL`,
		[String(uuid || ""), profileId]
	);
	return result.affectedRows > 0;
}

module.exports = { list, add, remove, MEASURES };
