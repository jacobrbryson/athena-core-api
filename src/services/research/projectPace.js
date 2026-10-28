const pool = require("../../helpers/db");

/**
 * Project pace (docs/capabilities/research.md).
 *
 * How fast the person's own projects actually move: steps finished per week
 * and, per active project, the date it would finish at its own recent pace.
 * Reads athena_project_step.completed_at and athena_project_work_session; no
 * model, no new table. Projects involving children are left out.
 *
 * A pace is a description of the last eight weeks, not a promise: the date is
 * "at this pace", and a project needs three finished steps of its own in the
 * window before it gets one.
 */

const WINDOW_DAYS = 56;
const MIN_STEPS = 8;
const MIN_PROJECT_STEPS = 3;
const STALL_DAYS = 14;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

const round = (v, d = 0) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * `projects`: active projects with `doneInWindow` and `open` step counts and
 * `lastProgressAt`; `doneSteps`: completion times of every finished step in
 * the window; `sessions`: completed work sessions in the window.
 */
function summarize({ projects, doneSteps, sessions }, now = new Date()) {
	if (doneSteps.length < MIN_STEPS) return { status: "gathering", have: doneSteps.length, needed: MIN_STEPS };
	const weeks = WINDOW_DAYS / 7;
	const perWeek = doneSteps.length / weeks;
	const weekly = [];
	for (let w = 0; w < weeks; w += 1) {
		const from = now.getTime() - (weeks - w) * WEEK_MS;
		const to = from + WEEK_MS;
		weekly.push({
			weekOf: dayOf(from),
			steps: doneSteps.filter((t) => new Date(t).getTime() >= from && new Date(t).getTime() < to).length,
		});
	}
	const sessionMinutes = sessions.reduce((a, s) => a + (s.minutes || 0), 0);
	const rows = projects
		.map((p) => {
			const idleDays = p.lastProgressAt ? Math.floor((now.getTime() - new Date(p.lastProgressAt).getTime()) / DAY_MS) : null;
			const stalled = idleDays !== null && idleDays >= STALL_DAYS && p.open > 0;
			let finishOn = null;
			if (p.open === 0) finishOn = null;
			else if (p.doneInWindow >= MIN_PROJECT_STEPS) {
				const projectPerWeek = p.doneInWindow / weeks;
				finishOn = dayOf(now.getTime() + (p.open / projectPerWeek) * WEEK_MS);
			}
			return { uuid: p.uuid, title: p.title, open: p.open, doneInWindow: p.doneInWindow, idleDays, stalled, finishOn };
		})
		.sort((a, b) => (b.stalled - a.stalled) || (a.finishOn || "9999").localeCompare(b.finishOn || "9999"));
	return {
		status: "ready",
		have: doneSteps.length,
		needed: MIN_STEPS,
		perWeek: round(perWeek, 1),
		weekly,
		sessions: { count: sessions.length, hours: round(sessionMinutes / 60, 1) },
		projects: rows,
		confidence: doneSteps.length >= 24 ? "moderate" : "low",
	};
}

function sentence(r) {
	if (r.status === "gathering") {
		return `I have ${r.have} of the ${r.needed} finished steps I need from the last eight weeks before I can describe your pace.`;
	}
	const stalled = r.projects.filter((p) => p.stalled);
	const dated = r.projects.find((p) => p.finishOn);
	let s = `Over the last eight weeks you finished about ${r.perWeek} steps a week across your projects`;
	if (r.sessions.count) s += `, with ${r.sessions.count} work session${r.sessions.count === 1 ? "" : "s"} (${r.sessions.hours} hours)`;
	s += ".";
	if (dated) s += ` At its own pace, "${dated.title}" would finish around ${dated.finishOn}.`;
	if (stalled.length) s += ` ${stalled.length} active project${stalled.length === 1 ? " has" : "s have"} had no progress in ${STALL_DAYS}+ days.`;
	return `${s} A description of your recent weeks, not a promise.`;
}

async function load(profileId, now) {
	const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
	const [steps] = await pool.query(
		`SELECT s.completed_at FROM athena_project_step s
		 JOIN athena_project p ON p.id = s.project_id
		 WHERE p.profile_id = ? AND p.involves_children = 0 AND s.status = 'done' AND s.completed_at >= ?`,
		[profileId, since]
	);
	const [projects] = await pool.query(
		`SELECT p.uuid, p.title, p.last_progress_at,
			SUM(s.status IN ('todo','in_progress','blocked')) AS open_steps,
			SUM(s.status = 'done' AND s.completed_at >= ?) AS done_in_window
		 FROM athena_project p LEFT JOIN athena_project_step s ON s.project_id = p.id
		 WHERE p.profile_id = ? AND p.involves_children = 0 AND p.status = 'active'
		 GROUP BY p.id`,
		[since, profileId]
	);
	const [sessions] = await pool.query(
		`SELECT w.actual_duration_minutes AS minutes FROM athena_project_work_session w
		 JOIN athena_project p ON p.id = w.project_id
		 WHERE w.profile_id = ? AND p.involves_children = 0 AND w.status = 'completed' AND w.completed_at >= ?`,
		[profileId, since]
	);
	return {
		doneSteps: steps.map((r) => r.completed_at),
		sessions,
		projects: projects.map((p) => ({
			uuid: p.uuid,
			title: p.title,
			lastProgressAt: p.last_progress_at,
			open: Number(p.open_steps) || 0,
			doneInWindow: Number(p.done_in_window) || 0,
		})),
	};
}

async function analyze(profileId, { now = new Date() } = {}) {
	const summary = summarize(await load(profileId, now), now);
	return { ...summary, sentence: sentence(summary), checkedAt: now.toISOString() };
}

module.exports = { analyze, summarize, sentence, MIN_STEPS };
