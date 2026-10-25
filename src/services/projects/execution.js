/**
 * The execution engine: what can actually be done next on a project, what is
 * holding it up and when to look at that again, when the work is scheduled,
 * and what finished means. See docs/architecture/projects.md, "Execution".
 *
 * Pure and deterministic, like rank.js: everything here is derived from the
 * graph getAll() returns, at a given `now`, and nothing is stored. The app,
 * Right Now and the chat prompt all read this one module, so the three can
 * never disagree about whether a step is ready.
 *
 * Rules worth knowing before changing anything:
 *
 *   - Order is display order. Only an explicit dependency makes one step wait
 *     for another; nothing here infers one from position.
 *   - A skipped prerequisite holds nothing up, the same rule as a dropped
 *     project dependency (shape.effectiveStatus).
 *   - Unknown effort, place or weather never excludes a step. It only means
 *     the step cannot claim to fit.
 *   - A review date coming due makes a follow-up. It never resolves a blocker.
 *   - Completing every step is not finishing the project. Only the person
 *     confirms an outcome; the closeout summary is what they confirm against.
 *   - The work-in-progress preference orders suggestions. It never pauses,
 *     drops or hides a project.
 */
const { CLOSED, criteriaOf } = require("./shape");
const { rank } = require("./rank");

const MINUTE = 60_000;
const DAY = 86_400_000;
const OPEN_STEP = new Set(["todo", "in_progress", "blocked"]);
const SETTLED_STEP = new Set(["done", "skipped"]);
const OPEN_SESSION = new Set(["planned", "in_progress"]);
// "Idea" is open but nobody has committed to it; its steps are still offered,
// marked as starting something new, so the work-in-progress preference can weigh them.
const WORKABLE_PROJECT = new Set(["idea", "planning", "ready", "active"]);
const DEFAULT_PREFS = { focusLimit: 3, preferFinishing: true };
/** With effort unknown, a first session is an hour: enough to start, small enough to find. */
const DEFAULT_SESSION_MINUTES = 60;
const MIN_SESSION_MINUTES = 30;

const time = (v) => (v ? Date.parse(v) : NaN);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const daysUntilDate = (date, now) => {
	if (!date) return null;
	const t = Date.parse(`${date}T23:59:59Z`);
	return Number.isFinite(t) ? Math.floor((t - now) / DAY) : null;
};
const minutesLabel = (m) => (m < 90 ? `${m} min` : `${Math.round(m / 30) / 2} h`);

function stepsByUuid(project) {
	return new Map((project.steps || []).map((s) => [s.uuid, s]));
}

/** The step's indoor flag, falling back to the project's. Never a guess. */
function indoorOf(step, project) {
	if (step.indoor !== null && step.indoor !== undefined) return step.indoor;
	return project.indoor ?? null;
}

// --- Blockers ---------------------------------------------------------------

/**
 * Everything standing between a step and someone doing it, each with what to
 * do about it. Empty means nothing does. `needs` is the titles of unfinished
 * projects this one depends on (project-level links), when the caller has them.
 */
function getStepBlockers(project, stepUuid, { needs = [] } = {}) {
	const step = stepsByUuid(project).get(stepUuid);
	if (!step || !OPEN_STEP.has(step.status)) return [];
	const out = [];
	if (CLOSED.has(project.status)) {
		out.push({ kind: "project", text: `The project is ${project.status}.`, action: "Reopen the project to work on it." });
	} else if (project.effectiveStatus === "waiting") {
		out.push({
			kind: "project",
			text: `The project is on hold${project.waitingOn ? `, waiting on ${project.waitingOn}` : ""}.`,
			action: project.waitingOn ? `Check whether ${project.waitingOn} has come through, then start it again.` : "Say what it's waiting on, or start it again.",
		});
	} else if (project.effectiveStatus === "blocked") {
		out.push({
			kind: "project",
			text: needs.length ? `The project needs ${needs.slice(0, 2).map((t) => `"${t}"`).join(" and ")} finished first.` : "The project is marked blocked.",
			action: needs.length ? `Work on "${needs[0]}" first.` : "Say what's blocking the project, or unblock it.",
		});
	}
	const byUuid = stepsByUuid(project);
	for (const dep of step.dependsOn || []) {
		const pre = byUuid.get(dep);
		if (pre && !SETTLED_STEP.has(pre.status)) {
			out.push({ kind: "prerequisite", stepUuid: pre.uuid, text: `Needs "${pre.title}" first.`, action: `Do "${pre.title}" first.` });
		}
	}
	if (step.status === "blocked") {
		out.push({
			kind: step.waitingOnActor ? "waiting" : "blocked",
			text: [
				step.blockedOn ? `Blocked: ${step.blockedOn}` : "Marked blocked",
				step.waitingOnActor ? ` — waiting on ${step.waitingOnActor}` : "",
				".",
			].join(""),
			action: unblockActionOf(step),
			reviewAt: step.reviewAt || null,
		});
	}
	return out;
}

/** What would clear a blocked step, in words: theirs if they said, otherwise built from what is known. */
function unblockActionOf(step) {
	if (step.unblockAction) return step.unblockAction;
	const what = step.blockedOn || `"${step.title}"`;
	if (step.waitingOnActor) return `Check with ${step.waitingOnActor} about ${what}.`;
	if (step.blockedOn) return `Sort out ${step.blockedOn}.`;
	return `Find out what's holding up "${step.title}".`;
}

// --- What can be done -------------------------------------------------------

/**
 * Steps someone could start now: open and not blocked, every explicit
 * prerequisite done (or skipped), on a project that is open and not held up.
 * In progress first, then the nearest due date, then display order.
 */
function getExecutableSteps(project, now = Date.now(), opts = {}) {
	if (!WORKABLE_PROJECT.has(project.effectiveStatus)) return [];
	return (project.steps || [])
		.filter((s) => (s.status === "todo" || s.status === "in_progress") && !getStepBlockers(project, s.uuid, opts).length)
		.sort((a, b) =>
			(b.status === "in_progress") - (a.status === "in_progress")
			|| (daysUntilDate(a.dueOn, now) ?? 1e6) - (daysUntilDate(b.dueOn, now) ?? 1e6)
			|| a.ordinal - b.ordinal);
}

/**
 * The single most useful step to do next, and why, or null.
 *
 * context: { now, freeMinutes, wet, rankScore, rankWhy }. Anything missing
 * just stops counting — an unknown window cannot rule a step out, and unknown
 * effort cannot claim to fit.
 */
function getNextAction(project, context = {}) {
	const now = context.now ?? Date.now();
	const ready = getExecutableSteps(project, now, context);
	if (!ready.length) return null;
	const prereqCount = (s) => (s.dependsOn || []).length;
	const scored = ready.map((step) => {
		let score = 0;
		const why = [];
		if (step.status === "in_progress") { score += 20; why.push("already under way"); }
		const due = daysUntilDate(step.dueOn, now);
		if (due !== null) {
			if (due < 0) { score += 25; why.push(`${plural(-due, "day")} overdue`); }
			else if (due <= 3) { score += 15; why.push(due === 0 ? "due today" : `due in ${plural(due, "day")}`); }
			else if (due <= 7) { score += 8; why.push(`due in ${due} days`); }
		}
		const effort = step.effortMinutes ?? null;
		const free = context.freeMinutes ?? null;
		let fitsWindow = null;
		let needsMultipleSessions = false;
		if (effort !== null && free !== null) {
			fitsWindow = effort <= free;
			if (fitsWindow) { score += 10; why.push(`fits the ${minutesLabel(free)} you have`); }
			else { score -= 10; needsMultipleSessions = true; why.push(`about ${minutesLabel(effort)}, more than one sitting`); }
		}
		const indoor = indoorOf(step, project);
		if (context.wet) {
			if (indoor === true) { score += 10; why.push("indoors, and it's wet out"); }
			if (indoor === false) { score -= 20; why.push("outdoor work on a wet day"); }
		}
		if (step.who === "someone") { score -= 15; why.push("someone else does it — this is arranging it"); }
		if (step.who === "athena") score -= 5;
		// Display order breaks ties, so a plan with no dependencies reads top to bottom.
		score -= step.ordinal * 0.01;
		return { step, score, why, fitsWindow, needsMultipleSessions, effort, indoor };
	}).sort((a, b) => b.score - a.score);
	const best = scored[0];
	const s = best.step;
	const reasons = [
		prereqCount(s)
			? `everything it needs is done (${(s.dependsOn || []).map((u) => stepsByUuid(project).get(u)?.title).filter(Boolean).slice(0, 2).map((t) => `"${t}"`).join(", ")})`
			: "nothing has to happen first",
		...best.why,
		...(context.rankWhy || []).slice(0, 1),
	];
	return {
		projectUuid: project.uuid,
		projectTitle: project.title,
		stepUuid: s.uuid,
		title: s.title,
		detail: s.detail,
		phase: s.phase || null,
		acceptanceCriteria: s.acceptanceCriteria || null,
		status: s.status,
		who: s.who,
		effortMinutes: best.effort,
		indoor: best.indoor,
		conditions: project.conditions || [],
		dueOn: s.dueOn,
		fitsWindow: best.fitsWindow,
		needsMultipleSessions: best.needsMultipleSessions,
		startsNew: project.effectiveStatus !== "active",
		score: Math.round(((context.rankScore ?? 0) + best.score) * 100) / 100,
		reasons,
	};
}

// --- Blocker follow-through -------------------------------------------------

/** A follow-up's identity: one per blocked step per review date, so asking twice is the same follow-up. */
const followUpKey = (step) => `${step.uuid}@${step.reviewAt || "untriaged"}`;

function followUp(project, step, now) {
	const due = !!step.reviewAt && time(step.reviewAt) <= now;
	return {
		key: followUpKey(step),
		projectUuid: project.uuid,
		projectTitle: project.title,
		stepUuid: step.uuid,
		stepTitle: step.title,
		blockedOn: step.blockedOn || null,
		waitingOn: step.waitingOnActor || null,
		reviewAt: step.reviewAt || null,
		due,
		triage: !step.reviewAt,
		overdueDays: due ? Math.floor((now - time(step.reviewAt)) / DAY) : 0,
		action: unblockActionOf(step),
	};
}

const blockedSteps = (project) => (CLOSED.has(project.status) ? [] : (project.steps || []).filter((s) => s.status === "blocked"));

/** Blocked steps whose review date has come, plus those with none at all (they need a day to check back). */
function getBlockedStepsNeedingReview(project, now = Date.now()) {
	return blockedSteps(project).map((s) => followUp(project, s, now)).filter((f) => f.due || f.triage);
}

/** Only the ones whose review date has passed, oldest first. */
function getOverdueFollowUps(project, now = Date.now()) {
	return blockedSteps(project)
		.map((s) => followUp(project, s, now))
		.filter((f) => f.due)
		.sort((a, b) => time(a.reviewAt) - time(b.reviewAt));
}

/** For every blocked step, what would clear it; due ones first. */
function getUnblockActions(project, now = Date.now()) {
	return blockedSteps(project)
		.map((s) => followUp(project, s, now))
		.sort((a, b) => (b.due - a.due) || (a.triage - b.triage) || (time(a.reviewAt) || 0) - (time(b.reviewAt) || 0));
}

/**
 * Follow-ups not yet raised: the dedupe over getOverdueFollowUps for anything
 * that tells the person about them. `seen` is the keys already raised. A
 * follow-up comes back only when its review date moves (a new key) — never
 * twice for the same date.
 */
function newFollowUps(project, seen = new Set(), now = Date.now()) {
	return getOverdueFollowUps(project, now).filter((f) => !seen.has(f.key));
}

// --- Completion -------------------------------------------------------------

/** What is still unconfirmed: the project's "done when" lines, and criteria on steps not yet done. */
function getIncompleteAcceptanceCriteria(project) {
	const confirmed = new Set(project.doneWhenConfirmed || []);
	const out = criteriaOf(project.doneWhen)
		.filter((c) => !confirmed.has(c))
		.map((text) => ({ source: "project", text }));
	for (const s of project.steps || []) {
		if (!OPEN_STEP.has(s.status)) continue;
		for (const text of criteriaOf(s.acceptanceCriteria)) out.push({ source: "step", stepUuid: s.uuid, stepTitle: s.title, text });
	}
	return out;
}

/**
 * Where the project stands against finishing:
 *   work_remaining           steps are still open (or there is nothing to judge by yet)
 *   outcome_unverified       every step is done, but some "done when" criteria aren't confirmed
 *   ready_for_confirmation   everything done and confirmed; waiting for them to close it out
 *   verified_complete        closed with the outcome confirmed
 *   complete                 closed the old way, with no criteria to confirm
 *   dropped
 */
function getCompletionReadiness(project) {
	const steps = (project.steps || []).filter((s) => s.status !== "skipped");
	const open = steps.filter((s) => OPEN_STEP.has(s.status));
	const criteria = criteriaOf(project.doneWhen);
	const confirmed = new Set(project.doneWhenConfirmed || []);
	const confirmedCount = criteria.filter((c) => confirmed.has(c)).length;
	const base = {
		openSteps: open.length,
		stepsDone: steps.length - open.length,
		stepsTotal: steps.length,
		criteria: { total: criteria.length, confirmed: confirmedCount },
		hasCriteria: criteria.length > 0,
	};
	if (project.status === "dropped") return { ...base, state: "dropped", message: "Dropped." };
	if (project.status === "done") {
		return project.outcomeConfirmedAt
			? { ...base, state: "verified_complete", message: "Finished, and you confirmed the outcome." }
			: { ...base, state: "complete", message: "Marked done." };
	}
	if (open.length || (!steps.length && !criteria.length)) {
		return {
			...base,
			state: "work_remaining",
			message: open.length ? `${plural(open.length, "step")} to go.` : "No steps yet — mark it done when it's finished, or add the steps.",
			suggestCriteria: !criteria.length && steps.length >= 3,
		};
	}
	if (confirmedCount < criteria.length) {
		return {
			...base,
			state: "outcome_unverified",
			message: steps.length
				? `Every step is done; ${plural(criteria.length - confirmedCount, "check")} of the outcome still to confirm.`
				: `${plural(criteria.length - confirmedCount, "check")} of the outcome still to confirm.`,
		};
	}
	return {
		...base,
		state: "ready_for_confirmation",
		message: criteria.length ? "Everything's done and checked — ready for you to close it out." : "Every step is done. Is it finished? You can add what done looks like first.",
		suggestCriteria: !criteria.length,
	};
}

/** The closeout checklist the person confirms against. Never confirms anything itself. */
function getProjectCloseoutSummary(project) {
	const readiness = getCompletionReadiness(project);
	const confirmed = new Set(project.doneWhenConfirmed || []);
	const sessions = (project.sessions || []).filter((s) => s.status === "completed");
	return {
		projectUuid: project.uuid,
		title: project.title,
		readiness: readiness.state,
		criteria: criteriaOf(project.doneWhen).map((text) => ({ text, confirmed: confirmed.has(text) })),
		openSteps: (project.steps || []).filter((s) => OPEN_STEP.has(s.status)).map((s) => s.title),
		stepsDone: (project.steps || []).filter((s) => s.status === "done").length,
		stepsSkipped: (project.steps || []).filter((s) => s.status === "skipped").length,
		toVerify: (project.items || []).filter((i) => i.status === "pending").map((i) => i.label),
		sessionsCompleted: sessions.length,
		minutesWorked: sessions.reduce((t, s) => t + (s.actualMinutes ?? s.plannedMinutes ?? 0), 0),
		// The owner confirms. A model may present this; it may never tick it.
		needsOwnerConfirmation: true,
		canClose: readiness.state === "ready_for_confirmation" || readiness.state === "outcome_unverified",
	};
}

// --- Work sessions ----------------------------------------------------------

const sessionEnd = (s) => time(s.plannedStart) + (s.plannedMinutes || 0) * MINUTE;

/** Planned sessions still ahead (or under way), soonest first. */
function upcomingSessions(project, now = Date.now()) {
	return (project.sessions || [])
		.filter((s) => OPEN_SESSION.has(s.status) && sessionEnd(s) >= now)
		.sort((a, b) => time(a.plannedStart) - time(b.plannedStart));
}

/** Sessions whose time has passed with no word on how they went — ask, don't assume. */
function sessionsToCheckIn(project, now = Date.now()) {
	return (project.sessions || [])
		.filter((s) => OPEN_SESSION.has(s.status) && sessionEnd(s) < now)
		.sort((a, b) => time(a.plannedStart) - time(b.plannedStart));
}

/** Upcoming sessions across every project in the graph (what getUpcomingWorkSessions reads). */
function upcomingAcross(graph, now = Date.now()) {
	return (graph.projects || [])
		.flatMap((p) => upcomingSessions(p, now).map((s) => ({ ...s, projectUuid: p.uuid, projectTitle: p.title, stepTitle: stepsByUuid(p).get(s.stepUuid)?.title || null })))
		.sort((a, b) => time(a.plannedStart) - time(b.plannedStart));
}

/** Executable steps with no upcoming session set aside for them. */
function getUnscheduledExecutableSteps(project, now = Date.now(), opts = {}) {
	const booked = new Set(upcomingSessions(project, now).map((s) => s.stepUuid).filter(Boolean));
	return getExecutableSteps(project, now, opts).filter((s) => !booked.has(s.uuid));
}

/**
 * A realistic block for a step. availability: { windows: [{ start, end }] }
 * (free time, ISO), optionally `now`. Returns the first window that holds the
 * step's effort, else the first that holds a useful part of it (marked as one
 * of several sessions), else a manual suggestion with no time.
 */
function suggestWorkSession(step, availability = {}) {
	const minutes = step.effortMinutes || DEFAULT_SESSION_MINUTES;
	const now = availability.now ?? Date.now();
	const windows = (availability.windows || [])
		.map((w) => ({ start: Math.max(time(w.start), now), end: time(w.end) }))
		.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
		.sort((a, b) => a.start - b.start);
	const length = (w) => Math.floor((w.end - w.start) / MINUTE);
	// Start on a quarter hour so a suggestion reads like something a person would book.
	const round = (t) => Math.ceil(t / (15 * MINUTE)) * 15 * MINUTE;
	const whole = windows.find((w) => length({ ...w, start: round(w.start) }) >= minutes);
	if (whole) {
		return { stepUuid: step.uuid, plannedStart: new Date(round(whole.start)).toISOString(), plannedMinutes: minutes, fitsInOne: true, effortKnown: step.effortMinutes != null, reason: "first free time that holds it" };
	}
	const part = windows.find((w) => length({ ...w, start: round(w.start) }) >= MIN_SESSION_MINUTES);
	if (part) {
		const fits = length({ ...part, start: round(part.start) });
		return { stepUuid: step.uuid, plannedStart: new Date(round(part.start)).toISOString(), plannedMinutes: fits, fitsInOne: false, effortKnown: step.effortMinutes != null, reason: `the first free stretch is ${minutesLabel(fits)} — one of a few sessions` };
	}
	return { stepUuid: step.uuid, plannedStart: null, plannedMinutes: minutes, fitsInOne: null, effortKnown: step.effortMinutes != null, reason: windows.length ? "no free stretch long enough" : "no calendar to check — pick a time" };
}

/**
 * What to have ready before a session: the work, the materials, what to
 * verify, anything still in the way, and the weather it needs. `forecast` is
 * optional ({ outlook, summary }); without it the conditions are still named.
 */
function getSessionPreparation(session, project, { forecast = null, needs = [] } = {}) {
	const step = session.stepUuid ? stepsByUuid(project).get(session.stepUuid) : null;
	const indoor = step ? indoorOf(step, project) : project.indoor ?? null;
	const conditions = project.conditions || [];
	return {
		sessionUuid: session.uuid,
		plannedStart: session.plannedStart,
		plannedMinutes: session.plannedMinutes,
		work: step
			? { stepUuid: step.uuid, title: step.title, detail: step.detail, acceptanceCriteria: criteriaOf(step.acceptanceCriteria) }
			: { stepUuid: null, title: project.title, detail: null, acceptanceCriteria: [] },
		materials: (project.items || []).filter((i) => i.kind === "material")
			.map((i) => ({ label: i.label, value: [i.value, i.unit].filter(Boolean).join(" ") || null, status: i.status })),
		toVerify: (project.items || []).filter((i) => i.kind === "spec" && i.status === "pending").map((i) => i.label),
		blockers: step ? getStepBlockers(project, step.uuid, { needs }) : [],
		weather: {
			outdoor: indoor === false ? true : indoor === true ? false : null,
			needs: conditions,
			forecast: forecast ? { outlook: forecast.outlook ?? null, summary: forecast.summary ?? null } : null,
			warning: forecast?.outlook === "wet" && indoor !== true ? "Rain is forecast — check before you start outdoor work." : null,
		},
	};
}

// --- Phases -------------------------------------------------------------------

/**
 * The plan grouped by its steps' phase labels, in the order each phase first
 * appears. Each has done/total (skipped steps don't count) and a date range
 * from its steps' due dates and planned sessions, when there are any. Steps
 * without a label are grouped last as phase null. Empty when no step has a
 * phase. A phase is a label only: it never decides what's ready.
 */
function getPhases(project) {
	const steps = [...(project.steps || [])].sort((a, b) => a.ordinal - b.ordinal);
	if (!steps.some((s) => s.phase)) return [];
	const groups = new Map();
	for (const s of steps) {
		const key = s.phase || null;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(s);
	}
	const sessionDays = (uuid) => (project.sessions || [])
		.filter((w) => w.stepUuid === uuid && w.status !== "cancelled")
		.map((w) => String(w.plannedStart).slice(0, 10));
	const out = [...groups.entries()].map(([name, list]) => {
		const counted = list.filter((s) => s.status !== "skipped");
		const days = list.flatMap((s) => [s.dueOn, ...sessionDays(s.uuid)]).filter(Boolean).sort();
		return {
			name,
			stepUuids: list.map((s) => s.uuid),
			done: counted.filter((s) => s.status === "done").length,
			total: counted.length,
			blocked: list.filter((s) => s.status === "blocked").length,
			from: days[0] || null,
			to: days[days.length - 1] || null,
		};
	});
	// Unlabelled steps go last, whatever their position.
	return [...out.filter((g) => g.name !== null), ...out.filter((g) => g.name === null)];
}

// --- Per project and across the graph ---------------------------------------

/** Unfinished projects this one depends on, by title. */
function needsOf(graph, project) {
	const byId = new Map((graph.projects || []).map((p) => [p.uuid, p]));
	return (graph.links || [])
		.filter((l) => l.relation === "depends_on" && l.from === project.uuid)
		.map((l) => byId.get(l.to))
		.filter((d) => d && !CLOSED.has(d.status))
		.map((d) => d.title);
}

/**
 * The compact derived state of one project: what is ready, what is next and
 * why, what is held up and when to look again, the sessions, and how close
 * it is to finished. When nothing is ready, `noActionReason` and `unblock`
 * say why and what would change that — a project is never just quietly absent.
 */
function getProjectExecutionState(project, context = {}) {
	const now = context.now ?? Date.now();
	const opts = { needs: context.needs || [] };
	const executable = getExecutableSteps(project, now, opts);
	const next = getNextAction(project, { ...context, now });
	const completion = getCompletionReadiness(project);
	const blocked = getUnblockActions(project, now);
	const upcoming = upcomingSessions(project, now);
	const state = {
		projectUuid: project.uuid,
		title: project.title,
		effectiveStatus: project.effectiveStatus,
		completion,
		executableSteps: executable.map((s) => ({ uuid: s.uuid, title: s.title })),
		nextAction: next,
		blockedSteps: blocked,
		dueFollowUps: blocked.filter((f) => f.due),
		needsTriage: blocked.filter((f) => f.triage),
		upcomingSessions: upcoming,
		sessionsToCheckIn: sessionsToCheckIn(project, now),
		unscheduled: getUnscheduledExecutableSteps(project, now, opts).map((s) => ({ uuid: s.uuid, title: s.title, effortMinutes: s.effortMinutes ?? null })),
		phases: getPhases(project),
		lastProgressAt: project.lastProgressAt || null,
		daysSinceProgress: project.lastProgressAt ? Math.floor((now - time(project.lastProgressAt)) / DAY) : null,
		reasons: next ? next.reasons : [],
		noActionReason: null,
		unblock: null,
	};
	if (!next && !CLOSED.has(project.status)) Object.assign(state, whyNothing(project, { completion, blocked, needs: opts.needs }));
	return state;
}

function whyNothing(project, { completion, blocked, needs }) {
	if (project.effectiveStatus === "waiting") {
		return { noActionReason: `On hold${project.waitingOn ? `, waiting on ${project.waitingOn}` : ""}.`, unblock: project.waitingOn ? `Check on ${project.waitingOn}.` : "Say what it's waiting on." };
	}
	if (project.effectiveStatus === "blocked") {
		return needs.length
			? { noActionReason: `Needs "${needs[0]}" finished first.`, unblock: `Work on "${needs[0]}".` }
			: { noActionReason: "Marked blocked.", unblock: "Say what's blocking it." };
	}
	if (completion.state === "outcome_unverified" || completion.state === "ready_for_confirmation") {
		return { noActionReason: completion.message, unblock: "Go through the closeout checklist." };
	}
	if (!(project.steps || []).length) return { noActionReason: "No steps yet.", unblock: "Add the first step." };
	if (blocked.length) {
		const first = blocked[0];
		return { noActionReason: `Everything open is waiting — "${first.stepTitle}"${first.blockedOn ? ` on ${first.blockedOn}` : ""}.`, unblock: first.action };
	}
	// Open steps, none blocked, none ready: they are all waiting on prerequisites
	// that are themselves waiting. Name the first link in that chain.
	const open = (project.steps || []).filter((s) => OPEN_STEP.has(s.status));
	const first = open.find((s) => (s.dependsOn || []).length);
	return { noActionReason: first ? `"${first.title}" is waiting on steps before it.` : "Nothing is ready yet.", unblock: first ? getStepBlockers(project, first.uuid)[0]?.action || null : null };
}

/** Is this a reason to start something new even when the focus limit is reached? */
function urgent(project, rankWhy = [], now = Date.now()) {
	const days = daysUntilDate(project.hardDeadline, now);
	return project.priority >= 5
		|| (days !== null && days <= 14)
		|| (project.serves || []).includes("safety")
		|| rankWhy.includes("answers an open concern");
}

/**
 * Every open project's execution state, plus the work-in-progress preference
 * applied to the next actions, and the success counts. context: { now,
 * freeMinutes, wet, prefs }. Ranking is rank.js's, unchanged; pinned projects
 * keep their place on top.
 */
function getExecutionPlan(graph, context = {}) {
	const now = context.now ?? Date.now();
	const prefs = { ...DEFAULT_PREFS, ...(context.prefs || {}) };
	const ranks = context.ranks || rank(graph, now);
	const open = (graph.projects || []).filter((p) => !CLOSED.has(p.status));
	const active = open.filter((p) => p.effectiveStatus === "active");
	const overFocus = prefs.preferFinishing && active.length >= prefs.focusLimit;
	const states = open.map((p) => {
		const r = ranks.get(p.uuid) || { score: 0, why: [] };
		const s = getProjectExecutionState(p, { ...context, now, needs: needsOf(graph, p), rankScore: r.score, rankWhy: r.why });
		if (s.nextAction && s.nextAction.startsNew && prefs.preferFinishing) {
			// Finishing beats starting, unless it can't wait. Pins are the person
			// overruling the order, so they are left alone.
			if (p.pinnedAt || urgent(p, r.why, now)) {
				s.nextAction.urgentStart = true;
				s.nextAction.reasons.push("worth starting now even with other work open");
			} else {
				s.nextAction.score -= overFocus ? 40 : 10;
				if (overFocus) s.nextAction.reasons.push(`would be a new project on top of ${active.length} active`);
			}
		}
		return s;
	});
	const nextActions = states.map((s) => s.nextAction).filter(Boolean).sort((a, b) => b.score - a.score);
	return {
		states,
		nextActions,
		followUps: states.flatMap((s) => s.dueFollowUps),
		focus: { active: active.length, limit: prefs.focusLimit, preferFinishing: prefs.preferFinishing, over: overFocus },
		metrics: metrics(graph, states, now),
	};
}

/**
 * The success counts, computed on read (nothing stored): how much is moving,
 * what is stuck with no one looking, and how long finishing takes.
 */
function metrics(graph, states, now) {
	const projects = graph.projects || [];
	const active = states.filter((s) => s.effectiveStatus === "active");
	const sessions = projects.flatMap((p) => p.sessions || []).filter((s) => time(s.plannedStart) <= now && now - time(s.plannedStart) <= 30 * DAY);
	const verified = projects.filter((p) => p.status === "done" && p.outcomeConfirmedAt);
	const durations = verified
		.filter((p) => p.activatedAt)
		.map((p) => (time(p.outcomeConfirmedAt) - time(p.activatedAt)) / DAY)
		.filter((d) => Number.isFinite(d) && d >= 0)
		.sort((a, b) => a - b);
	const mid = Math.floor(durations.length / 2);
	const median = !durations.length ? null : durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2;
	const progressAges = active.map((s) => s.daysSinceProgress).filter((d) => d !== null);
	return {
		activeProjects: active.length,
		activeWithNextAction: active.filter((s) => s.nextAction).length,
		blockedWithoutFollowUp: states.filter((s) => s.needsTriage.length || (["waiting", "blocked"].includes(s.effectiveStatus) && !s.blockedSteps.some((b) => b.reviewAt))).length,
		maxDaysSinceProgress: progressAges.length ? Math.max(...progressAges) : null,
		sessionsLast30Days: {
			planned: sessions.filter((s) => s.status !== "cancelled").length,
			completed: sessions.filter((s) => s.status === "completed").length,
		},
		verifiedComplete: verified.length,
		medianDaysToVerified: median === null ? null : Math.round(median * 10) / 10,
	};
}

module.exports = {
	DEFAULT_PREFS,
	getStepBlockers, getExecutableSteps, getNextAction,
	getBlockedStepsNeedingReview, getOverdueFollowUps, getUnblockActions, newFollowUps, followUpKey,
	getCompletionReadiness, getIncompleteAcceptanceCriteria, getProjectCloseoutSummary,
	getPhases,
	upcomingSessions, upcomingAcross, sessionsToCheckIn, getUnscheduledExecutableSteps, suggestWorkSession, getSessionPreparation,
	getProjectExecutionState, getExecutionPlan, needsOf,
};
