/**
 * Recurring checks on a family health watch — "check his temperature every
 * 6 hours, Tylenol every 12" (owner, 2026-11-22).
 *
 * A schedule holds one waiting occurrence, `next_due_at`. Ticking it off in
 * the app moves it on to (when it was actually done) + every_hours, so a dose
 * given late never puts the next one too close behind it; skipping moves it
 * on from when it was due. Both write a row to the watch's history
 * (family_health_entry), which is what "progress reports" lists.
 *
 * ## The push
 *
 * When an occurrence comes due and nobody has ticked it off, the person who
 * set the check gets one push for it — the same path as a time reminder
 * (services/timeReminders.js): an in-app card plus a phone push, woken by a
 * Cloud Task booked for the due time (services/reminderWakeups), the hourly
 * athena-incidents run as a backstop. Like a time reminder it is something
 * they asked for, not Athena speaking first, so it is not initiative: it
 * ignores Initiative's switch and quiet hours, because a 2 am dose held
 * until 8 is worthless. Push's own consent (push_enabled) still applies.
 *
 * Each occurrence is its own push (dedupe key per schedule per due time,
 * collapse key per nudge), so two checks due together both arrive — nothing
 * is folded into "the most important one".
 *
 * Claimed before it is sent (push_state 'firing'), so two job runs never both
 * send it; a claim older than STALE_CLAIM_MS is a crashed run and is
 * released. A push that reached no device is retried RETRY_MS later until
 * MAX_ATTEMPTS — after that the in-app card is still there.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../helpers/db");
const wakeups = require("./reminderWakeups");

const TRIGGER_ID = "health_check_due";
const KINDS = new Set(["check", "medicine"]);
const MAX_EVERY_HOURS = 168;
const MAX_PER_WATCH = 12;
const MAX_ATTEMPTS = 5;
const RETRY_MS = 2 * 60_000;
const STALE_CLAIM_MS = 5 * 60_000;
/** The in-app card lasts until the next occurrence would come round, capped here. */
const MAX_NUDGE_TTL_MS = 24 * 3_600_000;
const HOUR = 3_600_000;
/** How far ahead "upcoming" looks. */
const UPCOMING_MS = 48 * HOUR;
const UPCOMING_MAX = 30;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function trim(value, max) {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function instant(value) {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function everyHours(value) {
	const hours = Number(value);
	if (!Number.isInteger(hours) || hours < 1 || hours > MAX_EVERY_HOURS) {
		throw bad(`A check repeats every 1 to ${MAX_EVERY_HOURS} hours.`);
	}
	return hours;
}

/** An instant from the request; refused (not guessed) if it isn't one. */
function when(value, what) {
	const date = instant(value);
	if (!date) throw bad(`${what} isn't a date and time I can read.`);
	return date;
}

/** A zone name Intl accepts, or null. */
function timeZone(value) {
	const zone = trim(value, 64);
	if (!zone) return null;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return zone;
	} catch {
		return null;
	}
}

/** YYYY-MM-DD of an instant in a zone (UTC when none is known). */
function localDate(date, zone) {
	try {
		return new Intl.DateTimeFormat("en-CA", { timeZone: zone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
	} catch {
		return date.toISOString().slice(0, 10);
	}
}

function dateOnly(value) {
	if (!value) return null;
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	return String(value).slice(0, 10);
}

/**
 * Whether an occurrence falls inside the check's own end and the watch's
 * planned end (its ends_on, a day in the watch's zone). A watch that has been
 * ended has no occurrences at all.
 */
function inWindow(due, schedule, watch) {
	if (watch.status !== "active") return false;
	const endsAt = instant(schedule.ends_at);
	if (endsAt && due.getTime() > endsAt.getTime()) return false;
	const endsOn = dateOnly(watch.ends_on);
	if (endsOn && localDate(due, watch.time_zone) > endsOn) return false;
	return true;
}

function publicSchedule(row, watch, now = Date.now()) {
	const due = instant(row.next_due_at);
	const live = due ? inWindow(due, row, watch) : false;
	return {
		uuid: row.uuid,
		label: row.label,
		kind: row.kind,
		everyHours: Number(row.every_hours),
		nextDueAt: live && due ? due.toISOString() : null,
		overdue: Boolean(live && due && due.getTime() <= now),
		endsAt: instant(row.ends_at)?.toISOString() || null,
		lastDoneAt: instant(row.last_done_at)?.toISOString() || null,
		finished: !live,
	};
}

/** The schedules on these watches (status rows), keyed by status id. */
async function forWatches(watchRows) {
	const out = new Map(watchRows.map((w) => [w.id, []]));
	if (!watchRows.length) return out;
	const [rows] = await pool.query(
		`SELECT * FROM family_health_schedule WHERE status_id IN (?) AND deleted_at IS NULL ORDER BY next_due_at ASC;`,
		[watchRows.map((w) => w.id)]
	);
	const byId = new Map(watchRows.map((w) => [w.id, w]));
	for (const row of rows) out.get(row.status_id)?.push(publicSchedule(row, byId.get(row.status_id)));
	return out;
}

/**
 * What's coming on one watch: each check's waiting occurrence (overdue ones
 * first), then the ones after it, as far as UPCOMING_MS ahead. Only the
 * first of each check can be ticked off; the rest are projections that move
 * when it is.
 */
function upcoming(schedules, watch, now = Date.now()) {
	const out = [];
	for (const s of schedules) {
		if (!s.nextDueAt) continue;
		let at = Date.parse(s.nextDueAt);
		const stepMs = s.everyHours * HOUR;
		for (let i = 0; out.length < UPCOMING_MAX * 2 && (i === 0 || at <= now + UPCOMING_MS); i++, at += stepMs) {
			const due = new Date(at);
			if (!inWindow(due, { ends_at: s.endsAt }, watch)) break;
			out.push({ scheduleUuid: s.uuid, label: s.label, kind: s.kind, dueAt: due.toISOString(), overdue: at <= now, actionable: i === 0 });
		}
	}
	return out.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)).slice(0, UPCOMING_MAX);
}

async function scheduleOn(watch, scheduleUuid) {
	const [rows] = await pool.query(
		`SELECT * FROM family_health_schedule WHERE uuid = ? AND status_id = ? AND deleted_at IS NULL LIMIT 1;`,
		[String(scheduleUuid || ""), watch.id]
	);
	if (!rows[0]) throw bad("That check isn't on this watch any more.", 404);
	return rows[0];
}

function requireActive(watch) {
	if (watch.status !== "active") throw bad("This watch has ended; start a new one to add checks.", 409);
}

/** Add a recurring check. `firstDueAt` defaults to one interval from now. */
async function create(profileId, watch, payload = {}, { now = new Date() } = {}) {
	requireActive(watch);
	const label = trim(payload.label, 120);
	if (!label) throw bad("Say what the check is — e.g. “Check temperature”.");
	const kind = KINDS.has(payload.kind) ? payload.kind : "check";
	const hours = everyHours(payload.everyHours);
	const first = payload.firstDueAt ? when(payload.firstDueAt, "The first check") : new Date(now.getTime() + hours * HOUR);
	const endsAt = payload.endsAt ? when(payload.endsAt, "The end") : null;
	if (endsAt && endsAt.getTime() < first.getTime()) throw bad("A check can't end before its first time.");
	const [[count]] = await pool.query(
		`SELECT COUNT(*) AS n FROM family_health_schedule WHERE status_id = ? AND deleted_at IS NULL;`,
		[watch.id]
	);
	if (Number(count?.n || 0) >= MAX_PER_WATCH) throw bad(`A watch can hold ${MAX_PER_WATCH} checks; remove one first.`, 409);
	const uuid = randomUUID();
	await pool.query(
		`INSERT INTO family_health_schedule
		   (uuid, status_id, family_id, label, kind, every_hours, next_due_at, ends_at, created_by_profile_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		[uuid, watch.id, watch.family_id, label, kind, hours, first, endsAt, profileId]
	);
	await wakeups.wakeAt(first);
	return uuid;
}

/** Change a check's name, cadence, next time or end. Omitted fields stay. */
async function update(watch, scheduleUuid, payload = {}) {
	requireActive(watch);
	const row = await scheduleOn(watch, scheduleUuid);
	const has = (k) => Object.prototype.hasOwnProperty.call(payload, k);
	const label = has("label") ? trim(payload.label, 120) : row.label;
	if (!label) throw bad("A check needs a name.");
	const kind = has("kind") ? (KINDS.has(payload.kind) ? payload.kind : row.kind) : row.kind;
	const hours = has("everyHours") ? everyHours(payload.everyHours) : Number(row.every_hours);
	const next = has("nextDueAt") ? when(payload.nextDueAt, "The next check") : instant(row.next_due_at);
	const endsAt = has("endsAt") ? (payload.endsAt ? when(payload.endsAt, "The end") : null) : instant(row.ends_at);
	if (endsAt && endsAt.getTime() < next.getTime()) throw bad("A check can't end before its next time.");
	await pool.query(
		`UPDATE family_health_schedule
		    SET label = ?, kind = ?, every_hours = ?, next_due_at = ?, ends_at = ?,
		        push_attempts = IF(? , 0, push_attempts), push_retry_at = IF(?, NULL, push_retry_at)
		  WHERE id = ?;`,
		[label, kind, hours, next, endsAt, has("nextDueAt"), has("nextDueAt"), row.id]
	);
	if (has("nextDueAt")) await wakeups.wakeAt(next);
}

async function remove(watch, scheduleUuid) {
	const row = await scheduleOn(watch, scheduleUuid);
	await pool.query(`UPDATE family_health_schedule SET deleted_at = NOW() WHERE id = ?;`, [row.id]);
}

/**
 * Tick off the waiting occurrence (`done`) or skip it. Done moves the next
 * one to `at` (default now) + the interval; skip moves it on from when it was
 * due. Either way it goes in the history.
 */
async function mark(profileId, watch, scheduleUuid, { skip = false, note, at } = {}, { now = new Date() } = {}) {
	requireActive(watch);
	const row = await scheduleOn(watch, scheduleUuid);
	const due = instant(row.next_due_at);
	const doneAt = at ? when(at, "When it was done") : now;
	if (doneAt.getTime() > now.getTime() + 5 * 60_000) throw bad("That time is in the future.");
	const stepMs = Number(row.every_hours) * HOUR;
	const next = new Date((skip ? due.getTime() : doneAt.getTime()) + stepMs);
	const [moved] = await pool.query(
		`UPDATE family_health_schedule
		    SET next_due_at = ?, last_done_at = IF(?, last_done_at, ?), push_attempts = 0, push_retry_at = NULL
		  WHERE id = ? AND next_due_at = ?;`,
		[next, skip, doneAt, row.id, row.next_due_at]
	);
	// Someone else ticked it off a moment ago; theirs stands.
	if (!moved.affectedRows) throw bad("That check was just updated — refresh to see it.", 409);
	await pool.query(
		`INSERT INTO family_health_entry
		   (uuid, status_id, family_id, kind, note, schedule_id, due_at, logged_at, logged_by_profile_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		[randomUUID(), watch.id, watch.family_id, skip ? "skip" : "check", trim(note, 500), row.id, due, skip ? now : doneAt, profileId]
	);
	await wakeups.wakeAt(next);
}

/** "Tylenol for Thomas is due (every 12 hours) — tick it off in the app." */
function pushText(row) {
	const every = Number(row.every_hours) === 1 ? "every hour" : `every ${row.every_hours} hours`;
	return `${row.person_name}: ${row.label} is due (${every}). Tick it off on their health watch when it's done.`.slice(0, 500);
}

/**
 * Push every occurrence that has come due unticked. Run by the reminders job
 * when a wake-up fires and by the hourly incidents backstop; safe to run
 * concurrently with itself. Returns { fired, retried }.
 */
async function fireDue({ now = new Date(), limit = 100 } = {}) {
	await pool.query(
		`UPDATE family_health_schedule SET push_state = NULL, pushed_for = NULL
		  WHERE push_state = 'firing' AND push_claimed_at < ?;`,
		[new Date(now.getTime() - STALE_CLAIM_MS)]
	);
	const [rows] = await pool.query(
		`SELECT sc.*, st.person_name, st.status, st.ends_on, st.time_zone, st.uuid AS watch_uuid
		   FROM family_health_schedule sc
		   JOIN family_health_status st ON st.id = sc.status_id AND st.deleted_at IS NULL
		  WHERE sc.deleted_at IS NULL AND st.status = 'active'
		    AND sc.next_due_at <= ?
		    AND (sc.pushed_for IS NULL OR sc.pushed_for <> sc.next_due_at)
		    AND (sc.push_retry_at IS NULL OR sc.push_retry_at <= ?)
		  ORDER BY sc.next_due_at LIMIT ?;`,
		[now, now, limit]
	);
	const push = require("./push");
	let fired = 0;
	let retried = 0;
	for (const row of rows) {
		const due = instant(row.next_due_at);
		if (!inWindow(due, row, row)) continue;
		const [claim] = await pool.query(
			`UPDATE family_health_schedule SET pushed_for = next_due_at, push_state = 'firing', push_claimed_at = ?
			  WHERE id = ? AND next_due_at = ? AND (pushed_for IS NULL OR pushed_for <> next_due_at);`,
			[now, row.id, row.next_due_at]
		);
		if (!claim.affectedRows) continue;

		const dedupeKey = `${row.uuid}@${due.toISOString()}`;
		const text = pushText(row);
		const nudgeUuid = randomUUID();
		const ttl = Math.min(Number(row.every_hours) * HOUR, MAX_NUDGE_TTL_MS);
		const [inserted] = await pool.query(
			`INSERT IGNORE INTO athena_nudge
			   (uuid, profile_id, trigger_id, dedupe_key, urgency, text, facts, expires_at)
			 VALUES (?, ?, ?, ?, 'normal', ?, ?, ?);`,
			[
				nudgeUuid,
				row.created_by_profile_id,
				TRIGGER_ID,
				dedupeKey,
				text,
				JSON.stringify({ watchUuid: row.watch_uuid, scheduleUuid: row.uuid, dueAt: due.toISOString() }),
				new Date(now.getTime() + ttl),
			]
		);
		let uuid = nudgeUuid;
		if (!inserted.affectedRows) {
			const [[existing]] = await pool.query(
				"SELECT uuid FROM athena_nudge WHERE profile_id = ? AND trigger_id = ? AND dedupe_key = ? LIMIT 1;",
				[row.created_by_profile_id, TRIGGER_ID, dedupeKey]
			);
			uuid = existing?.uuid || nudgeUuid;
		}
		const pushed = await push
			.deliverNudge(row.created_by_profile_id, { uuid, text, trigger_id: TRIGGER_ID, url: `/family/health/${encodeURIComponent(row.watch_uuid)}` })
			.catch((error) => ({ sent: 0, error: error.message }));
		const attempts = Number(row.push_attempts || 0) + 1;
		if (Number(pushed?.sent || 0) > 0 || attempts >= MAX_ATTEMPTS) {
			await pool.query(`UPDATE family_health_schedule SET push_state = 'sent', push_attempts = ? WHERE id = ?;`, [attempts, row.id]);
			fired += 1;
		} else {
			const retryAt = new Date(now.getTime() + RETRY_MS);
			await pool.query(
				`UPDATE family_health_schedule SET push_state = NULL, pushed_for = NULL, push_attempts = ?, push_retry_at = ? WHERE id = ?;`,
				[attempts, retryAt, row.id]
			);
			await wakeups.wakeAt(retryAt);
			retried += 1;
		}
	}
	return { fired, retried };
}

module.exports = {
	TRIGGER_ID,
	MAX_EVERY_HOURS,
	MAX_PER_WATCH,
	MAX_ATTEMPTS,
	forWatches,
	upcoming,
	create,
	update,
	remove,
	mark,
	fireDue,
	timeZone,
	localDate,
	inWindow,
	publicSchedule,
};
