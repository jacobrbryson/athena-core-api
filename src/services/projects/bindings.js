/**
 * Bindings: a project reading what Athena already has, live.
 *
 * Phase 2 of docs/architecture/projects.md — the three sources that need
 * nothing new: a health metric (weight, from the smart scale), WHOOP workouts
 * by sport, and calendar events by title. A binding is a selector; this file
 * is the only thing that interprets it, and it only ever filters a source the
 * person has already connected and consented to, through that source's own
 * reader (vesync.listWeighIns checks health consent; the calendar goes through
 * the guarded connector). Binding never creates access.
 *
 * Arithmetic, not opinion: "on track" is the planned line between the
 * project's start and target on its dates, against the average of the last
 * week of weigh-ins.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../../helpers/db");
const { bad } = require("./shape");

const SOURCE_TYPES = ["health_metric", "whoop_sport", "calendar_match"];
const METRICS = ["weight"];
const MAX_BINDINGS = 12;
const KG_PER_LB = 0.45359237;
const DAY = 86_400_000;

const notFound = (what) => Object.assign(new Error(`That ${what} is not on your list.`), { status: 404 });
const words = (list, label) => {
	if (!Array.isArray(list)) throw bad(`${label} must be a list.`);
	const out = [...new Set(list.map((w) => String(w ?? "").trim()).filter(Boolean))].slice(0, 10);
	if (!out.length) throw bad(`${label} needs at least one entry.`);
	if (out.some((w) => w.length > 60)) throw bad(`${label}: each entry is at most 60 characters.`);
	return out;
};

/** Validate a selector for its source type. Returns the clean selector. */
function normalizeSelector(sourceType, selector = {}) {
	if (!SOURCE_TYPES.includes(sourceType)) throw bad(`Source must be one of: ${SOURCE_TYPES.join(", ")}.`);
	if (sourceType === "health_metric") {
		const metric = String(selector.metric || "").toLowerCase();
		if (!METRICS.includes(metric)) throw bad(`Metric must be one of: ${METRICS.join(", ")}.`);
		return { metric };
	}
	if (sourceType === "whoop_sport") return { sports: words(selector.sports, "Sports").map((s) => s.toLowerCase()) };
	return { titleAny: words(selector.titleAny, "Calendar words") };
}

function toBinding(row) {
	let selector = row.selector;
	if (typeof selector === "string") {
		try { selector = JSON.parse(selector); } catch { selector = {}; }
	}
	return { uuid: row.uuid, sourceType: row.source_type, selector, status: row.status, proposedBy: row.proposed_by };
}

async function projectRow(profileId, uuid, db = pool) {
	const [rows] = await db.query("SELECT * FROM athena_project WHERE profile_id = ? AND uuid = ? LIMIT 1", [profileId, String(uuid || "")]);
	return rows[0] || null;
}

/** All bindings for these projects, keyed by project id. A missing table yields none. */
async function forProjects(projectIds, db = pool) {
	if (!projectIds.length) return new Map();
	const [rows] = await db.query(
		"SELECT * FROM athena_project_binding WHERE project_id IN (?) AND status <> 'rejected' ORDER BY id",
		[projectIds]
	);
	const out = new Map();
	for (const r of rows) {
		if (!out.has(r.project_id)) out.set(r.project_id, []);
		out.get(r.project_id).push(toBinding(r));
	}
	return out;
}

/** The person adding a binding themselves: confirmed at once. */
async function add(profileId, projectUuid, { sourceType, selector } = {}) {
	const project = await projectRow(profileId, projectUuid);
	if (!project) throw notFound("project");
	const clean = normalizeSelector(sourceType, selector);
	const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM athena_project_binding WHERE project_id = ? AND status <> 'rejected'", [project.id]);
	if (n >= MAX_BINDINGS) throw bad(`A project can read at most ${MAX_BINDINGS} sources.`);
	const uuid = randomUUID();
	await pool.query(
		`INSERT INTO athena_project_binding (uuid, project_id, source_type, selector, status, proposed_by, confirmed_at)
		 VALUES (?,?,?,?, 'confirmed', 'owner', NOW())`,
		[uuid, project.id, sourceType, JSON.stringify(clean)]
	);
	return { uuid };
}

async function remove(profileId, projectUuid, bindingUuid) {
	const [result] = await pool.query(
		`DELETE b FROM athena_project_binding b JOIN athena_project p ON p.id = b.project_id
		 WHERE p.profile_id = ? AND p.uuid = ? AND b.uuid = ?`,
		[profileId, String(projectUuid || ""), String(bindingUuid || "")]
	);
	if (!result.affectedRows) throw notFound("binding");
	return true;
}

// --- Reading ----------------------------------------------------------------

const day = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);

/**
 * The planned value on a date, on the straight line from start to target
 * across the project's dates. Null when the plan isn't fully stated.
 */
function planned({ start, target, startsOn, endsOn }, onDate) {
	if (start === null || target === null || !startsOn || !endsOn) return null;
	const a = Date.parse(startsOn), b = Date.parse(endsOn), t = Date.parse(onDate);
	if (!(b > a) || !Number.isFinite(t)) return null;
	const share = Math.max(0, Math.min(1, (t - a) / (b - a)));
	return Math.round((start + (target - start) * share) * 10) / 10;
}

/** Weigh-ins → one value per day in the project's unit, oldest first. */
function dailyWeights(weighIns, unit) {
	const toUnit = (kg) => (unit === "kg" ? kg : kg / KG_PER_LB);
	const byDay = new Map();
	for (const w of weighIns) {
		const d = String(w.at).slice(0, 10);
		if (!byDay.has(d)) byDay.set(d, Math.round(toUnit(w.weight_kg) * 10) / 10); // newest first in, so first wins
	}
	return [...byDay].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Where a weight project stands. `series` is daily values in its unit.
 * `actual` is the mean of the last seven days that have a weigh-in.
 */
function weightProgress(project, series, today = new Date().toISOString().slice(0, 10)) {
	const unit = project.metric_unit === "kg" ? "kg" : "lb";
	const startsOn = day(project.starts_on);
	const endsOn = day(project.ends_on);
	const inRange = startsOn ? series.filter((p) => p.date >= startsOn) : series;
	const firstValue = inRange[0]?.value ?? null;
	const start = project.metric_start !== null && project.metric_start !== undefined ? Number(project.metric_start) : firstValue;
	const target = project.metric_target !== null && project.metric_target !== undefined ? Number(project.metric_target) : null;
	const cutoff = new Date(Date.parse(today) - 7 * DAY).toISOString().slice(0, 10);
	const lastWeek = series.filter((p) => p.date > cutoff);
	const actual = lastWeek.length ? Math.round((lastWeek.reduce((s, p) => s + p.value, 0) / lastWeek.length) * 10) / 10 : null;
	const plan = planned({ start, target, startsOn, endsOn }, today);
	const gap = actual !== null && plan !== null ? Math.round((actual - plan) * 10) / 10 : null;
	const rising = target !== null && start !== null ? target >= start : true;
	// Within a pound (or half a kilo) of the line is on track.
	const slack = unit === "kg" ? 0.5 : 1;
	const verdict = gap === null ? null : Math.abs(gap) <= slack ? "on_track" : (gap > 0) === rising ? "ahead" : "behind";
	return {
		unit, start, target, startsOn, endsOn, actual, planned: plan, gap, verdict,
		latest: series.length ? series[series.length - 1] : null,
		change: actual !== null && start !== null ? Math.round((actual - start) * 10) / 10 : null,
		series: inRange.slice(-120),
	};
}

function weekKey(date) {
	const d = new Date(`${date}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
	return d.toISOString().slice(0, 10);
}

function workoutProgress(workouts, sports, sinceDate) {
	const want = sports.map((s) => s.toLowerCase());
	const mine = workouts.filter((w) => want.some((s) => String(w.sport || "").toLowerCase().includes(s)));
	const weeks = new Map();
	for (const w of mine) weeks.set(weekKey(w.date), (weeks.get(weekKey(w.date)) || 0) + 1);
	const thisWeek = weekKey(new Date().toISOString().slice(0, 10));
	const lastEight = [];
	for (let i = 7; i >= 0; i--) {
		const d = new Date(`${thisWeek}T12:00:00Z`);
		d.setUTCDate(d.getUTCDate() - 7 * i);
		const k = d.toISOString().slice(0, 10);
		lastEight.push({ week: k, count: weeks.get(k) || 0 });
	}
	const bySport = {};
	for (const w of mine) bySport[w.sport] = (bySport[w.sport] || 0) + 1;
	return {
		sports, since: sinceDate, total: mine.length, bySport,
		thisWeek: weeks.get(thisWeek) || 0,
		weekly: lastEight,
		last: mine[0] ? { date: mine[0].date, sport: mine[0].sport, minutes: mine[0].minutes, strain: mine[0].strain } : null,
	};
}

function calendarMatches(events, titleAny) {
	const want = titleAny.map((w) => w.toLowerCase());
	return events
		.filter((e) => want.some((w) => String(e.title || e.summary || "").toLowerCase().includes(w)))
		.slice(0, 12)
		.map((e) => ({ title: e.title || e.summary || "", start: e.start, end: e.end, allDay: !!e.allDay, location: e.location || null }));
}

/**
 * Live data for every confirmed binding on one project. Each source fails on
 * its own and says why; one being down never blanks the others.
 */
async function read(profileId, projectUuid, { skip = [] } = {}) {
	const project = await projectRow(profileId, projectUuid);
	if (!project) throw notFound("project");
	const [rows] = await pool.query("SELECT * FROM athena_project_binding WHERE project_id = ? AND status = 'confirmed' ORDER BY id", [project.id]);
	const startsOn = day(project.starts_on);
	const lookbackDays = startsOn ? Math.min(365, Math.max(14, Math.ceil((Date.now() - Date.parse(startsOn)) / DAY) + 1)) : 90;
	const out = [];
	for (const row of rows) {
		const b = toBinding(row);
		if (skip.includes(b.sourceType)) continue;
		try {
			if (b.sourceType === "health_metric") {
				const weighIns = await require("../connectors/vesync").listWeighIns(profileId, { days: lookbackDays });
				out.push({ ...b, data: weightProgress(project, dailyWeights(weighIns, project.metric_unit)) });
			} else if (b.sourceType === "whoop_sport") {
				const workouts = await require("../workoutHistory").list(profileId, { days: Math.max(lookbackDays, 56), limit: 2000 });
				out.push({ ...b, data: workoutProgress(workouts, b.selector.sports || [], startsOn) });
			} else if (b.sourceType === "calendar_match") {
				const { events } = await require("../connectors/googleCalendar").collectEvents(profileId, { days: 60, maxResults: 200, cap: 200 });
				out.push({ ...b, data: { upcoming: calendarMatches(events, b.selector.titleAny || []) } });
			} else {
				out.push({ ...b, data: null, error: "Unknown source" });
			}
		} catch (err) {
			const code = err?.code || null;
			out.push({
				...b, data: null, errorCode: code,
				error: code === "consent_required" ? "Health data sharing hasn't been agreed to."
					: code === "not_connected" || /not connected|not linked/i.test(err?.message || "") ? "That source isn't connected."
						: "Couldn't read it right now.",
			});
		}
	}
	return out;
}

/** The distinct sports they've recorded in the last year, for the picker. */
async function options(profileId) {
	const [rows] = await pool.query(
		`SELECT sport_name, COUNT(*) AS n FROM athena_workout
		 WHERE profile_id = ? AND deleted_at IS NULL AND started_at >= ? GROUP BY sport_name ORDER BY n DESC LIMIT 40`,
		[profileId, new Date(Date.now() - 365 * DAY)]
	).catch(() => [[]]);
	return { sports: rows.map((r) => ({ sport: r.sport_name, count: Number(r.n) })), metrics: METRICS };
}

module.exports = {
	SOURCE_TYPES, METRICS,
	normalizeSelector, forProjects, add, remove, read, options,
	planned, dailyWeights, weightProgress, workoutProgress, calendarMatches, weekKey,
};
