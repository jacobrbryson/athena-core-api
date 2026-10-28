/**
 * What Athena knows about a person's projects in conversation: the open ones,
 * in the same order the app shows them, with what each is waiting on and its
 * next step, plus open concerns. Capped so it never crowds the prompt.
 *
 * Read-only. Changing a project from chat goes through the add_project /
 * update_project actions, which the person approves.
 */
const projects = require("./index");
const { rank } = require("./rank");
const execution = require("./execution");
const { CLOSED } = require("./shape");
const bindings = require("./bindings");
const { openIssues } = require("../../controllers/propertyIssues");
const { promptVehicles } = require("../../controllers/propertyVehicles");
const { promptTaxes } = require("../billRecords");

const MAX_LINES = 18;
const AREA = { health: "Health", family: "Family", community: "Community", work: "Work", home: "Home" };

/** One vehicle: what it is, its mileage, what comes due, and the latest work. */
function vehicleLine(v) {
	const car = [v.year, v.make, v.model].filter(Boolean).join(" ");
	const due = [
		["registration", v.registrationDue],
		["inspection", v.inspectionDue],
		["insurance renewal", v.insuranceDue],
		["next service", v.serviceDue],
	]
		.filter(([, d]) => d)
		.map(([what, d]) => `${what} ${d}`);
	if (v.serviceDueMiles !== null) due.push(`next service at ${v.serviceDueMiles} mi`);
	const bits = [
		car && car !== v.name ? car : null,
		v.color,
		v.plate ? `plate ${v.plate}` : null,
		v.registrationState || v.registrationNumber ? `registered${v.registrationState ? ` in ${v.registrationState}` : ""}${v.registrationNumber ? ` (registration no. ${v.registrationNumber})` : ""}` : null,
		v.inspectionStation ? `inspected at ${v.inspectionStation}` : null,
		v.odometer !== null ? `${v.odometer} mi as of ${v.odometerOn}` : null,
		due.length ? `due: ${due.join(", ")}` : null,
		v.service.length ? `latest work: ${v.service.map((s) => `${s.doneOn} ${s.what.slice(0, 120)}${s.odometer !== null ? ` at ${s.odometer} mi` : ""}`).join("; ")}` : null,
		(v.recalls || []).length
			? `unrepaired NHTSA recalls for this model year (not confirmed on this car): ${v.recalls.map((r) => `${r.campaign} ${r.component || ""}${r.status === "acknowledged" ? " (they've seen it, not yet repaired)" : ""}${r.parkIt ? " — NHTSA says don't drive it" : r.parkOutside ? " — NHTSA says park outside" : ""}`.trim()).join("; ")}`
			: null,
	].filter(Boolean);
	return `- "${v.name}"${bits.length ? ` (${bits.join("; ")})` : ""}${v.notes ? ` Their note: ${v.notes.slice(0, 200)}` : ""}`;
}

const at = (iso) => `${String(iso).slice(0, 16).replace("T", " ")} UTC`;

/**
 * The execution engine's view of one project, as a few clauses: the ready
 * next step and why, what is blocked and when to look again, the next session,
 * and how close it is to finished. Derived, never the whole graph.
 */
function executionBits(state, p) {
	if (!state) return [];
	const out = [];
	const next = state.nextAction;
	if (next) {
		const facts = [next.reasons[0], next.effortMinutes ? `about ${next.effortMinutes} min` : null, next.needsMultipleSessions ? "more than one sitting" : null]
			.filter(Boolean).join(", ");
		out.push(`ready next: "${next.title}"${next.phase ? ` in ${next.phase}` : ""}${facts ? ` (${facts})` : ""}${next.startsNew ? " — would start the project" : ""}`);
	} else if (state.noActionReason) {
		out.push(`nothing ready: ${state.noActionReason}${state.unblock ? ` To unstick: ${state.unblock}` : ""}`);
	}
	for (const b of state.blockedSteps.slice(0, 2)) {
		out.push(`blocked: "${b.stepTitle}"${b.blockedOn ? ` on ${b.blockedOn}` : ""}${b.waitingOn ? `, waiting on ${b.waitingOn}` : ""}` +
			(b.due ? ` — check-back was due ${at(b.reviewAt)}: ${b.action}` : b.triage ? " — no check-back date yet; ask when to look again" : `, check back ${at(b.reviewAt)}`));
	}
	const session = state.upcomingSessions[0];
	if (session) {
		const step = session.stepUuid ? p.steps.find((s) => s.uuid === session.stepUuid)?.title : null;
		out.push(`next session ${at(session.plannedStart)}, ${session.plannedMinutes} min${step ? ` on "${step}"` : ""}${session.calendarEventId ? "" : " (not on the calendar)"}`);
	}
	for (const s of state.sessionsToCheckIn.slice(0, 1)) {
		out.push(`the ${at(s.plannedStart)} session has passed with no word on it — ask how it went`);
	}
	const named = (state.phases || []).filter((ph) => ph.name);
	if (named.length) out.push(`phases: ${named.slice(0, 8).map((ph) => `${ph.name} ${ph.done}/${ph.total}`).join(", ")}`);
	const c = state.completion;
	if (c.state === "outcome_unverified") out.push(`every step done; ${c.criteria.total - c.criteria.confirmed} of ${c.criteria.total} "done when" checks unconfirmed`);
	if (c.state === "ready_for_confirmation") out.push(c.hasCriteria ? "every step done and checked — ready for them to close it out" : "every step done — ask if it's finished");
	if (c.hasCriteria && c.state === "work_remaining") out.push(`done when: ${execution.getProjectCloseoutSummary(p).criteria.map((x) => x.text).slice(0, 4).join("; ")}`);
	return out;
}

async function promptBlock(profileId) {
	const [all, issues, vehicles, taxes] = await Promise.all([projects.getAll(profileId), openIssues(profileId), promptVehicles(profileId), promptTaxes(profileId)]);
	if (!all.projects.length && !all.concerns.length && !issues.length && !vehicles.length && !taxes.length) return null;
	const now = Date.now();
	const ranks = rank(all, now);
	const plan = execution.getExecutionPlan(all, { now, ranks, prefs: all.prefs });
	const stateOf = new Map(plan.states.map((s) => [s.projectUuid, s]));
	const byId = new Map(all.projects.map((p) => [p.uuid, p]));
	const open = all.projects
		.filter((p) => !CLOSED.has(p.status))
		.sort((a, b) => (ranks.get(b.uuid)?.score ?? -1e9) - (ranks.get(a.uuid)?.score ?? -1e9));
	const line = (p) => {
		const needs = all.links
			.filter((l) => l.relation === "depends_on" && l.from === p.uuid)
			.map((l) => byId.get(l.to))
			.filter((d) => d && !CLOSED.has(d.status))
			.map((d) => d.title);
		const items = p.items || [];
		const pending = items.filter((i) => i.status === "pending").map((i) => i.label);
		const confirmed = items.filter((i) => i.kind === "spec" && i.status === "confirmed")
			.map((i) => `${i.label}${i.value ? ` ${i.value}${i.unit ? ` ${i.unit}` : ""}` : ""}`);
		const b = p.budget || {};
		const bits = [
			AREA[p.primaryArea],
			p.effectiveStatus,
			p.pinnedAt ? "they moved this to the front of the line" : null,
			p.refCode || p.revision ? [p.refCode, p.revision && `v${p.revision}`].filter(Boolean).join(" ") : null,
			b.working !== null && b.working !== undefined ? `working budget $${b.working}` : null,
			b.ceiling !== null && b.ceiling !== undefined ? `approval ceiling $${b.ceiling}` : null,
			confirmed.length ? `confirmed: ${confirmed.slice(0, 6).join(", ")}` : null,
			pending.length ? `still to verify: ${pending.slice(0, 6).join(", ")}` : null,
			p.kind === "program" ? "program" : null,
			p.waitingOn ? `waiting on ${p.waitingOn}` : null,
			needs.length ? `needs first: ${needs.slice(0, 2).join(", ")}` : null,
			p.hardDeadline ? `deadline ${p.hardDeadline}` : null,
			p.progress.steps.total ? `${p.progress.steps.done}/${p.progress.steps.total} steps` : null,
			...executionBits(stateOf.get(p.uuid), p),
		].filter(Boolean);
		return `- "${p.title}" (${bits.join("; ")})`;
	};
	// Live numbers for the few bound projects that have them: weight against
	// its planned line, and sessions this week. Calendar bindings are left out
	// here — a provider read on every message is not worth it.
	const progress = [];
	for (const p of open.filter((x) => (x.bindings || []).some((b) => b.sourceType !== "calendar_match")).slice(0, 3)) {
		const live = await bindings.read(profileId, p.uuid, { skip: ["calendar_match"] }).catch(() => []);
		for (const b of live) {
			const d = b.data;
			if (!d) continue;
			if (b.sourceType === "health_metric" && d.actual !== null) {
				const plan = d.planned !== null ? `; plan for today ${d.planned} ${d.unit}, so ${d.verdict.replace("_", " ")} by ${Math.abs(d.gap)} ${d.unit}` : "";
				progress.push(`- "${p.title}": weight ${d.actual} ${d.unit} (7-day average)${d.start !== null ? `, ${d.change >= 0 ? "+" : ""}${d.change} since start` : ""}${d.target !== null ? `, target ${d.target}${d.endsOn ? ` by ${d.endsOn}` : ""}` : ""}${plan}.`);
			} else if (b.sourceType === "whoop_sport") {
				progress.push(`- "${p.title}": ${d.thisWeek} ${d.sports.join("/")} session${d.thisWeek === 1 ? "" : "s"} so far this week${d.last ? `, last on ${d.last.date} (${d.last.sport})` : ""}.`);
			}
		}
	}
	const concerns = all.concerns.filter((c) => c.status === "open").sort((a, b) => b.severity - a.severity);
	const recentDone = all.projects
		.filter((p) => p.status === "done" && p.completedAt && Date.now() - Date.parse(p.completedAt) < 14 * 86_400_000)
		.map((p) => p.title);
	return [
		"# Their projects",
		"",
		`They keep projects on the Projects and Home pages (${open.length} open). The most pressing, in their own order:`,
		...open.slice(0, MAX_LINES).map(line),
		...(open.length > MAX_LINES ? [`- …and ${open.length - MAX_LINES} more.`] : []),
		...(progress.length ? ["", "Measured progress (arithmetic, from their scale and WHOOP):", ...progress] : []),
		...(concerns.length ? ["", "Open concerns: " + concerns.slice(0, 6).map((c) => `"${c.title}"`).join(", ") + "."] : []),
		...(issues.length
			? [
					"",
					"Open property issues they reported (something wrong at the house now; help troubleshoot, or find a repair pro with a web search when asked):",
					...issues.map(
						(i) =>
							`- ${i.location} (${i.severity}, noticed ${i.noticedOn}): ${i.description.slice(0, 300)}${i.notes ? ` Their note: ${i.notes.slice(0, 200)}` : ""}${i.log.length ? ` Latest updates: ${i.log.map((n) => `[${n.createdAt.slice(0, 16).replace("T", " ")} UTC] ${n.body.slice(0, 200)}`).join(" ")}` : ""}`,
					),
				]
			: []),
		...(vehicles.length
			? [
					"",
					"Vehicles they keep at their property (they edit these on the Property page's Vehicles tab; you can't change them from chat):",
					...vehicles.map(vehicleLine),
				]
			: []),
		...(taxes.length
			? [
					"",
					"Unpaid tax installments on record (property and vehicle tax, from bills they showed you; they see them on Property → Taxes):",
					...taxes.map((t) => `- ${t.jurisdiction} ${t.kind === "vehicle" ? "vehicle tax" : "property tax"}${t.taxYear ? ` ${t.taxYear}` : ""} (${t.label}) due ${t.dueOn}${t.amount ? `, $${t.amount}` : ""}`),
				]
			: []),
		...(recentDone.length ? ["", `Finished in the last two weeks: ${recentDone.slice(0, 6).join(", ")}.`] : []),
		"",
		...(plan.focus.over
			? ["", `They have ${plan.focus.active} active projects and prefer to keep about ${plan.focus.limit} going — lean toward finishing those over starting another, unless something can't wait. Never pause or drop one yourself.`]
			: []),
		"",
		"Use these when they come up — what to do next, what's blocked, how you could help. Talk like a partner on the job: " +
			"the one next thing and why it's ready, not a status report. " +
			"When they tell you they finished something, started something, or want a step or note added, propose update_project " +
			"with the project's title exactly as listed. When they describe something new they want to track, propose add_project. " +
			"For one step — a blocker (ask what it waits on, who, and when to check back if they haven't said), steps that must " +
			"come first, or what done means for it — propose update_project_step. To set time aside, suggest a realistic block " +
			"from the step's effort and propose schedule_project_work; it goes on their calendar only through " +
			"put_project_session_on_calendar, when they want that. Once a session's time has passed, ask how it went " +
			"(record_project_session), and ask separately whether the step itself is done — a session finishing doesn't finish the step. " +
			"When every step is done, go through the \"done when\" checks with them and propose close_out_project only after they " +
			"confirm each one; never judge structural or safety work finished yourself. " +
			"Don't recite this list unprompted, and never change a project without proposing it.",
	].join("\n");
}

module.exports = { promptBlock };
