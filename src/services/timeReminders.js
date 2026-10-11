/**
 * Time reminders — "remind me at 7 to tell Ashlyn to text her brother."
 *
 * Until 2026-10-10 the only reminder Athena had waited for a place, so "remind
 * me tomorrow at 7" was offered as a calendar event or not at all. This is the
 * plain version: a time and a sentence, delivered the way place reminders are
 * (an in-app card and a push), by the athena-reminders job, woken for it.
 *
 * Setting one is an action (`remind_at_time` in actions/registry.js), so the
 * person approves the exact time and words on a card, or has granted a
 * standing approval. Setting one books a single wake-up of the reminders job
 * for its time (services/reminderWakeups) — nothing polls. Like place reminders, a reminder they asked for is not
 * Athena speaking first, so it ignores Initiative's switch and quiet hours —
 * a 7am reminder held until 8 is worthless (owner, 2026-10-04).
 *
 * ## Nothing is lost
 *
 * A row is claimed ('firing') before it is sent, so two job runs never both
 * send it. The in-app card is written once (dedupe key), and the push is
 * retried (a wake-up RETRY_MS later) until it is accepted or MAX_ATTEMPTS is
 * reached — after that the card is still there. A wake-up that never comes
 * is caught by the hourly backstop in src/jobs/incidents.js.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../helpers/db");
const wakeups = require("./reminderWakeups");

const TRIGGER_ID = "time_reminder";
const MAX_ARMED = 50;
const MAX_ATTEMPTS = 5;
/** The in-app card stays this long if the push didn't reach them. */
const NUDGE_TTL_S = 6 * 60 * 60;
/** How long before a push that didn't get through is tried again. */
const RETRY_MS = 2 * 60_000;
/** A claim older than this is a crashed run; the row goes back to armed. */
const STALE_CLAIM_MS = 5 * 60_000;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function toReminder(row) {
	return {
		uuid: row.uuid,
		reminder: row.text,
		fireAt: row.fire_at,
		timeZone: row.time_zone || null,
		status: row.status === "firing" ? "armed" : row.status,
		firedAt: row.fired_at || null,
		createdAt: row.created_at,
	};
}

/** Called only from the remind_at_time action's execute(), with params normalize() vouched for. */
async function create(profileId, params, { actionUuid = null } = {}) {
	const [[count]] = await pool.query(
		"SELECT COUNT(*) AS n FROM athena_time_reminder WHERE profile_id = ? AND status IN ('armed', 'firing')",
		[profileId]
	);
	if (Number(count?.n || 0) >= MAX_ARMED) {
		throw bad(`You already have ${MAX_ARMED} reminders waiting; remove one on the Community page first.`, 409);
	}
	const uuid = randomUUID();
	await pool.query(
		`INSERT INTO athena_time_reminder (uuid, profile_id, text, fire_at, time_zone, action_uuid)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[uuid, profileId, params.reminder, new Date(params.at), params.time_zone || null, actionUuid]
	);
	await wakeups.wakeAt(params.at);
	return { uuid };
}

/** Waiting ones, then the last fortnight's finished ones, for the Community page. */
async function list(profileId, { now = new Date() } = {}) {
	const [rows] = await pool.query(
		`SELECT * FROM athena_time_reminder
		 WHERE profile_id = ? AND (status IN ('armed', 'firing') OR (status = 'done' AND fired_at >= ?))
		 ORDER BY status = 'done' ASC, fire_at ASC LIMIT 100`,
		[profileId, new Date(now.getTime() - 14 * 86400_000)]
	);
	return rows.map(toReminder);
}

async function cancel(profileId, uuid) {
	const [result] = await pool.query(
		"UPDATE athena_time_reminder SET status = 'cancelled' WHERE profile_id = ? AND uuid = ? AND status = 'armed'",
		[profileId, String(uuid || "")]
	);
	if (!result.affectedRows) throw bad("That reminder isn't waiting any more.", 404);
	return list(profileId);
}

/** "Sat 7:00 PM" in their zone. */
function spoken(date, timeZone) {
	try {
		return new Intl.DateTimeFormat("en-US", {
			weekday: "short",
			hour: "numeric",
			minute: "2-digit",
			...(timeZone ? { timeZone } : {}),
		}).format(new Date(date));
	} catch {
		return new Date(date).toISOString();
	}
}

/**
 * Send everything due. Run once a minute by src/jobs/reminders.js; safe to run
 * concurrently with itself. Returns { fired, retried }.
 */
async function fireDue({ now = new Date(), limit = 100 } = {}) {
	// A run that died mid-send leaves rows 'firing'; give them back.
	await pool.query(
		"UPDATE athena_time_reminder SET status = 'armed' WHERE status = 'firing' AND fired_at < ?",
		[new Date(now.getTime() - STALE_CLAIM_MS)]
	);
	const [rows] = await pool.query(
		"SELECT * FROM athena_time_reminder WHERE status = 'armed' AND fire_at <= ? ORDER BY fire_at LIMIT ?",
		[now, limit]
	);
	const push = require("./push");
	let fired = 0;
	let retried = 0;
	for (const row of rows) {
		const [claim] = await pool.query(
			"UPDATE athena_time_reminder SET status = 'firing', fired_at = ? WHERE id = ? AND status = 'armed'",
			[now, row.id]
		);
		if (!claim.affectedRows) continue;

		const text = `You asked me to remind you: ${row.text}`.slice(0, 500);
		const nudgeUuid = randomUUID();
		// Written once however many runs it takes to reach them.
		const [inserted] = await pool.query(
			`INSERT IGNORE INTO athena_nudge
				(uuid, profile_id, trigger_id, dedupe_key, urgency, text, facts, expires_at)
			 VALUES (?, ?, ?, ?, 'normal', ?, ?, ?)`,
			[
				nudgeUuid,
				row.profile_id,
				TRIGGER_ID,
				`${row.uuid}:time`,
				text,
				JSON.stringify({ reminderUuid: row.uuid, setFor: spoken(row.fire_at, row.time_zone) }),
				new Date(now.getTime() + NUDGE_TTL_S * 1000),
			]
		);
		let uuid = nudgeUuid;
		if (!inserted.affectedRows) {
			const [[existing]] = await pool.query(
				"SELECT uuid FROM athena_nudge WHERE profile_id = ? AND trigger_id = ? AND dedupe_key = ? LIMIT 1",
				[row.profile_id, TRIGGER_ID, `${row.uuid}:time`]
			);
			uuid = existing?.uuid || nudgeUuid;
		}
		const pushed = await push
			.deliverNudge(row.profile_id, { uuid, text, trigger_id: TRIGGER_ID })
			.catch((error) => ({ sent: 0, error: error.message }));
		const reached = Number(pushed?.sent || 0) > 0;
		const attempts = Number(row.attempts || 0) + 1;
		if (reached || attempts >= MAX_ATTEMPTS) {
			await pool.query("UPDATE athena_time_reminder SET status = 'done', attempts = ? WHERE id = ?", [attempts, row.id]);
			fired += 1;
		} else {
			await pool.query(
				"UPDATE athena_time_reminder SET status = 'armed', attempts = ?, fire_at = ? WHERE id = ?",
				[attempts, new Date(now.getTime() + RETRY_MS), row.id]
			);
			await wakeups.wakeAt(new Date(now.getTime() + RETRY_MS));
			retried += 1;
		}
	}
	return { fired, retried };
}

/** What she has set, for her own prompt. */
async function promptBlock(profileId) {
	if (!profileId) return null;
	const [rows] = await pool.query(
		`SELECT text, fire_at, time_zone FROM athena_time_reminder
		 WHERE profile_id = ? AND status IN ('armed', 'firing') ORDER BY fire_at LIMIT 20`,
		[profileId]
	);
	if (!rows.length) return null;
	return [
		"# Time reminders they've set",
		"",
		...rows.map((r) => `- ${spoken(r.fire_at, r.time_zone)}: "${r.text}"`),
		"",
		"They can remove one on the Community page; you cannot remove one for them.",
	].join("\n");
}

module.exports = { TRIGGER_ID, MAX_ARMED, MAX_ATTEMPTS, create, list, cancel, fireDue, promptBlock, spoken };
