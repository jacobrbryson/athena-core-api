/**
 * Projects: goals, steps, the links between them, the concerns they answer and
 * the charter a person decides by. See docs/architecture/projects.md.
 *
 * Everything here is a person's own data, written at their request from their
 * own app (or by the owner's import script). Nothing here performs an action in
 * the world and nothing here is Athena deciding — the ranking that reads this
 * lives in ./rank.js and is arithmetic.
 *
 * Every query is scoped by profile_id. Child rows (steps, links, areas) are
 * reached only through a project the caller owns, never by their own uuid alone.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../../helpers/db");
const shape = require("./shape");
const entries = require("./entries");
const bindings = require("./bindings");

const { bad } = shape;
const MAX_PROJECTS = 1000;
const MAX_STEPS = 200;
const MAX_CONCERNS = 200;

const flag = (v) => (v === null || v === undefined ? null : v ? 1 : 0);
const jsonCol = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
const notFound = (what) => Object.assign(new Error(`That ${what} is not on your list.`), { status: 404 });

async function withTx(fn) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const out = await fn(conn);
		await conn.commit();
		return out;
	} catch (err) {
		await conn.rollback().catch(() => {});
		throw err;
	} finally {
		conn.release();
	}
}

const PROJECT_COLUMNS = [
	"title", "goal", "kind", "status", "waiting_on", "priority", "starts_on", "ends_on", "hard_deadline",
	"metric_source", "metric_start", "metric_target", "metric_unit",
	"effort_min_minutes", "effort_max_minutes", "effort_note", "indoor",
	"cost_diy_low", "cost_diy_high", "cost_pro_low", "cost_pro_high", "cost_note", "value_note",
	"season_months", "conditions", "serves", "involves_children", "visibility",
];

// Added by 0096. Written only when the request mentions them, so every other
// edit keeps working on a database that hasn't had that migration yet.
const PLAN_COLUMNS = [
	["ref_code", "refCode"], ["revision", "revision"], ["pinned_at", "pinned"],
	["budget_working", "budget"], ["budget_ceiling", "budget"], ["budget_note", "budget"],
];
// Added by 0097 (execution). On an update they are written whenever the row
// already has them — so clearing works — and on a create only when mentioned.
const OUTCOME_COLUMNS = [["done_when", "doneWhen"], ["done_when_confirmed", "doneWhenConfirmed"]];
const columnsFor = (input, row = null) => [
	...PROJECT_COLUMNS,
	...PLAN_COLUMNS.filter(([, key]) => input[key] !== undefined).map(([c]) => c),
	...OUTCOME_COLUMNS.filter(([c, key]) => input[key] !== undefined || (row && c in row)).map(([c]) => c),
];
const STEP_COLUMNS = ["title", "detail", "status", "who", "blocked_on", "due_on", "effort_minutes", "indoor"];
const STEP_FOLLOW_COLUMNS = [
	["phase", "phase"], ["acceptance_criteria", "acceptanceCriteria"], ["waiting_on_actor", "waitingOnActor"],
	["review_at", "reviewAt"], ["unblock_action", "unblockAction"],
];
const stepColumnsFor = (input, row = null) => [
	...STEP_COLUMNS,
	...STEP_FOLLOW_COLUMNS.filter(([c, key]) => input[key] !== undefined || (row && c in row)).map(([c]) => c),
];
const stepValues = (f, columns) => columns.map((c) => (c === "indoor" ? flag(f.indoor) : f[c]));

function projectValues(f, columns = PROJECT_COLUMNS) {
	return columns.map((c) => {
		if (c === "indoor") return flag(f.indoor);
		if (c === "involves_children") return f.involves_children ? 1 : 0;
		if (c === "season_months") return shape.monthsToMask(f.season_months);
		if (c === "conditions" || c === "serves" || c === "done_when_confirmed") return jsonCol(f[c]);
		return f[c];
	});
}

// --- Reading ----------------------------------------------------------------

/**
 * Everything for one person in one read: projects (with areas, steps and the
 * derived status), links, concerns and charters. The app holds the whole graph
 * and redraws from it after every write — a few hundred rows at most, and it
 * means no screen can show a link to a project another screen has not loaded.
 */
async function getAll(profileId, db = pool) {
	const [projects] = await db.query("SELECT * FROM athena_project WHERE profile_id = ? ORDER BY id LIMIT ?", [profileId, MAX_PROJECTS]);
	const prefs = await getPrefs(profileId, db);
	if (!projects.length) {
		const [charters] = await db.query("SELECT area, body, weights, updated_at FROM athena_area_charter WHERE profile_id = ?", [profileId]);
		const [concerns] = await db.query("SELECT * FROM athena_concern WHERE profile_id = ? ORDER BY id", [profileId]);
		return {
			projects: [], links: [],
			concerns: concerns.map((c) => ({ ...shape.toConcern(c), projects: [] })),
			charters: charters.map(toCharter),
			prefs,
		};
	}
	const ids = projects.map((p) => p.id);
	const [[areas], [steps], [links], [concerns], [concernLinks], [charters]] = await Promise.all([
		db.query("SELECT project_id, area, is_primary FROM athena_project_area WHERE project_id IN (?)", [ids]),
		db.query("SELECT * FROM athena_project_step WHERE project_id IN (?) ORDER BY project_id, ordinal, id", [ids]),
		db.query("SELECT from_project_id, to_project_id, relation, note FROM athena_project_link WHERE from_project_id IN (?)", [ids]),
		db.query("SELECT * FROM athena_concern WHERE profile_id = ? ORDER BY id", [profileId]),
		db.query(
			`SELECT cp.concern_id, cp.project_id FROM athena_concern_project cp
			 JOIN athena_concern c ON c.id = cp.concern_id WHERE c.profile_id = ?`,
			[profileId]
		),
		db.query("SELECT area, body, weights, updated_at FROM athena_area_charter WHERE profile_id = ?", [profileId]),
	]);

	// The journal table arrived in a later migration; a missing one costs the
	// photo counts, never the projects.
	const media = await entries.summaries(ids, db).catch(() => new Map());
	const bound = await bindings.forProjects(ids, db).catch(() => new Map());
	// Specs and materials (0096): the same — a missing table costs only them.
	const itemRows = await db.query("SELECT * FROM athena_project_item WHERE project_id IN (?) ORDER BY project_id, kind, ordinal, id", [ids])
		.then(([rows]) => rows).catch(() => []);
	// Step dependencies and work sessions (0097): the same again.
	const depRows = await db.query("SELECT step_id, depends_on_step_id FROM athena_project_step_dependency WHERE project_id IN (?)", [ids])
		.then(([rows]) => rows).catch(() => []);
	const sessionRows = await db.query(
		"SELECT * FROM athena_project_work_session WHERE profile_id = ? AND project_id IN (?) ORDER BY planned_start, id LIMIT 2000",
		[profileId, ids]
	).then(([rows]) => rows).catch(() => []);
	const stepUuidOf = new Map(steps.map((s) => [s.id, s.uuid]));
	const prereqsOf = new Map();
	for (const d of depRows) {
		if (!prereqsOf.has(d.step_id)) prereqsOf.set(d.step_id, []);
		const pre = stepUuidOf.get(d.depends_on_step_id);
		if (pre) prereqsOf.get(d.step_id).push(pre);
	}
	const uuidOf = new Map(projects.map((p) => [p.id, p.uuid]));
	const statusOf = new Map(projects.map((p) => [p.id, p.status]));
	const byProject = (rows, key = "project_id") => {
		const m = new Map();
		for (const r of rows) {
			if (!m.has(r[key])) m.set(r[key], []);
			m.get(r[key]).push(r);
		}
		return m;
	};
	const areasBy = byProject(areas);
	const stepsBy = byProject(steps);
	const itemsBy = byProject(itemRows);
	const sessionsBy = byProject(sessionRows);
	const depsBy = byProject(links.filter((l) => l.relation === "depends_on"), "from_project_id");
	const contributorsBy = byProject(links.filter((l) => l.relation === "contributes_to"), "to_project_id");

	const out = projects.map((row) => {
		const p = shape.toProject(row);
		const a = (areasBy.get(row.id) || []).map((x) => ({ area: x.area, primary: !!x.is_primary }));
		p.areas = a.length ? a : [{ area: "home", primary: true }];
		p.primaryArea = (p.areas.find((x) => x.primary) || p.areas[0]).area;
		p.steps = (stepsBy.get(row.id) || []).map((s) => ({ ...shape.toStep(s), dependsOn: prereqsOf.get(s.id) || [] }));
		p.sessions = (sessionsBy.get(row.id) || []).map((s) => shape.toSession(s, s.step_id ? stepUuidOf.get(s.step_id) || null : null));
		p.items = (itemsBy.get(row.id) || []).map(shape.toItem);
		p.media = media.get(row.id) || { entries: 0, photos: 0, cover: null };
		p.bindings = bound.get(row.id) || [];
		const deps = (depsBy.get(row.id) || []).map((l) => ({ status: statusOf.get(l.to_project_id) }));
		p.effectiveStatus = shape.effectiveStatus(p, deps);
		const contributors = (contributorsBy.get(row.id) || []).map((l) => statusOf.get(l.from_project_id));
		const counted = contributors.filter((s) => s !== "dropped");
		const stepsCounted = p.steps.filter((s) => s.status !== "skipped");
		p.progress = {
			steps: { done: stepsCounted.filter((s) => s.status === "done").length, total: stepsCounted.length },
			contributors: { done: counted.filter((s) => s === "done").length, total: counted.length },
		};
		return p;
	});

	const concernProjects = byProject(concernLinks, "concern_id");
	return {
		projects: out,
		links: links.map((l) => ({
			from: uuidOf.get(l.from_project_id),
			to: uuidOf.get(l.to_project_id),
			relation: l.relation,
			note: l.note || null,
		})).filter((l) => l.from && l.to),
		concerns: concerns.map((c) => ({
			...shape.toConcern(c),
			projects: (concernProjects.get(c.id) || []).map((x) => uuidOf.get(x.project_id)).filter(Boolean),
		})),
		charters: charters.map(toCharter),
		prefs,
	};
}

function toCharter(row) {
	let weights = row.weights;
	if (typeof weights === "string") {
		try { weights = JSON.parse(weights); } catch { weights = null; }
	}
	return { area: row.area, body: row.body, weights: weights || null, updatedAt: row.updated_at };
}

async function rowByUuid(profileId, uuid, db = pool) {
	const [rows] = await db.query("SELECT * FROM athena_project WHERE profile_id = ? AND uuid = ? LIMIT 1", [profileId, String(uuid || "")]);
	return rows[0] || null;
}

async function areasFor(projectId, db = pool) {
	const [rows] = await db.query("SELECT area, is_primary FROM athena_project_area WHERE project_id = ?", [projectId]);
	return rows.map((r) => ({ area: r.area, primary: !!r.is_primary }));
}

async function writeAreas(projectId, areas, db) {
	await db.query("DELETE FROM athena_project_area WHERE project_id = ?", [projectId]);
	for (const a of areas) {
		await db.query("INSERT INTO athena_project_area (project_id, area, is_primary) VALUES (?,?,?)", [projectId, a.area, a.primary ? 1 : 0]);
	}
}

// --- Projects ---------------------------------------------------------------

async function create(profileId, input = {}, { source = "manual", importKey = null, db = null } = {}) {
	const run = async (conn) => {
		const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM athena_project WHERE profile_id = ?", [profileId]);
		if (n >= MAX_PROJECTS) throw bad(`That is already ${MAX_PROJECTS} projects — finish or remove some first.`);
		const f = shape.normalizeProject(input);
		const areas = shape.normalizeAreas(input);
		const uuid = randomUUID();
		const done = f.status === "done";
		const completedAt = done ? (input.completedAt ? new Date(input.completedAt) : new Date()) : null;
		const columns = columnsFor(input);
		const [result] = await conn.query(
			`INSERT INTO athena_project (uuid, profile_id, ${columns.join(", ")}, completed_at, source, import_key)
			 VALUES (?, ?, ${columns.map(() => "?").join(", ")}, ?, ?, ?)`,
			[uuid, profileId, ...projectValues(f, columns), completedAt, String(source).slice(0, 16), importKey]
		);
		await writeAreas(result.insertId, areas, conn);
		if (f.status === "active") await markActivated(result.insertId, conn);
		return { id: result.insertId, uuid };
	};
	return db ? run(db) : withTx(run);
}

/**
 * Change a project. A status change is progress, and leaving "done" clears the
 * completion time so the two can never disagree.
 */
async function update(profileId, uuid, patch = {}) {
	return withTx(async (conn) => {
		const row = await rowByUuid(profileId, uuid, conn);
		if (!row) throw notFound("project");
		const existing = shape.toProject(row);
		existing.areas = await areasFor(row.id, conn);
		existing.primaryArea = (existing.areas.find((a) => a.primary) || existing.areas[0] || { area: "home" }).area;
		const f = shape.normalizeProject(patch, existing);
		const areas = shape.normalizeAreas(patch, existing);
		if (f.involves_children && !existing.involvesChildren) {
			const [[{ n }]] = await conn.query(
				"SELECT COUNT(*) AS n FROM athena_project_entry WHERE project_id = ? AND media_location = 'server'",
				[row.id]
			).catch(() => [[{ n: 0 }]]);
			if (n) throw bad(`This project has ${n} stored photo${n === 1 ? "" : "s"}. Photos of children stay on the device, so delete those first.`);
		}
		const moved = f.status !== existing.status;
		const completedAt = f.status === "done" ? existing.completedAt || new Date() : null;
		// Closing a project that says what done looks like is the person
		// confirming that outcome — it needs `outcomeConfirmed`, and it ticks
		// every criterion. Nothing else (a model included) can close it quietly.
		const criteria = shape.criteriaOf(f.done_when);
		const closing = f.status === "done" && existing.status !== "done";
		if (closing && criteria.length && patch.outcomeConfirmed !== true) {
			throw Object.assign(bad(`"${existing.title}" says what done looks like. Confirm the outcome to close it out.`), { code: "outcome_unconfirmed" });
		}
		if (closing && criteria.length) f.done_when_confirmed = criteria;
		const hasOutcomeColumn = "outcome_confirmed_at" in row;
		const outcomeAt = f.status !== "done" ? null
			: row.outcome_confirmed_at || (closing && patch.outcomeConfirmed === true ? new Date() : null);
		const columns = columnsFor(patch, row);
		await conn.query(
			`UPDATE athena_project SET ${columns.map((c) => `${c} = ?`).join(", ")}, completed_at = ?
			 ${hasOutcomeColumn ? ", outcome_confirmed_at = ?" : ""}
			 ${moved ? ", last_progress_at = NOW()" : ""}
			 WHERE id = ?`,
			[...projectValues(f, columns), completedAt, ...(hasOutcomeColumn ? [outcomeAt] : []), row.id]
		);
		if (areas) await writeAreas(row.id, areas, conn);
		if (f.status === "active" && moved) await markActivated(row.id, conn);
		return { uuid };
	});
}

/** The first time a project goes active, for "activation to verified completion". Before 0097 there is nowhere to put it. */
function markActivated(projectId, conn) {
	return conn.query("UPDATE athena_project SET activated_at = COALESCE(activated_at, NOW()) WHERE id = ?", [projectId]).catch(() => {});
}

/** Deleting cascades to its steps, areas and links (FKs), and to concern links. */
async function remove(profileId, uuid) {
	const [result] = await pool.query("DELETE FROM athena_project WHERE profile_id = ? AND uuid = ?", [profileId, String(uuid || "")]);
	if (!result.affectedRows) throw notFound("project");
	return true;
}

// --- Steps ------------------------------------------------------------------

async function addStep(profileId, projectUuid, input = {}, { db = null } = {}) {
	const run = async (conn) => {
		const project = await rowByUuid(profileId, projectUuid, conn);
		if (!project) throw notFound("project");
		const [[{ n, last }]] = await conn.query(
			"SELECT COUNT(*) AS n, COALESCE(MAX(ordinal), -1) AS last FROM athena_project_step WHERE project_id = ?",
			[project.id]
		);
		if (n >= MAX_STEPS) throw bad(`A project can have at most ${MAX_STEPS} steps.`);
		const f = shape.normalizeStep(input);
		const uuid = randomUUID();
		const columns = stepColumnsFor(input);
		const [result] = await conn.query(
			`INSERT INTO athena_project_step (uuid, project_id, ordinal, ${columns.join(", ")}, completed_at)
			 VALUES (?,?,?,${columns.map(() => "?").join(",")},?)`,
			[uuid, project.id, Number(last) + 1, ...stepValues(f, columns), f.status === "done" ? new Date() : null]
		);
		if (input.dependsOn !== undefined) await writeDependencies(project.id, result.insertId, input.dependsOn, conn);
		await conn.query("UPDATE athena_project SET last_progress_at = NOW() WHERE id = ?", [project.id]);
		return { uuid };
	};
	return db ? run(db) : withTx(run);
}

async function stepRow(profileId, projectUuid, stepUuid, db = pool) {
	const [rows] = await db.query(
		`SELECT s.*, p.id AS pid FROM athena_project_step s
		 JOIN athena_project p ON p.id = s.project_id
		 WHERE p.profile_id = ? AND p.uuid = ? AND s.uuid = ? LIMIT 1`,
		[profileId, String(projectUuid || ""), String(stepUuid || "")]
	);
	return rows[0] || null;
}

/**
 * Change a step. Unblocking clears its follow-through fields; `dependsOn`
 * (a list of the same project's step uuids) replaces its prerequisites.
 */
async function updateStep(profileId, projectUuid, stepUuid, patch = {}, { db = null } = {}) {
	const run = async (conn) => {
		const row = await stepRow(profileId, projectUuid, stepUuid, conn);
		if (!row) throw notFound("step");
		const existing = shape.toStep(row);
		const f = shape.normalizeStep(patch, existing);
		const completedAt = f.status === "done" ? existing.completedAt || new Date() : null;
		const columns = stepColumnsFor(patch, row);
		await conn.query(
			`UPDATE athena_project_step SET ${columns.map((c) => `${c} = ?`).join(", ")}, completed_at = ? WHERE id = ?`,
			[...stepValues(f, columns), completedAt, row.id]
		);
		if (patch.dependsOn !== undefined) await writeDependencies(row.pid, row.id, patch.dependsOn, conn);
		if (f.status !== existing.status) await conn.query("UPDATE athena_project SET last_progress_at = NOW() WHERE id = ?", [row.pid]);
		return { uuid: stepUuid };
	};
	return db ? run(db) : withTx(run);
}

// --- Step dependencies --------------------------------------------------------

const MAX_PREREQS = 20;

/**
 * Replace one step's prerequisites. Every prerequisite must be a step of the
 * same project; a step can't need itself, and no chain may loop back. The
 * database refuses a cross-project edge too (composite foreign keys, 0097).
 */
async function writeDependencies(projectId, stepId, uuids, conn) {
	if (uuids !== null && !Array.isArray(uuids)) throw bad("Prerequisites must be a list of steps.");
	const list = [...new Set((uuids || []).map(String))];
	if (list.length > MAX_PREREQS) throw bad(`A step can need at most ${MAX_PREREQS} others first.`);
	const [steps] = await conn.query("SELECT id, uuid, title FROM athena_project_step WHERE project_id = ?", [projectId]);
	const byUuid = new Map(steps.map((s) => [s.uuid, s]));
	const self = steps.find((s) => s.id === stepId);
	const ids = list.map((u) => {
		const s = byUuid.get(u);
		if (!s) throw bad("A step can only need steps of the same project.");
		if (s.id === stepId) throw bad("A step can't need itself first.");
		return s.id;
	});
	const [edges] = await conn.query(
		"SELECT step_id, depends_on_step_id FROM athena_project_step_dependency WHERE project_id = ? AND step_id <> ?",
		[projectId, stepId]
	);
	const pairs = edges.map((e) => [e.step_id, e.depends_on_step_id]);
	for (const id of ids) {
		if (shape.wouldCycle(pairs, stepId, id)) {
			const other = steps.find((s) => s.id === id);
			throw bad(`That would make "${self?.title}" and "${other?.title}" wait on each other.`);
		}
		pairs.push([stepId, id]);
	}
	await conn.query("DELETE FROM athena_project_step_dependency WHERE step_id = ?", [stepId]);
	for (const id of ids) {
		await conn.query(
			"INSERT INTO athena_project_step_dependency (project_id, step_id, depends_on_step_id) VALUES (?,?,?)",
			[projectId, stepId, id]
		);
	}
	return true;
}

/** Add one prerequisite to a step, keeping the ones it has. */
async function addStepDependency(profileId, projectUuid, stepUuid, dependsOnUuid, { db = null } = {}) {
	const run = async (conn) => {
		const row = await stepRow(profileId, projectUuid, stepUuid, conn);
		if (!row) throw notFound("step");
		const [have] = await conn.query(
			"SELECT s.uuid FROM athena_project_step_dependency d JOIN athena_project_step s ON s.id = d.depends_on_step_id WHERE d.step_id = ?",
			[row.id]
		);
		await writeDependencies(row.pid, row.id, [...have.map((h) => h.uuid), String(dependsOnUuid || "")], conn);
		return true;
	};
	return db ? run(db) : withTx(run);
}

async function removeStepDependency(profileId, projectUuid, stepUuid, dependsOnUuid) {
	const row = await stepRow(profileId, projectUuid, stepUuid);
	if (!row) throw notFound("step");
	await pool.query(
		`DELETE d FROM athena_project_step_dependency d JOIN athena_project_step s ON s.id = d.depends_on_step_id
		 WHERE d.step_id = ? AND s.uuid = ?`,
		[row.id, String(dependsOnUuid || "")]
	);
	return true;
}

// --- Work sessions ------------------------------------------------------------

const MAX_OPEN_SESSIONS = 100;

async function sessionRow(profileId, projectUuid, sessionUuid, db = pool) {
	const [rows] = await db.query(
		`SELECT w.*, p.id AS pid, s.uuid AS step_uuid FROM athena_project_work_session w
		 JOIN athena_project p ON p.id = w.project_id
		 LEFT JOIN athena_project_step s ON s.id = w.step_id
		 WHERE w.profile_id = ? AND p.profile_id = ? AND p.uuid = ? AND w.uuid = ? LIMIT 1`,
		[profileId, profileId, String(projectUuid || ""), String(sessionUuid || "")]
	);
	return rows[0] || null;
}

/** Another open session on the same work that overlaps this time — booking it twice is a mistake, not a plan. */
async function overlapping(conn, { profileId, projectId, stepId, start, minutes, exceptId = 0 }) {
	const [rows] = await conn.query(
		`SELECT uuid FROM athena_project_work_session
		 WHERE profile_id = ? AND project_id = ? AND id <> ? AND status IN ('planned','in_progress')
		   AND step_id <=> ?
		   AND planned_start < DATE_ADD(?, INTERVAL ? MINUTE)
		   AND DATE_ADD(planned_start, INTERVAL planned_duration_minutes MINUTE) > ?
		 LIMIT 1`,
		[profileId, projectId, exceptId, stepId, start, minutes, start]
	);
	return rows[0] || null;
}

async function stepIdIn(conn, projectId, stepUuid) {
	const [[step]] = await conn.query("SELECT id FROM athena_project_step WHERE project_id = ? AND uuid = ? LIMIT 1", [projectId, String(stepUuid)]);
	if (!step) throw bad("That step isn't part of this project.");
	return step.id;
}

/**
 * Set time aside for a project, or for one of its steps. A step must belong
 * to the project, and the same work can't be booked twice over the same time.
 * Nothing here touches a calendar; that is an approved action of its own.
 */
async function createSession(profileId, projectUuid, input = {}, { db = null } = {}) {
	const run = async (conn) => {
		const [[project]] = await conn.query(
			"SELECT id, status FROM athena_project WHERE profile_id = ? AND uuid = ? LIMIT 1 FOR UPDATE",
			[profileId, String(projectUuid || "")]
		);
		if (!project) throw notFound("project");
		if (shape.CLOSED.has(project.status)) throw bad("That project is closed — reopen it to schedule work.");
		const f = shape.normalizeSession({ ...input, status: input.status ?? "planned" });
		const stepId = input.stepUuid ? await stepIdIn(conn, project.id, input.stepUuid) : null;
		const [[{ n }]] = await conn.query(
			"SELECT COUNT(*) AS n FROM athena_project_work_session WHERE profile_id = ? AND status IN ('planned','in_progress')",
			[profileId]
		);
		if (n >= MAX_OPEN_SESSIONS) throw bad(`That is already ${MAX_OPEN_SESSIONS} planned sessions.`);
		const clash = await overlapping(conn, { profileId, projectId: project.id, stepId, start: f.planned_start, minutes: f.planned_duration_minutes });
		if (clash) throw Object.assign(bad("That work is already scheduled at that time."), { code: "duplicate_session", sessionUuid: clash.uuid });
		const uuid = randomUUID();
		await conn.query(
			`INSERT INTO athena_project_work_session
			   (uuid, profile_id, project_id, step_id, planned_start, planned_duration_minutes, actual_duration_minutes, status, made_progress, notes)
			 VALUES (?,?,?,?,?,?,?,?,?,?)`,
			[uuid, profileId, project.id, stepId, f.planned_start, f.planned_duration_minutes, f.actual_duration_minutes, f.status, flag(f.made_progress), f.notes]
		);
		return { uuid };
	};
	return db ? run(db) : withTx(run);
}

/**
 * Reschedule a session (same row, same uuid — its calendar event, if any,
 * stays attached and is moved only by an approved calendar action), or say
 * how it went. Completing a session never completes its step.
 */
async function updateSession(profileId, projectUuid, sessionUuid, patch = {}, { db = null } = {}) {
	const run = async (conn) => {
		const row = await sessionRow(profileId, projectUuid, sessionUuid, conn);
		if (!row) throw notFound("work session");
		const existing = shape.toSession(row, row.step_uuid);
		const f = shape.normalizeSession(patch, existing);
		let stepId = row.step_id;
		if (patch.stepUuid !== undefined) stepId = patch.stepUuid ? await stepIdIn(conn, row.pid, patch.stepUuid) : null;
		const moved = f.planned_start !== shape.read.when(existing.plannedStart) || f.planned_duration_minutes !== existing.plannedMinutes;
		if ((moved || stepId !== row.step_id) && ["planned", "in_progress"].includes(f.status)) {
			const clash = await overlapping(conn, { profileId, projectId: row.pid, stepId, start: f.planned_start, minutes: f.planned_duration_minutes, exceptId: row.id });
			if (clash) throw Object.assign(bad("That work is already scheduled at that time."), { code: "duplicate_session", sessionUuid: clash.uuid });
		}
		const completedAt = f.status === "completed" ? row.completed_at || new Date() : null;
		await conn.query(
			`UPDATE athena_project_work_session SET step_id = ?, planned_start = ?, planned_duration_minutes = ?, actual_duration_minutes = ?,
			   status = ?, made_progress = ?, notes = ?, completed_at = ? WHERE id = ?`,
			[stepId, f.planned_start, f.planned_duration_minutes, f.actual_duration_minutes, f.status, flag(f.made_progress), f.notes, completedAt, row.id]
		);
		if (f.status === "completed" && existing.status !== "completed" && f.made_progress !== false) {
			await conn.query("UPDATE athena_project SET last_progress_at = NOW() WHERE id = ?", [row.pid]);
		}
		return { uuid: sessionUuid, moved, calendarEventId: row.calendar_event_id || null };
	};
	return db ? run(db) : withTx(run);
}

/** Delete a session. Its calendar event, if any, is left for an approved action (or the person) to remove. */
async function removeSession(profileId, projectUuid, sessionUuid) {
	const row = await sessionRow(profileId, projectUuid, sessionUuid);
	if (!row) throw notFound("work session");
	await pool.query("DELETE FROM athena_project_work_session WHERE id = ?", [row.id]);
	return { uuid: sessionUuid, calendarEventId: row.calendar_event_id || null };
}

/** For the approved calendar action only: which event this session now is (or none), and the start it was written with. */
async function setSessionCalendarEvent(profileId, sessionUuid, eventId, start = null) {
	const [result] = await pool.query(
		"UPDATE athena_project_work_session SET calendar_event_id = ?, calendar_start = ? WHERE profile_id = ? AND uuid = ?",
		[eventId || null, eventId && start ? shape.read.when(start) : null, profileId, String(sessionUuid || "")]
	);
	if (!result.affectedRows) throw notFound("work session");
	return true;
}

/** One session by uuid with its project and step, for the actions. */
async function findSession(profileId, sessionUuid) {
	const [rows] = await pool.query(
		`SELECT w.*, p.id AS pid, p.uuid AS project_uuid, p.title AS project_title, s.uuid AS step_uuid, s.title AS step_title
		 FROM athena_project_work_session w
		 JOIN athena_project p ON p.id = w.project_id AND p.profile_id = w.profile_id
		 LEFT JOIN athena_project_step s ON s.id = w.step_id
		 WHERE w.profile_id = ? AND w.uuid = ? LIMIT 1`,
		[profileId, String(sessionUuid || "")]
	);
	return rows[0] || null;
}

/** A project's open sessions by internal id — for the actions, which already resolved the project. Returns mysql's [rows]. */
function openSessionsOf(profileId, projectId) {
	return pool.query(
		`SELECT w.uuid, w.planned_start, w.planned_duration_minutes, w.status, w.calendar_event_id, s.uuid AS step_uuid, s.title AS step_title
		 FROM athena_project_work_session w LEFT JOIN athena_project_step s ON s.id = w.step_id
		 WHERE w.profile_id = ? AND w.project_id = ? AND w.status IN ('planned','in_progress') ORDER BY w.planned_start`,
		[profileId, projectId]
	);
}

/** Every planned session still ahead, across their projects, soonest first. */
async function getUpcomingWorkSessions(profileId, now = Date.now()) {
	return require("./execution").upcomingAcross(await getAll(profileId), now);
}

// --- Recommendation preference ------------------------------------------------

/** The work-in-progress preference. Before 0097, or with no row, the defaults. */
async function getPrefs(profileId, db = pool) {
	const { DEFAULT_PREFS } = require("./execution");
	const [rows] = await db.query("SELECT focus_limit, prefer_finishing FROM athena_project_pref WHERE profile_id = ?", [profileId])
		.catch(() => [[]]);
	const r = rows && rows[0];
	return r ? { focusLimit: Number(r.focus_limit), preferFinishing: !!r.prefer_finishing } : { ...DEFAULT_PREFS };
}

async function putPrefs(profileId, input = {}) {
	const current = await getPrefs(profileId);
	const focusLimit = input.focusLimit === undefined ? current.focusLimit : Number(input.focusLimit);
	if (!Number.isInteger(focusLimit) || focusLimit < 1 || focusLimit > 10) throw bad("Focus on 1 to 10 projects at a time.");
	const preferFinishing = input.preferFinishing === undefined ? current.preferFinishing : !!input.preferFinishing;
	await pool.query(
		`INSERT INTO athena_project_pref (profile_id, focus_limit, prefer_finishing) VALUES (?,?,?)
		 ON DUPLICATE KEY UPDATE focus_limit = VALUES(focus_limit), prefer_finishing = VALUES(prefer_finishing)`,
		[profileId, focusLimit, preferFinishing ? 1 : 0]
	);
	return { focusLimit, preferFinishing };
}

async function removeStep(profileId, projectUuid, stepUuid) {
	const row = await stepRow(profileId, projectUuid, stepUuid);
	if (!row) throw notFound("step");
	await pool.query("DELETE FROM athena_project_step WHERE id = ?", [row.id]);
	return true;
}

/** Reorder by a full list of the project's step uuids; anything unnamed keeps its place after them. */
async function reorderSteps(profileId, projectUuid, order) {
	if (!Array.isArray(order)) throw bad("Send the steps in their new order.");
	return withTx(async (conn) => {
		const project = await rowByUuid(profileId, projectUuid, conn);
		if (!project) throw notFound("project");
		const [steps] = await conn.query("SELECT id, uuid FROM athena_project_step WHERE project_id = ? ORDER BY ordinal, id", [project.id]);
		const named = order.map(String).filter((u) => steps.some((s) => s.uuid === u));
		const rest = steps.filter((s) => !named.includes(s.uuid)).map((s) => s.uuid);
		const final = [...new Set([...named, ...rest])];
		for (let i = 0; i < final.length; i++) {
			await conn.query("UPDATE athena_project_step SET ordinal = ? WHERE project_id = ? AND uuid = ?", [i, project.id, final[i]]);
		}
		return true;
	});
}

// --- Specs & materials --------------------------------------------------------

const MAX_ITEMS = 200;

async function addItem(profileId, projectUuid, input = {}, { db = null } = {}) {
	const run = async (conn) => {
		const project = await rowByUuid(profileId, projectUuid, conn);
		if (!project) throw notFound("project");
		const f = shape.normalizeItem(input);
		const [[{ n, last }]] = await conn.query(
			"SELECT COUNT(*) AS n, COALESCE(MAX(ordinal), -1) AS last FROM athena_project_item WHERE project_id = ? AND kind = ?",
			[project.id, f.kind]
		);
		if (n >= MAX_ITEMS) throw bad(`A project can have at most ${MAX_ITEMS} of those.`);
		const uuid = randomUUID();
		await conn.query(
			`INSERT INTO athena_project_item (uuid, project_id, kind, ordinal, label, value, unit, status, cost_low, cost_high, note, confirmed_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			[uuid, project.id, f.kind, Number(last) + 1, f.label, f.value, f.unit, f.status, f.cost_low, f.cost_high, f.note,
				f.status === "confirmed" ? new Date() : null]
		);
		return { uuid };
	};
	return db ? run(db) : withTx(run);
}

async function itemRow(profileId, projectUuid, itemUuid, db = pool) {
	const [rows] = await db.query(
		`SELECT i.*, p.id AS pid FROM athena_project_item i
		 JOIN athena_project p ON p.id = i.project_id
		 WHERE p.profile_id = ? AND p.uuid = ? AND i.uuid = ? LIMIT 1`,
		[profileId, String(projectUuid || ""), String(itemUuid || "")]
	);
	return rows[0] || null;
}

/** Confirming one is progress; un-confirming clears when it was confirmed. Kind never changes. */
async function updateItem(profileId, projectUuid, itemUuid, patch = {}) {
	const row = await itemRow(profileId, projectUuid, itemUuid);
	if (!row) throw notFound("item");
	const existing = shape.toItem(row);
	const f = shape.normalizeItem({ ...patch, kind: undefined }, existing);
	const confirmedAt = f.status === "confirmed" ? existing.confirmedAt || new Date() : null;
	await pool.query(
		`UPDATE athena_project_item SET label=?, value=?, unit=?, status=?, cost_low=?, cost_high=?, note=?, confirmed_at=? WHERE id = ?`,
		[f.label, f.value, f.unit, f.status, f.cost_low, f.cost_high, f.note, confirmedAt, row.id]
	);
	if (f.status !== existing.status) await pool.query("UPDATE athena_project SET last_progress_at = NOW() WHERE id = ?", [row.pid]);
	return { uuid: itemUuid };
}

async function removeItem(profileId, projectUuid, itemUuid) {
	const row = await itemRow(profileId, projectUuid, itemUuid);
	if (!row) throw notFound("item");
	await pool.query("DELETE FROM athena_project_item WHERE id = ?", [row.id]);
	return true;
}

// --- Links ------------------------------------------------------------------

async function addLink(profileId, fromUuid, { relation, to, note } = {}, { db = null } = {}) {
	const rel = shape.read.pick(relation, shape.RELATIONS, undefined, "Relation");
	const run = async (conn) => {
		const from = await rowByUuid(profileId, fromUuid, conn);
		const target = await rowByUuid(profileId, to, conn);
		if (!from || !target) throw notFound("project");
		const [edges] = await conn.query(
			`SELECT l.from_project_id, l.to_project_id FROM athena_project_link l
			 JOIN athena_project p ON p.id = l.from_project_id
			 WHERE p.profile_id = ? AND l.relation = ?`,
			[profileId, rel]
		);
		if (shape.wouldCycle(edges.map((e) => [e.from_project_id, e.to_project_id]), from.id, target.id)) {
			throw bad(from.id === target.id
				? "A project can't link to itself."
				: rel === "depends_on"
					? `That would make "${from.title}" and "${target.title}" wait on each other.`
					: `"${target.title}" is already part of "${from.title}".`);
		}
		await conn.query(
			`INSERT INTO athena_project_link (from_project_id, to_project_id, relation, note) VALUES (?,?,?,?)
			 ON DUPLICATE KEY UPDATE note = VALUES(note)`,
			[from.id, target.id, rel, shape.read.text(note, 190, null)]
		);
		return true;
	};
	return db ? run(db) : withTx(run);
}

async function removeLink(profileId, fromUuid, { relation, to } = {}) {
	const rel = shape.read.pick(relation, shape.RELATIONS, undefined, "Relation");
	const from = await rowByUuid(profileId, fromUuid);
	const target = await rowByUuid(profileId, to);
	if (!from || !target) throw notFound("project");
	await pool.query(
		"DELETE FROM athena_project_link WHERE from_project_id = ? AND to_project_id = ? AND relation = ?",
		[from.id, target.id, rel]
	);
	return true;
}

// --- Concerns ---------------------------------------------------------------

async function projectIdsFor(profileId, uuids, conn) {
	if (!Array.isArray(uuids)) throw bad("Projects must be a list.");
	const list = [...new Set(uuids.map(String))].slice(0, 200);
	if (!list.length) return [];
	const [rows] = await conn.query("SELECT id, uuid FROM athena_project WHERE profile_id = ? AND uuid IN (?)", [profileId, list]);
	if (rows.length !== list.length) throw notFound("project");
	return rows.map((r) => r.id);
}

async function setConcernProjects(concernId, ids, conn) {
	await conn.query("DELETE FROM athena_concern_project WHERE concern_id = ?", [concernId]);
	for (const id of ids) await conn.query("INSERT INTO athena_concern_project (concern_id, project_id) VALUES (?,?)", [concernId, id]);
}

async function createConcern(profileId, input = {}, { importKey = null, projectIds = null, db = null } = {}) {
	const run = async (conn) => {
		const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM athena_concern WHERE profile_id = ?", [profileId]);
		if (n >= MAX_CONCERNS) throw bad(`That is already ${MAX_CONCERNS} concerns.`);
		const f = shape.normalizeConcern(input);
		const uuid = randomUUID();
		const [result] = await conn.query(
			`INSERT INTO athena_concern (uuid, profile_id, area, title, severity, frequency, likely_cause, goal_impact, assessment, status, resolved_at, import_key)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			[uuid, profileId, f.area, f.title, f.severity, f.frequency, f.likely_cause, f.goal_impact, f.assessment, f.status,
				f.status === "resolved" ? new Date() : null, importKey]
		);
		const ids = projectIds ?? (input.projects ? await projectIdsFor(profileId, input.projects, conn) : []);
		await setConcernProjects(result.insertId, ids, conn);
		return { uuid };
	};
	return db ? run(db) : withTx(run);
}

async function updateConcern(profileId, uuid, patch = {}) {
	return withTx(async (conn) => {
		const [rows] = await conn.query("SELECT * FROM athena_concern WHERE profile_id = ? AND uuid = ? LIMIT 1", [profileId, String(uuid || "")]);
		if (!rows.length) throw notFound("concern");
		const existing = shape.toConcern(rows[0]);
		const f = shape.normalizeConcern(patch, existing);
		const resolvedAt = f.status === "resolved" ? existing.resolvedAt || new Date() : null;
		await conn.query(
			`UPDATE athena_concern SET area=?, title=?, severity=?, frequency=?, likely_cause=?, goal_impact=?, assessment=?, status=?, resolved_at=?
			 WHERE id = ?`,
			[f.area, f.title, f.severity, f.frequency, f.likely_cause, f.goal_impact, f.assessment, f.status, resolvedAt, rows[0].id]
		);
		if (patch.projects !== undefined) await setConcernProjects(rows[0].id, await projectIdsFor(profileId, patch.projects || [], conn), conn);
		return { uuid };
	});
}

async function removeConcern(profileId, uuid) {
	const [result] = await pool.query("DELETE FROM athena_concern WHERE profile_id = ? AND uuid = ?", [profileId, String(uuid || "")]);
	if (!result.affectedRows) throw notFound("concern");
	return true;
}

// --- Charters ---------------------------------------------------------------

async function putCharter(profileId, area, input = {}, { db = pool } = {}) {
	const a = shape.read.pick(area, shape.AREAS, undefined, "Area");
	const f = shape.normalizeCharter(input);
	await db.query(
		`INSERT INTO athena_area_charter (profile_id, area, body, weights) VALUES (?,?,?,?)
		 ON DUPLICATE KEY UPDATE body = VALUES(body), weights = VALUES(weights)`,
		[profileId, a, f.body, jsonCol(f.weights)]
	);
	return true;
}

/**
 * Find one of their projects by the title a model or a person typed. Exact
 * (case-insensitive) wins; otherwise a single containing match; anything
 * ambiguous or absent throws, naming the candidates — never a guess.
 */
async function findByTitle(profileId, title) {
	const want = String(title || "").trim().toLowerCase();
	if (!want) throw bad("Say which project.");
	const [rows] = await pool.query("SELECT * FROM athena_project WHERE profile_id = ? LIMIT ?", [profileId, MAX_PROJECTS]);
	const exact = rows.filter((r) => r.title.toLowerCase() === want);
	if (exact.length === 1) return exact[0];
	const open = (list) => list.filter((r) => !shape.CLOSED.has(r.status));
	const partial = rows.filter((r) => r.title.toLowerCase().includes(want) || want.includes(r.title.toLowerCase()));
	const pick = exact.length > 1 ? open(exact) : partial.length > 1 ? open(partial) : partial;
	if (pick.length === 1) return pick[0];
	if (!pick.length && !partial.length) throw bad(`There's no project called "${title}".`);
	const names = (pick.length ? pick : partial).slice(0, 5).map((r) => `"${r.title}"`).join(", ");
	throw bad(`"${title}" could be ${names} — say which.`);
}

/** A project's steps by internal id — for callers that already resolved the project (the actions). Returns mysql's [rows]. */
function stepsOf(projectId) {
	return pool.query("SELECT * FROM athena_project_step WHERE project_id = ? ORDER BY ordinal, id", [projectId]);
}

/** A project's specs and materials by internal id, the same way. Before 0096 there are none. */
function itemsOf(projectId) {
	return pool.query("SELECT uuid, kind, label, status FROM athena_project_item WHERE project_id = ? ORDER BY kind, ordinal, id", [projectId])
		.catch(() => [[]]);
}

module.exports = {
	MAX_PROJECTS,
	findByTitle, stepsOf, itemsOf,
	withTx, getAll, rowByUuid,
	create, update, remove,
	addStep, updateStep, removeStep, reorderSteps,
	addStepDependency, removeStepDependency,
	createSession, updateSession, removeSession, setSessionCalendarEvent, findSession, openSessionsOf, getUpcomingWorkSessions,
	getPrefs, putPrefs,
	addItem, updateItem, removeItem,
	addLink, removeLink,
	createConcern, updateConcern, removeConcern,
	putCharter,
};
