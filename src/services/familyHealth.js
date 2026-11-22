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
const schedules = require("./familyHealthSchedules");

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

/** A DATE column as YYYY-MM-DD, whether mysql2 gave a Date or a string. */
function dateOnly(value) {
	if (!value) return null;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
	return String(value).slice(0, 10);
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
		startedAt: dateOnly(row.started_at),
		resolvedAt: dateOnly(row.resolved_at),
		endsOn: dateOnly(row.ends_on),
		timeZone: row.time_zone || null,
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

	// `newWatch`: the app's "Start a health watch" — always a watch of its
	// own, so one person can be watched for two things at once (a cough and,
	// separately, a rash). Without it (chat, older clients) a report on someone
	// already watched is an update to that watch.
	const [found] = payload.newWatch === true
		? [[]]
		: await pool.query(
				`SELECT id, symptom FROM family_health_status
     WHERE family_id = ? AND status = 'active' AND deleted_at IS NULL AND LOWER(person_name) = LOWER(?)
     ORDER BY id ASC;`,
				[familyId, personName]
		  );
	let existing = found;
	if (found.length > 1) {
		// Two watches on one person: only the one whose symptom this names. A
		// guess would put a reading on the wrong one.
		existing = found.filter((r) => String(r.symptom).toLowerCase() === symptom.toLowerCase());
		if (existing.length !== 1) {
			throw failure(`${personName} has more than one health watch — log this on the right one's page in the app.`, 409);
		}
	}
	let id;
	let kind = "update";
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
		kind = "started";
	}
	await logEntry({ id, family_id: familyId }, profileId, { kind, symptom, severity, note: notes });
	const [rows] = await pool.query(`SELECT * FROM family_health_status WHERE id = ?;`, [id]);
	return publicStatus(rows[0]);
}

/**
 * One line in a watch's history. Never fails the save it follows: a history
 * row that couldn't be written is logged, and the watch itself still holds
 * the latest update.
 */
async function logEntry(watch, profileId, { kind, symptom = null, severity = null, note = null, at = null }) {
	try {
		await pool.query(
			`INSERT INTO family_health_entry
			   (uuid, status_id, family_id, kind, symptom, severity, note, logged_at, logged_by_profile_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()), ?);`,
			[uuidv4(), watch.id, watch.family_id, kind, symptom, severity, note, at, profileId]
		);
	} catch (err) {
		console.warn("[familyHealth] couldn't write the history line:", err.message);
	}
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
	const checks = await schedules.forWatches(rows).catch(() => new Map());
	return rows.map((row) => withChecks(publicStatus(row), checks.get(row.id) || []));
}

/** The soonest waiting check and how many are overdue, for the chip and the prompt. */
function withChecks(status, list) {
	const live = list.filter((c) => c.nextDueAt);
	const next = live[0] || null;
	return {
		...status,
		nextCheck: next ? { label: next.label, kind: next.kind, dueAt: next.nextDueAt, overdue: next.overdue } : null,
		checksOverdue: live.filter((c) => c.overdue).length,
		checkCount: live.length,
	};
}

/**
 * The active watch a name refers to: an exact (case-insensitive) match, else
 * the only watch whose first name matches ("Thomas" for "Thomas Bryson").
 * Null when there is none or it is ambiguous — including when one person has
 * two watches — a guess would log a reading
 * against the wrong child.
 */
async function findActive(profileId, name) {
	const wanted = trim(name, 120)?.toLowerCase();
	if (!wanted) return null;
	const active = await activeFor(profileId);
	const exact = active.filter((a) => a.personName.toLowerCase() === wanted);
	// Two watches on the same person (a cough and a rash): no single answer.
	if (exact.length) return exact.length === 1 ? exact[0] : null;
	const first = (n) => n.toLowerCase().split(/\s+/)[0];
	const byFirst = active.filter((a) => first(a.personName) === first(wanted));
	return byFirst.length === 1 ? byFirst[0] : null;
}

/** Mark one status resolved. Returns null if it doesn't belong to this profile's family. */
async function resolve(profileId, uuid) {
	const familyId = await familyIdFor(profileId);
	if (!familyId) return null;
	const [ended] = await pool.query(
		`UPDATE family_health_status SET status = 'resolved', resolved_at = CURDATE()
     WHERE uuid = ? AND family_id = ? AND status = 'active';`,
		[uuid, familyId]
	);
	const [rows] = await pool.query(
		`SELECT * FROM family_health_status WHERE uuid = ? AND family_id = ?;`,
		[uuid, familyId]
	);
	if (rows[0] && ended?.affectedRows) await logEntry(rows[0], profileId, { kind: "ended", note: "Feeling better" });
	return rows[0] ? publicStatus(rows[0]) : null;
}

/** The status row for a watch in this profile's family — active or ended — or a 404. */
async function watchRow(profileId, uuid) {
	const familyId = await familyIdFor(profileId);
	if (familyId) {
		const [rows] = await pool.query(
			`SELECT * FROM family_health_status WHERE uuid = ? AND family_id = ? AND deleted_at IS NULL LIMIT 1;`,
			[String(uuid || ""), familyId]
		);
		if (rows[0]) return rows[0];
	}
	throw failure("That health watch isn't here.", 404);
}

function publicEntry(row) {
	return {
		uuid: row.uuid,
		kind: row.kind,
		symptom: row.symptom,
		severity: row.severity,
		note: row.note,
		checkLabel: row.check_label || null,
		dueAt: instant(row.due_at)?.toISOString() || null,
		loggedAt: instant(row.logged_at)?.toISOString() || null,
		loggedBy: row.logged_by_name ? String(row.logged_by_name).trim().split(/\s+/)[0] : null,
	};
}

/** Everything the watch's own page shows: the watch, its checks, what's coming, and its history. */
async function detail(profileId, uuid, { now = Date.now() } = {}) {
	const row = await watchRow(profileId, uuid);
	const checks = (await schedules.forWatches([row])).get(row.id) || [];
	const [entries] = await pool.query(
		`SELECT e.*, sc.label AS check_label, p.full_name AS logged_by_name
		   FROM family_health_entry e
		   LEFT JOIN family_health_schedule sc ON sc.id = e.schedule_id
		   LEFT JOIN profile p ON p.id = e.logged_by_profile_id
		  WHERE e.status_id = ? AND e.deleted_at IS NULL
		  ORDER BY e.logged_at DESC, e.id DESC LIMIT 300;`,
		[row.id]
	);
	return {
		status: withChecks(publicStatus(row, now), checks),
		checks,
		upcoming: schedules.upcoming(checks, row, now),
		entries: entries.map(publicEntry),
	};
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function day(value, what) {
	if (value === null || value === "") return null;
	if (typeof value !== "string" || !ISO_DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
		throw failure(`${what} isn't a date I can read.`, 400);
	}
	return value;
}

/**
 * Edit a watch: what it is, how bad, when it started, and when it ends — a
 * planned end on an active watch (checks stop pushing after it), or the day
 * an ended one ended. Omitted fields stay.
 */
async function edit(profileId, uuid, payload = {}) {
	const row = await watchRow(profileId, uuid);
	const has = (k) => Object.prototype.hasOwnProperty.call(payload, k);
	const symptom = has("symptom") ? trim(payload.symptom, 200) : row.symptom;
	if (!symptom) throw failure("Say what you noticed.", 400);
	const severity = has("severity") ? (SEVERITIES.has(payload.severity) ? payload.severity : row.severity) : row.severity;
	const startedAt = has("startedAt") ? day(payload.startedAt, "The start") : dateOnly(row.started_at);
	if (!startedAt) throw failure("A watch needs a start date.", 400);
	const zone = has("timeZone") ? schedules.timeZone(payload.timeZone) || row.time_zone : row.time_zone;
	const today = schedules.localDate(new Date(), zone);
	if (startedAt > today) throw failure("The start can't be in the future.", 400);
	let endsOn = dateOnly(row.ends_on);
	let resolvedAt = dateOnly(row.resolved_at);
	if (has("endsOn")) {
		const end = day(payload.endsOn, "The end");
		if (row.status === "active") endsOn = end;
		else if (!end) throw failure("An ended watch needs an end date.", 400);
		else resolvedAt = end;
	}
	if (endsOn && endsOn < startedAt) throw failure("The end can't be before the start.", 400);
	if (resolvedAt && resolvedAt < startedAt) throw failure("The end can't be before the start.", 400);
	if (resolvedAt && resolvedAt > today) throw failure("An ended watch can't end in the future.", 400);
	await pool.query(
		`UPDATE family_health_status
		    SET symptom = ?, severity = ?, started_at = ?, ends_on = ?, resolved_at = ?, time_zone = ?
		  WHERE id = ?;`,
		[symptom, severity, startedAt, endsOn, resolvedAt, zone, row.id]
	);
	return detail(profileId, uuid);
}

/** Log an update on this watch from its page: a reading, a dose, how they seem. */
async function addUpdate(profileId, uuid, payload = {}) {
	const row = await watchRow(profileId, uuid);
	if (row.status !== "active") throw failure("This watch has ended.", 409);
	const note = trim(payload.note, 500);
	const symptom = trim(payload.symptom, 200) || row.symptom;
	const severity = SEVERITIES.has(payload.severity) ? payload.severity : row.severity;
	if (!note && symptom === row.symptom && severity === row.severity) throw failure("Write what you noticed.", 400);
	await pool.query(
		`UPDATE family_health_status SET symptom = ?, severity = ?, notes = COALESCE(?, notes), last_update_at = NOW() WHERE id = ?;`,
		[symptom, severity, note, row.id]
	);
	await logEntry(row, profileId, { kind: "update", symptom, severity, note });
	return detail(profileId, uuid);
}

/** Take back a mistaken line in the history. The watch itself is unchanged. */
async function removeEntry(profileId, uuid, entryUuid) {
	const row = await watchRow(profileId, uuid);
	const [result] = await pool.query(
		`UPDATE family_health_entry SET deleted_at = NOW() WHERE uuid = ? AND status_id = ? AND deleted_at IS NULL;`,
		[String(entryUuid || ""), row.id]
	);
	if (!result.affectedRows) throw failure("That entry isn't here.", 404);
	return detail(profileId, uuid);
}

/** The watch's check routes, each answering with the refreshed page. */
async function addCheck(profileId, uuid, payload) {
	const row = await watchRow(profileId, uuid);
	await maybeZone(row, payload?.timeZone);
	await schedules.create(profileId, row, payload);
	return detail(profileId, uuid);
}
async function updateCheck(profileId, uuid, checkUuid, payload) {
	const row = await watchRow(profileId, uuid);
	await schedules.update(row, checkUuid, payload);
	return detail(profileId, uuid);
}
async function removeCheck(profileId, uuid, checkUuid) {
	const row = await watchRow(profileId, uuid);
	await schedules.remove(row, checkUuid);
	return detail(profileId, uuid);
}
async function markCheck(profileId, uuid, checkUuid, payload = {}) {
	const row = await watchRow(profileId, uuid);
	await schedules.mark(profileId, row, checkUuid, { skip: payload.skip === true, note: payload.note, at: payload.at });
	return detail(profileId, uuid);
}

/** Remember the zone the person is in, the first time we hear it (so "until Friday" is their Friday). */
async function maybeZone(row, value) {
	const zone = schedules.timeZone(value);
	if (!zone || zone === row.time_zone) return;
	await pool.query(`UPDATE family_health_status SET time_zone = ? WHERE id = ?;`, [zone, row.id]);
	row.time_zone = zone;
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
			`- ${a.personName}: ${a.symptom} (${a.severity}, day ${a.daysActive})${a.notes ? ` — ${a.notes}` : ""}${checkInLine(a)}${checksLine(a)}`
	);
	const due = active.filter((a) => a.updateDue);
	const names = active.map((a) => a.personName.toLowerCase());
	const doubled = [...new Set(active.filter((a) => names.filter((n) => n === a.personName.toLowerCase()).length > 1).map((a) => a.personName))];
	return [
		"# Family health watch",
		"",
		"Someone in the family is currently reported under the weather:",
		...lines,
		"",
		"Be aware of this in conversation. Where it fits naturally — never as a lecture, never a diagnosis — encourage ordinary precautions to keep it from spreading to the rest of the family: handwashing, not sharing cups or towels, wiping down shared surfaces, extra rest. Ask how they're doing if it comes up naturally. Don't bring this up out of nowhere in an unrelated conversation, and don't repeat the same reminder every message.",
		...(doubled.length
			? [
					"",
					`${doubled.join(" and ")} ${doubled.length === 1 ? "has" : "have"} more than one health watch. To log an update on one from chat, use that watch's exact symptom as health_symptom; if it isn't clear which one they mean, ask.`,
			  ]
			: []),
		...(due.length
			? [
					"",
					`An update is due on ${due.map((a) => a.personName).join(" and ")}. If the conversation allows, ask how they're doing — the reading or dose they wanted to keep track of — and when they tell you, propose log_health_update with what they said. They can also log it on the Family page (People & pets → Health watch).`,
			  ]
			: []),
	].join("\n");
}

/** " · next check: Tylenol at 2026-11-22T18:00:00.000Z (1 overdue)" — empty when the watch has no recurring checks. */
function checksLine(a) {
	if (!a.nextCheck) return "";
	return ` · ${a.checkCount} recurring check${a.checkCount === 1 ? "" : "s"}, next: ${a.nextCheck.label} at ${a.nextCheck.dueAt}${a.checksOverdue ? ` (${a.checksOverdue} overdue — they tick these off on the person's health watch page; you can't tick them off from chat)` : ""}`;
}

/** " · updates wanted every 4h, last 5h ago (update due)" — empty when no check-ins were asked for. */
function checkInLine(a) {
	if (!a.checkInHours) return "";
	const ago = a.lastUpdateAt ? Math.max(0, Math.round((Date.now() - Date.parse(a.lastUpdateAt)) / HOUR)) : null;
	return ` · updates wanted every ${a.checkInHours}h${ago !== null ? `, last ${ago}h ago` : ""}${a.updateDue ? " (update due)" : ""}`;
}

module.exports = {
	report,
	activeFor,
	findActive,
	resolve,
	detail,
	edit,
	addUpdate,
	removeEntry,
	addCheck,
	updateCheck,
	removeCheck,
	markCheck,
	promptBlock,
	SEVERITIES,
	MAX_CHECK_IN_HOURS,
};
