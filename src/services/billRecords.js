const { randomUUID, createHash } = require("node:crypto");
const pool = require("../helpers/db");

/**
 * What a scanned bill becomes in the database (docs/capabilities/vehicles.md,
 * property-taxes.md). Everything here is a plain write on the caller's own
 * rows; none of it is reachable except through an approved action
 * (services/actions/registry.js record_vehicle_bill / record_property_tax_bill)
 * or the person's own taps (marking an installment paid, removing a record).
 *
 * No dependency on the action layer, so the registry can use it.
 */

// Stored in notes (no new column): the client keeps escrowed taxes off the Home banner.
const ESCROW_NOTE = "Escrowed: your mortgage company pays this.";
const DAY = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const isDay = (v) => typeof v === "string" && DATE_ONLY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const todayUtc = () => new Date().toISOString().slice(0, 10);

/** The same date a year on, the "Renewed?" roll-forward (companion api/propertyVehicles.ts yearAfter). Feb 29 lands on Mar 1. */
function yearAfter(day) {
	const [y, m, d] = day.split("-").map(Number);
	return new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10);
}

/** "11/30" or, for another year, "11/30/2027" — enough to catch a wrong date on a card. */
function shortDay(day, { year = false } = {}) {
	const [y, m, d] = day.split("-").map(Number);
	return year ? `${m}/${d}/${y}` : `${m}/${d}`;
}

const money = (n) => (n == null ? "" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 })}`);

const loose = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** One key per tax record, so a second bill for the same tax year updates the record instead of adding another. */
function taxKey({ kind, jurisdiction, parcel, account, vehicleUuid, taxYear }) {
	const who = kind === "vehicle" ? vehicleUuid : parcel || account;
	return [kind, loose(jurisdiction), loose(who).replace(/ /g, ""), taxYear || ""].join("|").slice(0, 190);
}

/** A bill's identity: the same bill scanned twice hashes the same, whatever words the model used. */
function fingerprint(parts) {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// ---------------------------------------------------------------------------
// Ownership lookups
// ---------------------------------------------------------------------------

async function ownVehicle(profileId, uuid) {
	const [rows] = await pool.query(
		`SELECT id, uuid, property_uuid, name, year, make, model, color, plate, vin,
		        registration_state, registration_number, notes, DATE_FORMAT(registration_due, '%Y-%m-%d') AS registration_due
		 FROM athena_property_vehicle WHERE profile_id = ? AND uuid = ? LIMIT 1`,
		[profileId, String(uuid || "")]
	);
	return rows[0] || null;
}

async function vehicles(profileId) {
	const [rows] = await pool.query(
		`SELECT id, uuid, property_uuid, name, year, make, model, color, plate, vin,
		        registration_state, registration_number, DATE_FORMAT(registration_due, '%Y-%m-%d') AS registration_due
		 FROM athena_property_vehicle WHERE profile_id = ? ORDER BY created_at, id LIMIT 20`,
		[profileId]
	);
	return rows;
}

/** { uuid, name, address }: only those two keys are read from the details JSON, which also holds the images. */
async function properties(profileId) {
	const [rows] = await pool.query("SELECT uuid, details FROM athena_property WHERE profile_id = ? ORDER BY uuid", [profileId]);
	return rows.map((r) => {
		let d = {};
		try { d = JSON.parse(r.details) || {}; } catch { /* unreadable details: still a property */ }
		return { uuid: r.uuid, name: d.name || "Your property", address: d.address || "" };
	});
}

const ownProperty = async (profileId, uuid) => (await properties(profileId)).find((p) => p.uuid === uuid) || null;

// ---------------------------------------------------------------------------
// The scan log and "scanning it twice does nothing"
// ---------------------------------------------------------------------------

/** Log what was read from a photo. The image is never stored — only these fields. */
async function logRead(profileId, docKind, fields) {
	const uuid = randomUUID();
	await pool.query("INSERT INTO athena_bill_scan (uuid, profile_id, doc_kind, fields) VALUES (?, ?, ?, ?)", [uuid, profileId, String(docKind).slice(0, 30), JSON.stringify(fields)]);
	return uuid;
}

/**
 * Attach a bill's fingerprint to its log row. 'applied' means this very bill
 * was already recorded (so there is nothing to propose); 'pending' means an
 * earlier scan of it is still waiting — its row is reused and this one dropped.
 */
async function bindFingerprint(profileId, scanUuid, fp, docKind, fields) {
	const find = async () => (await pool.query("SELECT uuid, status, DATE_FORMAT(applied_at, '%Y-%m-%d') AS applied_on FROM athena_bill_scan WHERE profile_id = ? AND fingerprint = ? LIMIT 1", [profileId, fp]))[0][0];
	let existing = await find();
	if (!existing) {
		try {
			if (scanUuid) {
				await pool.query("UPDATE athena_bill_scan SET fingerprint = ?, doc_kind = ?, fields = ?, status = 'proposed' WHERE uuid = ? AND profile_id = ?", [fp, String(docKind).slice(0, 30), JSON.stringify(fields), scanUuid, profileId]);
			} else {
				await pool.query("INSERT INTO athena_bill_scan (uuid, profile_id, fingerprint, doc_kind, fields, status) VALUES (?, ?, ?, ?, ?, 'proposed')", [randomUUID(), profileId, fp, String(docKind).slice(0, 30), JSON.stringify(fields)]);
			}
			return { state: "new" };
		} catch (err) {
			if (err.code !== "ER_DUP_ENTRY") throw err;
			existing = await find();
		}
	}
	if (scanUuid && existing.uuid !== scanUuid) await pool.query("DELETE FROM athena_bill_scan WHERE uuid = ? AND profile_id = ? AND fingerprint IS NULL", [scanUuid, profileId]);
	return existing.status === "applied" ? { state: "applied", appliedOn: existing.applied_on } : { state: "pending" };
}

/** Link the proposal card to the log row, so the approval can be traced from the extraction. */
async function linkAction(profileId, fp, actionUuid) {
	await pool.query("UPDATE athena_bill_scan SET action_uuid = ? WHERE profile_id = ? AND fingerprint = ? AND status <> 'applied'", [actionUuid, profileId, fp]);
}

/**
 * The executor's claim: exactly one approval wins per bill. A second card for
 * the same bill (both approved) finds it already applied and stops before
 * touching the calendar.
 */
async function claim(profileId, fp) {
	const [res] = await pool.query("UPDATE athena_bill_scan SET status = 'applied', applied_at = NOW() WHERE profile_id = ? AND fingerprint = ? AND status <> 'applied'", [profileId, fp]);
	if (res.affectedRows) return;
	const [rows] = await pool.query("SELECT status FROM athena_bill_scan WHERE profile_id = ? AND fingerprint = ? LIMIT 1", [profileId, fp]);
	if (rows[0]) throw Object.assign(new Error("That bill is already recorded"), { status: 409 });
	// The log row was cleaned up since the proposal; record the claim itself.
	await pool.query("INSERT INTO athena_bill_scan (uuid, profile_id, fingerprint, doc_kind, status, applied_at) VALUES (?, ?, ?, 'bill', 'applied', NOW())", [randomUUID(), profileId, fp]);
}

/** A failed apply gives the claim back, so approving a retry works. */
async function release(profileId, fp) {
	await pool.query("UPDATE athena_bill_scan SET status = 'proposed', applied_at = NULL WHERE profile_id = ? AND fingerprint = ?", [profileId, fp]).catch(() => {});
}

async function noteApplied(profileId, fp, { actionUuid, calendarRefs }) {
	await pool.query("UPDATE athena_bill_scan SET action_uuid = COALESCE(?, action_uuid), calendar_refs = ? WHERE profile_id = ? AND fingerprint = ?", [actionUuid || null, JSON.stringify(calendarRefs || []), profileId, fp]).catch(() => {});
}

// ---------------------------------------------------------------------------
// Tax records
// ---------------------------------------------------------------------------

/**
 * Insert or update a tax record and its installments. Installments are matched
 * by due date; a paid date is only ever set, never cleared, by a bill.
 * t: { kind, propertyUuid, vehicleUuid, jurisdiction, parcel, account, taxYear, amount, address,
 *      installments: [{ label, dueOn, amount, paidOn }] }
 */
async function upsertTax(profileId, t) {
	const key = taxKey(t);
	await pool.query(
		`INSERT INTO athena_property_tax (uuid, profile_id, property_uuid, kind, vehicle_uuid, jurisdiction, parcel, account, tax_year, amount, address, record_key, notes)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE amount = COALESCE(VALUES(amount), amount), address = COALESCE(VALUES(address), address),
		   property_uuid = COALESCE(VALUES(property_uuid), property_uuid), parcel = COALESCE(VALUES(parcel), parcel), account = COALESCE(VALUES(account), account), notes = COALESCE(VALUES(notes), notes)`,
		[randomUUID(), profileId, t.propertyUuid || null, t.kind, t.vehicleUuid || null, String(t.jurisdiction).slice(0, 160), t.parcel || null, t.account || null,
			t.taxYear || null, t.amount ?? null, t.address ? String(t.address).slice(0, 240) : null, key, t.notes || null]
	);
	const [[row]] = await pool.query("SELECT id, uuid FROM athena_property_tax WHERE profile_id = ? AND record_key = ?", [profileId, key]);
	for (const i of t.installments || []) {
		await pool.query(
			`INSERT INTO athena_property_tax_installment (uuid, tax_id, label, due_on, amount, paid_on) VALUES (?, ?, ?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE label = VALUES(label), amount = COALESCE(VALUES(amount), amount), paid_on = COALESCE(VALUES(paid_on), paid_on)`,
			[randomUUID(), row.id, String(i.label || "Due").slice(0, 60), i.dueOn, i.amount ?? null, i.paidOn || null]
		);
	}
	return row.uuid;
}

/** The vehicle bill: the registration date moves, and any vehicle tax the bill carries is recorded. */
async function applyVehicle(profileId, p) {
	const vehicle = await ownVehicle(profileId, p.vehicle_uuid);
	if (!vehicle) throw new Error("That vehicle is no longer on your list");
	await pool.query("UPDATE athena_property_vehicle SET registration_due = ? WHERE id = ? AND profile_id = ?", [p.registration_due, vehicle.id, profileId]);
	let taxUuid = null;
	if (p.tax) {
		taxUuid = await upsertTax(profileId, {
			kind: "vehicle", vehicleUuid: vehicle.uuid, propertyUuid: vehicle.property_uuid, jurisdiction: p.tax.jurisdiction || p.payee || "Vehicle tax",
			taxYear: p.tax.tax_year, amount: p.tax.amount,
			installments: [{ label: p.paid ? "Paid" : "Registration & tax", dueOn: p.tax.due_on, amount: p.tax.amount, paidOn: p.paid ? p.paid_on : null }],
		});
	}
	return { vehicle: vehicle.uuid, tax: taxUuid };
}

const NOTES_MAX = 4000;

/** Append a dated line to the vehicle's notes (which she reads), never past the notes limit. */
async function applyVehicleNotice(profileId, p) {
	const vehicle = await ownVehicle(profileId, p.vehicle_uuid);
	if (!vehicle) throw new Error("That vehicle is no longer on your list");
	const [res] = await pool.query(
		"UPDATE athena_property_vehicle SET notes = CONCAT_WS(CHAR(10), NULLIF(notes, ''), ?) WHERE id = ? AND profile_id = ? AND CHAR_LENGTH(COALESCE(notes, '')) + ? <= ?",
		[p.note_line, vehicle.id, profileId, p.note_line.length + 1, NOTES_MAX]
	);
	if (!res.affectedRows) throw new Error("That vehicle's notes are full — remove something from them first");
	return { vehicle: vehicle.uuid };
}

/** The property tax bill (or its receipt): the record, with each installment's due date and paid state. */
async function applyTax(profileId, p) {
	const property = await ownProperty(profileId, p.property_uuid);
	if (!property) throw new Error("That property is no longer on your list");
	const uuid = await upsertTax(profileId, {
		kind: "property", propertyUuid: property.uuid, jurisdiction: p.jurisdiction, parcel: p.parcel, account: p.account, taxYear: p.tax_year, amount: p.amount,
		address: p.address, notes: p.escrowed ? ESCROW_NOTE : null, installments: p.installments.map((i) => ({ label: i.label, dueOn: i.due_on, amount: i.amount, paidOn: p.paid ? p.paid_on : null })),
	});
	return { property: property.uuid, tax: uuid };
}

const iso = (v) => (v instanceof Date ? v.toISOString() : v ? new Date(`${String(v).replace(" ", "T")}Z`).toISOString() : null);
const num = (v) => (v == null ? null : Number(v));

/** Every tax record with its installments, soonest unpaid due date first. */
async function listTaxes(profileId) {
	const [rows] = await pool.query(
		`SELECT id, uuid, property_uuid, kind, vehicle_uuid, jurisdiction, parcel, account, tax_year, amount, address, notes, created_at, updated_at
		 FROM athena_property_tax WHERE profile_id = ? ORDER BY tax_year DESC, created_at DESC, id DESC LIMIT 200`, [profileId]);
	if (!rows.length) return [];
	const [inst] = await pool.query(
		`SELECT tax_id, uuid, label, DATE_FORMAT(due_on, '%Y-%m-%d') AS due_on, amount, DATE_FORMAT(paid_on, '%Y-%m-%d') AS paid_on
		 FROM athena_property_tax_installment WHERE tax_id IN (?) ORDER BY due_on, id`, [rows.map((r) => r.id)]);
	const [cars] = await pool.query("SELECT uuid, name FROM athena_property_vehicle WHERE profile_id = ?", [profileId]).catch(() => [[]]);
	const carName = new Map(cars.map((c) => [c.uuid, c.name]));
	return rows.map((r) => ({
		uuid: r.uuid, kind: r.kind, propertyUuid: r.property_uuid, vehicleUuid: r.vehicle_uuid, vehicleName: r.vehicle_uuid ? carName.get(r.vehicle_uuid) || null : null,
		jurisdiction: r.jurisdiction, parcel: r.parcel, account: r.account, taxYear: r.tax_year, amount: num(r.amount), address: r.address, notes: r.notes,
		createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
		installments: inst.filter((i) => i.tax_id === r.id).map((i) => ({ uuid: i.uuid, label: i.label, dueOn: i.due_on, amount: num(i.amount), paidOn: i.paid_on })),
	}));
}

/** Mark an installment paid (a date) or unpaid (null), on the person's own record. */
async function setInstallmentPaid(profileId, taxUuid, installmentUuid, paidOn) {
	const [res] = await pool.query(
		`UPDATE athena_property_tax_installment i JOIN athena_property_tax t ON t.id = i.tax_id
		 SET i.paid_on = ? WHERE t.profile_id = ? AND t.uuid = ? AND i.uuid = ?`,
		[paidOn, profileId, String(taxUuid || ""), String(installmentUuid || "")]);
	return res.affectedRows > 0;
}

async function removeTax(profileId, uuid) {
	const [res] = await pool.query("DELETE FROM athena_property_tax WHERE profile_id = ? AND uuid = ?", [profileId, String(uuid || "")]);
	return res.affectedRows > 0;
}

/** Unpaid installments for a record key, for matching a paid receipt to what it paid. */
async function unpaidFor(profileId, key) {
	const [rows] = await pool.query(
		`SELECT i.uuid, i.label, DATE_FORMAT(i.due_on, '%Y-%m-%d') AS due_on, i.amount FROM athena_property_tax_installment i
		 JOIN athena_property_tax t ON t.id = i.tax_id WHERE t.profile_id = ? AND t.record_key = ? AND i.paid_on IS NULL ORDER BY i.due_on`, [profileId, key]);
	return rows.map((r) => ({ uuid: r.uuid, label: r.label, dueOn: r.due_on, amount: num(r.amount) }));
}

/** Parcel numbers already on this person's property records, for matching a new bill to its property. */
async function propertyForParcel(profileId, parcel) {
	if (!parcel) return null;
	const [rows] = await pool.query("SELECT property_uuid FROM athena_property_tax WHERE profile_id = ? AND kind = 'property' AND parcel IS NOT NULL AND property_uuid IS NOT NULL", [profileId]).catch(() => [[]]);
	const hit = rows.filter((r) => loose(r.parcel) === loose(parcel));
	return hit[0]?.property_uuid || null;
}

/** Unpaid tax installments, for Athena's prompt. Read-only; never throws. */
async function promptTaxes(profileId, limit = 6) {
	try {
		const [rows] = await pool.query(
			`SELECT t.kind, t.jurisdiction, t.tax_year, DATE_FORMAT(i.due_on, '%Y-%m-%d') AS due_on, i.label, i.amount
			 FROM athena_property_tax_installment i JOIN athena_property_tax t ON t.id = i.tax_id
			 WHERE t.profile_id = ? AND i.paid_on IS NULL ORDER BY i.due_on LIMIT ?`, [profileId, limit]);
		return rows.map((r) => ({ kind: r.kind, jurisdiction: r.jurisdiction, taxYear: r.tax_year, dueOn: r.due_on, label: r.label, amount: num(r.amount) }));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Calendar drafts
// ---------------------------------------------------------------------------

/**
 * Raw all-day events for a due date, and a reminder `remindDays` earlier. These
 * go through create_calendar_event's own normalize() in the registry, so they
 * can never be something that action would refuse. A date already past gets
 * none: the calendar action does not write into the past.
 * The description carries the payee and the amount only — never a plate,
 * parcel or account number, because calendars are read by other people.
 */
function eventDrafts({ title, dueOn, remindDays, today = todayUtc(), note }) {
	const events = [];
	const base = (t, day) => ({ title: t, all_day: true, start: day, end: day, description: note });
	if (dueOn >= today) events.push(base(title, dueOn));
	const remindOn = remindDays > 0 ? addDays(dueOn, -remindDays) : null;
	if (remindOn && remindOn >= today && dueOn >= today) events.push(base(`Due in ${remindDays} days: ${title}`, remindOn));
	return events;
}

module.exports = {
	isDay, addDays, yearAfter, shortDay, money, loose, taxKey, fingerprint, todayUtc,
	ownVehicle, vehicles, properties, ownProperty,
	logRead, bindFingerprint, linkAction, claim, release, noteApplied,
	upsertTax, applyVehicle, applyVehicleNotice, NOTES_MAX, applyTax, listTaxes, setInstallmentPaid, removeTax, unpaidFor, propertyForParcel, promptTaxes,
	eventDrafts,
};
