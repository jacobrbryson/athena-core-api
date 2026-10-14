const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../helpers/db");
const workoutHistory = require("./workoutHistory");

/**
 * Training programs and nutrition — the Health page's plan (migration 0073).
 *
 * WHOOP knows a workout happened; it doesn't know what the person meant to do,
 * and nothing they connect can see a plate. This is the intent (a weekly
 * pattern of sessions over N weeks) and the log (what they ate, and against
 * what targets). Every query is keyed by the caller's own profile id, and the
 * routes are adult-only.
 *
 * A session is "done" when the person ticks it, or when a recorded workout of
 * the matching kind started that local day. The second is computed on read so
 * a deleted or re-synced workout never leaves a stale tick behind.
 */

const KINDS = ["gym", "run", "ride", "sport", "recovery", "rest", "other"];
/** Which recorded WHOOP sport names count as which planned kind. */
const KIND_SPORTS = {
	gym: /lifting|powerlifting|functional|crossfit|hiit|strength|box/i,
	run: /running|track|jog/i,
	ride: /cycling|biking|spin|bike/i,
	sport: /soccer|football|basketball|tennis|pickleball|hockey|lacrosse|volleyball|baseball|rugby|golf/i,
	recovery: /yoga|stretch|mobility|walking|pilates|meditation|recovery|sauna|massage/i,
};
const LOG_STATUSES = new Set(["done", "skipped"]);
const DAY_MS = 86400_000;

/** Field -> [min, max] for a daily target. */
const TARGETS = {
	calories: [800, 8000],
	protein_g: [10, 600],
	carbs_g: [0, 1200],
	fat_g: [0, 400],
	water_oz: [8, 400],
	sleep_hours: [4, 12],
	target_weight_low_kg: [25, 300],
	target_weight_high_kg: [25, 300],
};
/** Field -> [min, max] for one logged entry. */
const ENTRY = {
	calories: [0, 6000],
	protein_g: [0, 500],
	carbs_g: [0, 1000],
	fat_g: [0, 400],
	water_oz: [0, 200],
};

function badRequest(message) {
	return Object.assign(new Error(message), { status: 400 });
}
const num = (v) => (v === null || v === undefined ? null : Number(v));
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const text = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
/** 0 = Monday … 6 = Sunday, for a YYYY-MM-DD date. */
const weekdayOf = (date) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
const mondayOf = (date) => addDays(date, -weekdayOf(date));

/** The person's "today" as the client saw it; the server's UTC date when absent or nonsense. */
function dayOr(date) {
	return isDate(date) ? date : new Date().toISOString().slice(0, 10);
}

function bounded(source, spec, { label = "" } = {}) {
	const out = {};
	for (const [field, [min, max]] of Object.entries(spec)) {
		const raw = source[field];
		if (raw === null || raw === undefined || raw === "") {
			out[field] = null;
			continue;
		}
		const value = Number(raw);
		if (!Number.isFinite(value) || value < min || value > max) throw badRequest(`${label}${field.replace(/_/g, " ")} must be between ${min} and ${max}.`);
		out[field] = value;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Training program
// ---------------------------------------------------------------------------

function exercisesOf(raw) {
	const list = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : raw;
	return Array.isArray(list) ? list.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 60)).slice(0, 20) : [];
}

function sessionOf(row) {
	return { uuid: row.uuid, weekday: Number(row.weekday), kind: row.kind, title: row.title, focus: row.focus || null, detail: row.detail || null, exercises: exercisesOf(row.exercises) };
}

async function activeProgramRow(profileId) {
	const [rows] = await pool.query(
		`SELECT id, uuid, name, goal, starts_on, weeks FROM training_program
		 WHERE profile_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`,
		[profileId],
	);
	return rows[0] || null;
}

/**
 * The active program with this week's sessions, each marked done / skipped /
 * planned for its date. `today` is the client's local date.
 */
async function program(profileId, { today } = {}) {
	const day = dayOr(today);
	const row = await activeProgramRow(profileId);
	if (!row) return null;
	const startsOn = ymd(row.starts_on);
	const weeks = Number(row.weeks);
	const weekNumber = Math.floor((Date.parse(`${mondayOf(day)}T12:00:00Z`) - Date.parse(`${mondayOf(startsOn)}T12:00:00Z`)) / (7 * DAY_MS)) + 1;
	const monday = mondayOf(day);
	const sunday = addDays(monday, 6);
	const [[sessions], [logs], workouts] = await Promise.all([
		pool.query(`SELECT id, uuid, weekday, kind, title, focus, detail, exercises FROM training_session WHERE program_id = ? ORDER BY weekday, sort, id`, [row.id]),
		pool.query(
			`SELECT l.session_id, l.done_on, l.status FROM training_log l JOIN training_session s ON s.id = l.session_id
			 WHERE s.program_id = ? AND l.profile_id = ? AND l.done_on BETWEEN ? AND ?`,
			[row.id, profileId, monday, sunday],
		),
		// The workouts that might tick a session this week; a failed read only
		// means nothing is auto-ticked, never that the plan won't load.
		workoutHistory.list(profileId, { days: 14, limit: 200 }).catch(() => []),
	]);
	const marks = new Map(logs.map((l) => [`${l.session_id}:${ymd(l.done_on)}`, l.status]));
	const week = sessions.map((s) => {
		const date = addDays(monday, Number(s.weekday));
		const mark = marks.get(`${s.id}:${date}`) || null;
		const matching = KIND_SPORTS[s.kind];
		const recorded = matching ? workouts.find((w) => w.date === date && w.sport && matching.test(w.sport)) : null;
		const status = mark || (recorded ? "done" : date < day ? "missed" : date === day ? "today" : "planned");
		return { ...sessionOf(s), date, status, marked: !!mark, recorded: recorded ? { sport: recorded.sport, minutes: recorded.minutes, strain: recorded.strain } : null };
	});
	return {
		uuid: row.uuid, name: row.name, goal: row.goal || null, starts_on: startsOn, weeks,
		week_number: weekNumber, ended: weekNumber > weeks, before_start: day < startsOn,
		week_of: monday, sessions: week,
	};
}

function validSessions(list) {
	if (!Array.isArray(list) || !list.length) throw badRequest("A program needs at least one session.");
	if (list.length > 21) throw badRequest("At most 21 sessions a week.");
	return list.map((s, i) => {
		const weekday = Number(s?.weekday);
		if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw badRequest(`Session ${i + 1} needs a weekday (0 = Monday … 6 = Sunday).`);
		const kind = KINDS.includes(s.kind) ? s.kind : null;
		if (!kind) throw badRequest(`Session ${i + 1} kind must be one of ${KINDS.join(", ")}.`);
		const title = text(s.title, 60);
		if (!title) throw badRequest(`Session ${i + 1} needs a title.`);
		return { weekday, kind, title, focus: text(s.focus, 60), detail: text(s.detail, 255), exercises: exercisesOf(s.exercises), sort: i };
	});
}

/**
 * Start a program, replacing whichever one is active (it is ended, not
 * deleted, so its logs keep meaning something).
 */
async function saveProgram(profileId, body = {}) {
	const name = text(body.name, 80);
	if (!name) throw badRequest("The program needs a name.");
	const startsOn = body.starts_on ? String(body.starts_on).slice(0, 10) : new Date().toISOString().slice(0, 10);
	if (!isDate(startsOn)) throw badRequest("Start date must be YYYY-MM-DD.");
	const weeks = Number(body.weeks);
	if (!Number.isInteger(weeks) || weeks < 1 || weeks > 104) throw badRequest("Weeks must be a whole number from 1 to 104.");
	const sessions = validSessions(body.sessions);
	const uuid = uuidv4();
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [previous] = await conn.query(`SELECT id FROM training_program WHERE profile_id = ? AND ended_at IS NULL`, [profileId]);
		await conn.query(`UPDATE training_program SET ended_at = CURRENT_TIMESTAMP(3) WHERE profile_id = ? AND ended_at IS NULL`, [profileId]);
		const [result] = await conn.query(
			`INSERT INTO training_program (uuid, profile_id, name, goal, starts_on, weeks) VALUES (?, ?, ?, ?, ?, ?)`,
			[uuid, profileId, name, text(body.goal, 255), startsOn, weeks],
		);
		await conn.query(
			`INSERT INTO training_session (uuid, program_id, weekday, kind, title, focus, detail, exercises, sort) VALUES ?`,
			[sessions.map((s) => [uuidv4(), result.insertId, s.weekday, s.kind, s.title, s.focus, s.detail, JSON.stringify(s.exercises), s.sort])],
		);
		// Editing the program shouldn't wipe what was already ticked: marks carry
		// over to the session on the same weekday with the same title.
		if (previous.length) {
			await conn.query(
				`INSERT IGNORE INTO training_log (profile_id, session_id, done_on, status)
				 SELECT l.profile_id, ns.id, l.done_on, l.status FROM training_log l
				 JOIN training_session os ON os.id = l.session_id
				 JOIN training_session ns ON ns.program_id = ? AND ns.weekday = os.weekday AND ns.title = os.title
				 WHERE os.program_id IN (?) AND l.profile_id = ?`,
				[result.insertId, previous.map((r) => r.id), profileId],
			);
		}
		await conn.commit();
	} catch (err) {
		await conn.rollback();
		throw err;
	} finally {
		conn.release();
	}
	return uuid;
}

/** End the active program. Returns whether there was one. */
async function endProgram(profileId) {
	const [result] = await pool.query(`UPDATE training_program SET ended_at = CURRENT_TIMESTAMP(3) WHERE profile_id = ? AND ended_at IS NULL`, [profileId]);
	return result.affectedRows > 0;
}

/**
 * Mark a session of the person's active program done or skipped on a date, or
 * clear the mark (status null). The session must belong to them.
 */
async function markSession(profileId, sessionUuid, { date, status } = {}) {
	if (!isDate(date)) throw badRequest("A date (YYYY-MM-DD) is required.");
	if (status !== null && !LOG_STATUSES.has(status)) throw badRequest("Status must be done, skipped or null.");
	const [rows] = await pool.query(
		`SELECT s.id FROM training_session s JOIN training_program p ON p.id = s.program_id
		 WHERE s.uuid = ? AND p.profile_id = ? AND p.ended_at IS NULL`,
		[String(sessionUuid || ""), profileId],
	);
	if (!rows.length) return false;
	if (status === null) {
		await pool.query(`DELETE FROM training_log WHERE session_id = ? AND done_on = ? AND profile_id = ?`, [rows[0].id, date, profileId]);
	} else {
		await pool.query(
			`INSERT INTO training_log (profile_id, session_id, done_on, status) VALUES (?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE status = VALUES(status)`,
			[profileId, rows[0].id, date, status],
		);
	}
	return true;
}

// ---------------------------------------------------------------------------
// Nutrition
// ---------------------------------------------------------------------------

async function targets(profileId) {
	const [rows] = await pool.query(`SELECT ${Object.keys(TARGETS).join(", ")} FROM nutrition_target WHERE profile_id = ?`, [profileId]);
	if (!rows.length) return null;
	return Object.fromEntries(Object.keys(TARGETS).map((k) => [k, num(rows[0][k])]));
}

/** Replace the person's targets. Blank fields clear that target. */
async function saveTargets(profileId, body = {}) {
	const values = bounded(body, TARGETS);
	if (values.target_weight_low_kg !== null && values.target_weight_high_kg !== null && values.target_weight_low_kg > values.target_weight_high_kg) {
		throw badRequest("The low end of the target weight is above the high end.");
	}
	const fields = Object.keys(TARGETS);
	await pool.query(
		`INSERT INTO nutrition_target (profile_id, ${fields.join(", ")}) VALUES (?, ${fields.map(() => "?").join(", ")})
		 ON DUPLICATE KEY UPDATE ${fields.map((f) => `${f} = VALUES(${f})`).join(", ")}`,
		[profileId, ...fields.map((f) => values[f])],
	);
	return targets(profileId);
}

function entryOf(row) {
	return {
		uuid: row.uuid, eaten_on: ymd(row.eaten_on), label: row.label,
		calories: num(row.calories), protein_g: num(row.protein_g), carbs_g: num(row.carbs_g), fat_g: num(row.fat_g), water_oz: num(row.water_oz),
		created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
	};
}

const TOTAL_FIELDS = ["calories", "protein_g", "carbs_g", "fat_g", "water_oz"];
function totalsOf(entries) {
	const sum = Object.fromEntries(TOTAL_FIELDS.map((f) => [f, 0]));
	for (const e of entries) for (const f of TOTAL_FIELDS) sum[f] += e[f] || 0;
	for (const f of TOTAL_FIELDS) sum[f] = Math.round(sum[f] * 10) / 10;
	return sum;
}

/** Today's entries and totals, and the six days before as totals only (oldest first). */
async function nutrition(profileId, { today } = {}) {
	const day = dayOr(today);
	const from = addDays(day, -6);
	const [rows] = await pool.query(
		`SELECT uuid, eaten_on, label, calories, protein_g, carbs_g, fat_g, water_oz, created_at FROM nutrition_entry
		 WHERE profile_id = ? AND deleted_at IS NULL AND eaten_on BETWEEN ? AND ? ORDER BY eaten_on, id`,
		[profileId, from, day],
	);
	const entries = rows.map(entryOf);
	const todays = entries.filter((e) => e.eaten_on === day);
	const days = Array.from({ length: 7 }, (_, i) => {
		const date = addDays(from, i);
		const those = entries.filter((e) => e.eaten_on === date);
		return { date, logged: those.length > 0, totals: totalsOf(those) };
	});
	return { date: day, entries: todays, totals: totalsOf(todays), days };
}

async function addEntry(profileId, body = {}) {
	const eatenOn = dayOr(body.eaten_on);
	if (Date.parse(eatenOn) > Date.now() + 2 * DAY_MS) throw badRequest("That date is in the future.");
	const values = bounded(body, ENTRY);
	if (TOTAL_FIELDS.every((f) => values[f] === null)) throw badRequest("Enter calories, a macro, or water.");
	const label = text(body.label, 120) || (values.water_oz !== null && TOTAL_FIELDS.every((f) => f === "water_oz" || values[f] === null) ? "Water" : null);
	if (!label) throw badRequest("Say what it was.");
	const uuid = uuidv4();
	await pool.query(
		`INSERT INTO nutrition_entry (uuid, profile_id, eaten_on, label, calories, protein_g, carbs_g, fat_g, water_oz) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[uuid, profileId, eatenOn, label, values.calories, values.protein_g, values.carbs_g, values.fat_g, values.water_oz],
	);
	return { uuid, eaten_on: eatenOn, label, ...values };
}

async function removeEntry(profileId, uuid) {
	const [result] = await pool.query(
		`UPDATE nutrition_entry SET deleted_at = CURRENT_TIMESTAMP(3) WHERE uuid = ? AND profile_id = ? AND deleted_at IS NULL`,
		[String(uuid || ""), profileId],
	);
	return result.affectedRows > 0;
}

/** Everything the Health page's plan needs, in one read. A missing table reads as nothing set up. */
async function overview(profileId, { today } = {}) {
	const quiet = (p, empty) => p.catch((err) => {
		if (err.code === "ER_NO_SUCH_TABLE") return empty;
		throw err;
	});
	const [prog, tgt, food] = await Promise.all([
		quiet(program(profileId, { today }), null),
		quiet(targets(profileId), null),
		quiet(nutrition(profileId, { today }), null),
	]);
	return { program: prog, targets: tgt, nutrition: food };
}

// ---------------------------------------------------------------------------
// Chat grounding
// ---------------------------------------------------------------------------

const KEYWORDS = /\b(workout|work out|training|program|gym|lift|lifting|leg day|upper|lower body|run today|tomorrow'?s (session|workout)|what am i doing|protein|calories|macros?|carbs|fat grams|nutrition|eat(en|ing)?|ate|food|meal|hydrat|water|diet|hypertrophy|target weight)\b/i;
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function matches(message) {
	return typeof message === "string" && KEYWORDS.test(message);
}

/**
 * Plain facts for the prompt: this week's planned sessions and what's marked,
 * today's food against targets. Adults only; null when nothing is set up.
 */
async function buildContext(profileId, { message, audience, force = false, today } = {}) {
	if (!profileId || audience !== "adult" || !(force || matches(message))) return null;
	const { program: prog, targets: tgt, nutrition: food } = await overview(profileId, { today });
	const lines = [];
	if (prog) {
		lines.push(`Training program "${prog.name}"${prog.goal ? ` (goal: ${prog.goal})` : ""} — week ${prog.week_number} of ${prog.weeks}, started ${prog.starts_on}. This week (person's own plan; "done" means they ticked it or a matching WHOOP workout was recorded):`);
		for (const s of prog.sessions) {
			const what = [s.title, s.focus, s.detail].filter(Boolean).join(" · ");
			const ex = s.exercises.length ? ` — ${s.exercises.join(", ")}` : "";
			lines.push(`- ${WEEKDAYS[s.weekday]} ${s.date}: ${what} [${s.kind}] — ${s.status}${s.recorded ? ` (WHOOP: ${s.recorded.sport}, ${s.recorded.minutes} min)` : ""}${ex}`);
		}
	}
	if (tgt || food?.entries.length) {
		const t = food?.totals || {};
		const of = (v, target, unit) => `${Math.round(v || 0)}${target ? ` / ${target}` : ""} ${unit}`;
		lines.push(`Food logged today (${food?.date}, by the person — Athena can't see meals they didn't log): ${of(t.calories, tgt?.calories, "kcal")}, protein ${of(t.protein_g, tgt?.protein_g, "g")}, carbs ${of(t.carbs_g, tgt?.carbs_g, "g")}, fat ${of(t.fat_g, tgt?.fat_g, "g")}, water ${of(t.water_oz, tgt?.water_oz, "oz")}.`);
		for (const e of (food?.entries || []).slice(-12)) lines.push(`- ${e.label}${e.calories != null ? `, ${e.calories} kcal` : ""}${e.protein_g != null ? `, ${e.protein_g} g protein` : ""}${e.water_oz != null ? `, ${e.water_oz} oz water` : ""}`);
		if (tgt?.sleep_hours) lines.push(`Sleep target: ${tgt.sleep_hours} h.`);
		if (tgt?.target_weight_low_kg) lines.push(`Target weight: ${Math.round(tgt.target_weight_low_kg * 2.20462)}${tgt.target_weight_high_kg ? `–${Math.round(tgt.target_weight_high_kg * 2.20462)}` : ""} lb.`);
	}
	if (!lines.length) return null;
	lines.push("They set the program, targets and food log up on the Health page; Athena can read them but cannot change them from chat.");
	return lines.join("\n");
}

module.exports = {
	KINDS, KIND_SPORTS, program, saveProgram, endProgram, markSession,
	targets, saveTargets, nutrition, addEntry, removeEntry, overview,
	matches, buildContext,
	_test: { weekdayOf, mondayOf, addDays, totalsOf },
};
