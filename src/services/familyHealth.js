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
const { v4: uuidv4 } = require("uuid");
const pool = require("../helpers/db");
const family = require("./family");

const SEVERITIES = new Set(["mild", "moderate", "severe"]);

function trim(value, max) {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function failure(message, status) {
	return Object.assign(new Error(message), { status });
}

function daysActive(startedAt) {
	const started = new Date(`${String(startedAt).slice(0, 10)}T00:00:00Z`);
	if (Number.isNaN(started.getTime())) return 1;
	return Math.max(1, Math.floor((Date.now() - started.getTime()) / 86_400_000) + 1);
}

function publicStatus(row) {
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
	const notes = trim(payload.notes, 500);
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
			`UPDATE family_health_status SET symptom = ?, severity = ?, notes = ? WHERE id = ?;`,
			[symptom, severity, notes, id]
		);
	} else {
		const uuid = uuidv4();
		const [result] = await pool.query(
			`INSERT INTO family_health_status
         (uuid, family_id, person_name, symptom, severity, status, started_at, notes, reported_by_profile_id)
       VALUES (?, ?, ?, ?, ?, 'active', CURDATE(), ?, ?);`,
			[uuid, familyId, personName, symptom, severity, notes, profileId]
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
	return rows.map(publicStatus);
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
			`- ${a.personName}: ${a.symptom} (${a.severity}, day ${a.daysActive})${a.notes ? ` — ${a.notes}` : ""}`
	);
	return [
		"# Family health watch",
		"",
		"Someone in the family is currently reported under the weather:",
		...lines,
		"",
		"Be aware of this in conversation. Where it fits naturally — never as a lecture, never a diagnosis — encourage ordinary precautions to keep it from spreading to the rest of the family: handwashing, not sharing cups or towels, wiping down shared surfaces, extra rest. Ask how they're doing if it comes up naturally. Don't bring this up out of nowhere in an unrelated conversation, and don't repeat the same reminder every message.",
	].join("\n");
}

module.exports = { report, activeFor, resolve, promptBlock, SEVERITIES };
