/**
 * The order projects are shown in, and which of them Right Now may offer.
 *
 * Arithmetic only, so it can be read and argued with: priority, the severity of
 * open concerns a project answers, the charter's weights for what it serves,
 * and deadline pressure — unless the person moved a project to the front. A
 * model may write words about a project; it never decides where it sits.
 */
const { CLOSED } = require("./shape");

const DAY = 86_400_000;

function daysUntil(date, now) {
	if (!date) return null;
	const t = Date.parse(`${date}T23:59:59Z`);
	return Number.isFinite(t) ? Math.floor((t - now) / DAY) : null;
}

/**
 * One number per open project; closed projects get null. Returns a Map of
 * uuid → { score, why[] } so the app can say why something is near the top.
 */
function rank({ projects = [], concerns = [], charters = [] }, now = Date.now()) {
	const weightsByArea = new Map(charters.map((c) => [c.area, c.weights || {}]));
	const severityBy = new Map();
	for (const c of concerns) {
		if (c.status === "resolved") continue;
		for (const uuid of c.projects || []) severityBy.set(uuid, Math.max(severityBy.get(uuid) || 0, c.severity));
	}
	const out = new Map();
	for (const p of projects) {
		if (CLOSED.has(p.status)) {
			out.set(p.uuid, { score: null, why: [] });
			continue;
		}
		const why = [];
		let score = p.priority * 10;
		const severity = severityBy.get(p.uuid) || 0;
		if (severity) {
			score += severity * 6;
			if (severity >= 4) why.push("answers an open concern");
		}
		const weights = weightsByArea.get(p.primaryArea) || {};
		const served = (p.serves || []).map((s) => Number(weights[s])).filter(Number.isFinite);
		if (served.length) score += Math.round((served.reduce((a, b) => a + b, 0) / served.length) * 2);
		const days = daysUntil(p.hardDeadline, now);
		if (days !== null) {
			if (days < 0) { score += 30; why.push("past its deadline"); }
			else if (days <= 14) { score += 20; why.push(`deadline in ${days} day${days === 1 ? "" : "s"}`); }
			else if (days <= 45) { score += 10; why.push(`deadline in ${days} days`); }
		}
		if (p.effectiveStatus === "active") score += 5;
		if (p.effectiveStatus === "blocked" || p.effectiveStatus === "waiting") score -= 15;
		out.set(p.uuid, { score, why });
	}
	// "Move to the front" is the person overruling the arithmetic: every pinned
	// open project sits above every unpinned one, the newest pin first.
	const pinned = projects
		.filter((p) => p.pinnedAt && !CLOSED.has(p.status))
		.sort((a, b) => Date.parse(b.pinnedAt) - Date.parse(a.pinnedAt));
	pinned.forEach((p, i) => {
		const r = out.get(p.uuid);
		out.set(p.uuid, { score: PINNED + (pinned.length - i), why: ["you moved it to the front", ...r.why] });
	});
	return out;
}

const PINNED = 100_000;

const OUTDOOR_CONDITIONS = new Set(["dry", "warm", "mild", "no_freeze", "daylight"]);

/**
 * Projects Right Now may offer, in the shape its scorer already reads.
 *
 * Left out: closed, blocked or waiting work; programs (an umbrella is not
 * something you do in an afternoon — its contributors are); work projects
 * (they never appear on the Dashboard); out-of-season work; and anything that
 * needs rain to do, which is a forecast question, not a free-time one.
 */
function forRightNow(projects, now = new Date(), plan = null) {
	const month = now.getMonth() + 1;
	const stateOf = new Map((plan?.states || []).map((s) => [s.projectUuid, s]));
	const indoorOf = (p) => (p.indoor !== null ? p.indoor : (p.conditions || []).some((c) => OUTDOOR_CONDITIONS.has(c)) ? false : null);
	return projects
		.filter((p) => ["idea", "planning", "ready", "active"].includes(p.effectiveStatus))
		.filter((p) => p.kind !== "program" && p.primaryArea !== "work")
		.filter((p) => !p.seasonMonths || p.seasonMonths.includes(month))
		.filter((p) => !(p.conditions || []).includes("during_rain"))
		// With the execution engine's plan, a project with steps is offered as its
		// next executable step — or not at all while none is ready (heldForRightNow
		// says why). Without steps, or without a plan, it is the project as before.
		.filter((p) => !plan || !(p.steps || []).length || stateOf.get(p.uuid)?.nextAction)
		.map((p) => {
			const base = {
				uuid: p.uuid,
				title: p.title,
				area: p.primaryArea,
				detail: p.goal,
				status: p.effectiveStatus === "active" ? "in_progress" : "todo",
				priority: p.priority >= 4 ? "high" : p.priority <= 2 ? "low" : "normal",
				effortMinutes: p.effort?.min ?? p.effort?.max ?? null,
				indoor: indoorOf(p),
				dueDate: p.hardDeadline,
			};
			const next = plan && (p.steps || []).length ? stateOf.get(p.uuid)?.nextAction : null;
			if (!next) return base;
			return {
				...base,
				title: next.title,
				projectTitle: p.title,
				stepUuid: next.stepUuid,
				detail: next.detail || p.goal,
				status: next.status === "in_progress" || p.effectiveStatus === "active" ? "in_progress" : "todo",
				effortMinutes: next.effortMinutes,
				indoor: next.indoor !== null && next.indoor !== undefined ? next.indoor : base.indoor,
				dueDate: next.dueOn || p.hardDeadline,
				reasons: next.reasons.slice(0, 3),
				startsNew: next.startsNew && !next.urgentStart,
			};
		});
}

/**
 * Open projects Right Now would have offered but can't, each with why and what
 * would change that — so a stuck project is said out loud, never just absent.
 */
function heldForRightNow(projects, plan) {
	const stateOf = new Map((plan?.states || []).map((s) => [s.projectUuid, s]));
	return projects
		.filter((p) => p.kind !== "program" && p.primaryArea !== "work" && !CLOSED.has(p.status) && p.effectiveStatus !== "idea")
		.map((p) => ({ p, s: stateOf.get(p.uuid) }))
		.filter(({ s }) => s && !s.nextAction && s.noActionReason)
		.map(({ p, s }) => ({ id: `project:${p.uuid}`, title: p.title, reason: s.noActionReason, unblock: s.unblock }));
}

module.exports = { rank, forRightNow, heldForRightNow, daysUntil };
