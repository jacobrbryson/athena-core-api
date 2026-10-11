/**
 * Family health watch — "someone is under the weather", tracked per family
 * rather than per person, so the companion dashboard and Athena's chat
 * context can be aware of it without the person repeating themselves every
 * conversation.
 *
 * Deliberately not a diagnosis log: one row per person while a symptom is
 * active, free-text symptom/notes, and no medical inference anywhere in this
 * file. The precaution wording lives in promptBlock() and in the
 * `family_illness_precaution` initiative trigger — both instruct Athena to
 * suggest ordinary household hygiene, never to diagnose.
 */
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../helpers/db");
const family = require("./family");

const SEVERITIES = new Set(["mild", "moderate", "severe"]);
/** A week between check-ins is the most that is still "keeping an eye on it". */
const MAX_CHECK_IN_HOURS = 168;
const HOUR = 3_600_000;

function trim(value, max) {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function failure(message, status) {
	return Object.assign(new Error(message), { status });
}

/** Whole hours from 1 to a week, or null for "no check-ins". Anything else is refused, not clamped. */
function checkInHours(value) {
	if (value === null || value === undefined || value === "") return null;
	const hours = Number(value);
	if (!Number.isInteger(hours) || hours < 1 || hours > MAX_CHECK_IN_HOURS) {
		throw failure(`Check-ins must be every 1 to ${MAX_CHECK_IN_HOURS} hours.`, 400);
	}
	return hours;
}

/** A DATETIME from mysql2 (Date) or a string, as an instant; null if absent. */
function instant(value) {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function daysActive(startedAt) {
	const started = new Date(`${String(startedAt).slice(0, 10)}T00:00:00Z`);
	if (Number.isNaN(started.getTime())) return 1;
	return Math.max(1, Math.floor((Date.now() - started.getTime()) / 86_400_000) + 1);
}

function publicStatus(row, now = Date.now()) {
	const hours = row.check_in_hours ? Number(row.check_in_hours) : null;
	const last = instant(row.last_update_at) || instant(row.updated_at);
	const due = hours && last ? new Date(last.getTime() + hours * HOUR) : null;
	return {
		uuid: row.uuid,
		personName: row.person_name,
		symptom: row.symptom,
		severity: row.severity,
		status: row.status,
		startedAt: row.started_at,
		resolvedAt: row.resolved_at,
		notes: row.notes,
		daysActive: daysActive(row.started_at),
		checkInHours: hours,
		lastUpdateAt: last ? last.toISOString() : null,
		nextUpdateAt: due ? due.toISOString() : null,
		updateDue: Boolean(due && due.getTime() <= now),
	};
}

/** The family a profile belongs to as parent/owner, or null. Never throws. */
async function familyIdFor(profileId) {
	try {
		const fam = await family.getFamilyForProfile(profileId);
		return fam ? fam.id : null;
	} catch {
		return null;
	}
}

/**
 * The family id for a report, provisioning a bare family if this is a
 * companion-only adult who has never run the family/child setup flow — a
 * household health note is not worth blocking on that.
 */
async function ensureFamilyId(profileId) {
	const existing = await familyIdFor(profileId);
	if (existing) return existing;
	const uuid = uuidv4();
	const [result] = await pool.query(
		`INSERT INTO families (uuid, name, created_by_profile_id) VALUES (?, ?, ?);`,
		[uuid, "My Family", profileId]
	);
	await pool.query(
		`INSERT INTO family_members (family_id, profile_id, role, status)
     VALUES (?, ?, 'owner', 'active')
     ON DUPLICATE KEY UPDATE role = 'owner', deleted_at = NULL;`,
		[result.insertId, profileId]
	);
	return result.insertId;
}

/** Report (or update) a family member's symptom. One active row per person. */
async function report(profileId, payload = {}) {
	const personName = trim(payload.personName, 120);
	const symptom = trim(payload.symptom, 200);
	if (!personName || !symptom) {
		throw failure("A name and what you noticed are both required.", 400);
	}
	const severity = SEVERITIES.has(payload.severity) ? payload.severity : "mild";
	// Omitted keeps the watch's last note (an update with no new reading); null clears it.
	const keepNotes = !Object.prototype.hasOwnProperty.call(payload, "notes");
	const notes = trim(payload.notes, 500);
	// Omitted keeps whatever cadence an active watch already has; null turns check-ins off.
	const keepHours = !Object.prototype.hasOwnProperty.call(payload, "checkInHours");
	const hours = keepHours ? null : checkInHours(payload.checkInHours);
	const familyId = await ensureFamilyId(profileId);

	const [existing] = await pool.query(
		`SELECT id FROM family_health_status
     WHERE family_id = ? AND status = 'active' AND deleted_at IS NULL AND LOWER(person_name) = LOWER(?)
     LIMIT 1;`,
		[familyId, personName]
	);
	let id;
	if (existing.length) {
		id = existing[0].id;
		await pool.query(
			`UPDATE family_health_status
         SET symptom = ?, severity = ?, notes = IF(?, notes, ?),
             check_in_hours = IF(?, check_in_hours, ?), last_update_at = NOW()
       WHERE id = ?;`,
			[symptom, severity, keepNotes, notes, keepHours, hours, id]
		);
	} else {
		const uuid = uuidv4();
		const [result] = await pool.query(
			`INSERT INTO family_health_status
         (uuid, family_id, person_name, symptom, severity, status, started_at, notes,
          check_in_hours, last_update_at, reported_by_profile_id)
       VALUES (?, ?, ?, ?, ?, 'active', CURDATE(), ?, ?, NOW(), ?);`,
			[uuid, familyId, personName, symptom, severity, notes, hours, profileId]
		);
		id = result.insertId;
	}
	const [rows] = await pool.query(`SELECT * FROM family_health_status WHERE id = ?;`, [id]);
	return publicStatus(rows[0]);
}

/** Active statuses for the family this profile belongs to. [] if no family yet. */
async function activeFor(profileId) {
	const familyId = await familyIdFor(profileId);
	if (!familyId) return [];
	const [rows] = await pool.query(
		`SELECT * FROM family_health_status
     WHERE family_id = ? AND status = 'active' AND deleted_at IS NULL
     ORDER BY started_at ASC;`,
		[familyId]
	);
	return rows.map((row) => publicStatus(row));
}

/**
 * The active watch a name refers to: an exact (case-insensitive) match, else
 * the only watch whose first name matches ("Thomas" for "Thomas Bryson").
 * Null when there is none or it is ambiguous — a guess would log a reading
 * against the wrong child.
 */
async function findActive(profileId, name) {
	const wanted = trim(name, 120)?.toLowerCase();
	if (!wanted) return null;
	const active = await activeFor(profileId);
	const exact = active.find((a) => a.personName.toLowerCase() === wanted);
	if (exact) return exact;
	const first = (n) => n.toLowerCase().split(/\s+/)[0];
	const byFirst = active.filter((a) => first(a.personName) === first(wanted));
	return byFirst.length === 1 ? byFirst[0] : null;
}

/** Mark one status resolved. Returns null if it doesn't belong to this profile's family. */
async function resolve(profileId, uuid) {
	const familyId = await familyIdFor(profileId);
	if (!familyId) return null;
	await pool.query(
		`UPDATE family_health_status SET status = 'resolved', resolved_at = CURDATE()
     WHERE uuid = ? AND family_id = ? AND status = 'active';`,
		[uuid, familyId]
	);
	const [rows] = await pool.query(
		`SELECT * FROM family_health_status WHERE uuid = ? AND family_id = ?;`,
		[uuid, familyId]
	);
	return rows[0] ? publicStatus(rows[0]) : null;
}

/**
 * What Athena should know and do about it, for the chat system prompt.
 * Null when nobody in the family is currently reported unwell.
 */
async function promptBlock(profileId) {
	const active = await activeFor(profileId).catch(() => []);
	if (!active.length) return null;
	const lines = active.map(
		(a) =>
			`- ${a.personName}: ${a.symptom} (${a.severity}, day ${a.daysActive})${a.notes ? ` — ${a.notes}` : ""}${checkInLine(a)}`
	);
	const due = active.filter((a) => a.updateDue);
	return [
		"# Family health watch",
		"",
		"Someone in the family is currently reported under the weather:",
		...lines,
		"",
		"Be aware of this in conversation. Where it fits naturally — never as a lecture, never a diagnosis — encourage ordinary precautions to keep it from spreading to the rest of the family: handwashing, not sharing cups or towels, wiping down shared surfaces, extra rest. Ask how they're doing if it comes up naturally. Don't bring this up out of nowhere in an unrelated conversation, and don't repeat the same reminder every message.",
		...(due.length
			? [
					"",
					`An update is due on ${due.map((a) => a.personName).join(" and ")}. If the conversation allows, ask how they're doing — the reading or dose they wanted to keep track of — and when they tell you, propose log_health_update with what they said. They can also log it on the Family page (People & pets → Health watch).`,
			  ]
			: []),
	].join("\n");
}

/** " · updates wanted every 4h, last 5h ago (update due)" — empty when no check-ins were asked for. */
function checkInLine(a) {
	if (!a.checkInHours) return "";
	const ago = a.lastUpdateAt ? Math.max(0, Math.round((Date.now() - Date.parse(a.lastUpdateAt)) / HOUR)) : null;
	return ` · updates wanted every ${a.checkInHours}h${ago !== null ? `, last ${ago}h ago` : ""}${a.updateDue ? " (update due)" : ""}`;
}

module.exports = { report, activeFor, findActive, resolve, promptBlock, SEVERITIES, MAX_CHECK_IN_HOURS };
