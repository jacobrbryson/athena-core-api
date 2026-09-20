/**
 * The around-the-house list.
 *
 * This is deliberately small and deliberately ours. It exists because a
 * project is only useful to the dashboard if three things about it are
 * knowable without reading prose: how long it takes, whether it needs dry
 * weather, and whether it is still open. A spreadsheet can hold those; it
 * cannot be asked "what fits in the next four hours" and it cannot record that
 * the answer moved.
 *
 * Nothing here decides anything. It stores what a person typed or imported and
 * answers questions about it. The choosing happens in ./rightNow.js, and
 * marking one done happens through the action layer, never here.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../helpers/db");

const STATUSES = ["todo", "in_progress", "blocked", "done"];
const PRIORITIES = ["low", "normal", "high"];
const MAX_PROJECTS = 500;

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const trim = (value, max) =>
	typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

function toProject(row) {
	return {
		uuid: row.uuid,
		title: row.title,
		detail: row.detail || null,
		area: row.area || null,
		status: row.status,
		priority: row.priority,
		effortMinutes: row.effort_minutes === null ? null : Number(row.effort_minutes),
		indoor: row.indoor === null ? null : !!row.indoor,
		costEstimate: row.cost_estimate === null ? null : Number(row.cost_estimate),
		dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null,
		blockedOn: row.blocked_on || null,
		lastProgressAt: row.last_progress_at || null,
		completedAt: row.completed_at || null,
		source: row.source,
		updatedAt: row.updated_at,
	};
}

const COLUMNS = `uuid, title, detail, area, status, priority, effort_minutes, indoor,
	cost_estimate, due_date, blocked_on, last_progress_at, completed_at, source, updated_at`;

/**
 * Everything on the list, open work first.
 *
 * Finished projects are kept — "we already did the gutters" is worth having —
 * but they sort last and most callers ask without them.
 */
async function list(profileId, { includeDone = false } = {}) {
	const [rows] = await pool.query(
		`SELECT ${COLUMNS} FROM athena_home_project
		 WHERE profile_id = ? ${includeDone ? "" : "AND status <> 'done'"}
		 ORDER BY FIELD(status,'in_progress','todo','blocked','done'),
		          FIELD(priority,'high','normal','low'),
		          due_date IS NULL, due_date, updated_at DESC
		 LIMIT ${MAX_PROJECTS}`,
		[profileId]
	);
	return rows.map(toProject);
}

/** The counts the cards want, without counting a list twice. */
async function counts(profileId) {
	const [rows] = await pool.query(
		"SELECT status, COUNT(*) AS n FROM athena_home_project WHERE profile_id = ? GROUP BY status",
		[profileId]
	);
	const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
	return {
		todo: by.todo || 0,
		inProgress: by.in_progress || 0,
		blocked: by.blocked || 0,
		done: by.done || 0,
		open: (by.todo || 0) + (by.in_progress || 0),
	};
}

/**
 * Normalise one submitted project, or throw a 400 whose message is safe to
 * show. Unknown-by-omission is preserved everywhere: an absent `indoor` stays
 * null rather than becoming false, because "nobody said" and "it is outdoor
 * work" are different answers to the question the weather asks.
 */
function normalize(input = {}, existing = null) {
	const title = trim(input.title, 190) ?? existing?.title ?? null;
	if (!title) throw bad("A project needs a title.");
	const pick = (value, allowed, fallback) => {
		if (value === undefined) return fallback;
		const v = String(value || "").toLowerCase();
		if (!allowed.includes(v)) throw bad(`Use one of: ${allowed.join(", ")}.`);
		return v;
	};
	const minutes = (value, fallback) => {
		if (value === undefined) return fallback;
		if (value === null || value === "") return null;
		const n = Math.round(Number(value));
		if (!Number.isFinite(n) || n < 5 || n > 60 * 24 * 14) throw bad("Effort must be between 5 minutes and two weeks.");
		return n;
	};
	const money = (value, fallback) => {
		if (value === undefined) return fallback;
		if (value === null || value === "") return null;
		const n = Number(String(value).replace(/[$,\s]/g, ""));
		if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw bad("That cost does not look right.");
		return Math.round(n * 100) / 100;
	};
	const date = (value, fallback) => {
		if (value === undefined) return fallback;
		if (!value) return null;
		const parsed = new Date(value);
		if (Number.isNaN(parsed.getTime())) throw bad("That due date is not a date I can read.");
		return parsed.toISOString().slice(0, 10);
	};
	const tri = (value, fallback) => {
		if (value === undefined) return fallback;
		if (value === null || value === "") return null;
		return !!value;
	};
	const status = pick(input.status, STATUSES, existing?.status ?? "todo");
	return {
		title,
		detail: input.detail === undefined ? existing?.detail ?? null : trim(input.detail, 4000),
		area: input.area === undefined ? existing?.area ?? null : trim(input.area, 80),
		status,
		priority: pick(input.priority, PRIORITIES, existing?.priority ?? "normal"),
		effort_minutes: minutes(input.effortMinutes, existing?.effortMinutes ?? null),
		indoor: tri(input.indoor, existing?.indoor ?? null),
		cost_estimate: money(input.costEstimate, existing?.costEstimate ?? null),
		due_date: date(input.dueDate, existing?.dueDate ?? null),
		blocked_on: input.blockedOn === undefined ? existing?.blockedOn ?? null : trim(input.blockedOn, 190),
		// Completion is derived from status so the two can never disagree.
		completed_at: status === "done" ? existing?.completedAt || new Date() : null,
	};
}

const flag = (value) => (value === null ? null : value ? 1 : 0);

async function byUuid(profileId, uuid) {
	const [rows] = await pool.query(
		`SELECT ${COLUMNS} FROM athena_home_project WHERE profile_id = ? AND uuid = ? LIMIT 1`,
		[profileId, uuid]
	);
	return rows.length ? toProject(rows[0]) : null;
}

async function create(profileId, input, { source = "manual" } = {}) {
	const [[{ n }]] = await pool.query(
		"SELECT COUNT(*) AS n FROM athena_home_project WHERE profile_id = ?",
		[profileId]
	);
	if (n >= MAX_PROJECTS) throw bad(`That is already ${MAX_PROJECTS} projects — finish or remove some first.`);
	const f = normalize(input);
	const uuid = randomUUID();
	await pool.query(
		`INSERT INTO athena_home_project (uuid, profile_id, title, detail, area, status, priority,
		 effort_minutes, indoor, cost_estimate, due_date, blocked_on, completed_at, source)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		[uuid, profileId, f.title, f.detail, f.area, f.status, f.priority, f.effort_minutes,
			flag(f.indoor), f.cost_estimate, f.due_date, f.blocked_on, f.completed_at,
			source === "import" ? "import" : "manual"]
	);
	return byUuid(profileId, uuid);
}

/**
 * Change a project. Any status change is progress: one that moved to
 * in_progress today should not read as stale tomorrow, which is what
 * `last_progress_at` is for.
 */
async function update(profileId, uuid, patch) {
	const existing = await byUuid(profileId, uuid);
	if (!existing) return null;
	const f = normalize(patch, existing);
	const moved = f.status !== existing.status;
	await pool.query(
		`UPDATE athena_home_project SET title=?, detail=?, area=?, status=?, priority=?,
		 effort_minutes=?, indoor=?, cost_estimate=?, due_date=?, blocked_on=?, completed_at=?
		 ${moved ? ", last_progress_at = NOW()" : ""}
		 WHERE profile_id = ? AND uuid = ?`,
		[f.title, f.detail, f.area, f.status, f.priority, f.effort_minutes, flag(f.indoor),
			f.cost_estimate, f.due_date, f.blocked_on, f.completed_at, profileId, uuid]
	);
	return byUuid(profileId, uuid);
}

async function remove(profileId, uuid) {
	const [result] = await pool.query(
		"DELETE FROM athena_home_project WHERE profile_id = ? AND uuid = ?",
		[profileId, uuid]
	);
	return result.affectedRows > 0;
}

module.exports = { list, counts, create, byUuid, update, remove, normalize, STATUSES, PRIORITIES, MAX_PROJECTS };
