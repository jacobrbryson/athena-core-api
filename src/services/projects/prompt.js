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
const { CLOSED } = require("./shape");
const bindings = require("./bindings");
const { openIssues } = require("../../controllers/propertyIssues");
const { promptVehicles } = require("../../controllers/propertyVehicles");

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

async function promptBlock(profileId) {
	const [all, issues, vehicles] = await Promise.all([projects.getAll(profileId), openIssues(profileId), promptVehicles(profileId)]);
	if (!all.projects.length && !all.concerns.length && !issues.length && !vehicles.length) return null;
	const ranks = rank(all);
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
		const next = p.steps.find((s) => s.status === "in_progress") || p.steps.find((s) => s.status === "todo");
		const bits = [
			AREA[p.primaryArea],
			p.effectiveStatus,
			p.kind === "program" ? "program" : null,
			p.waitingOn ? `waiting on ${p.waitingOn}` : null,
			needs.length ? `needs first: ${needs.slice(0, 2).join(", ")}` : null,
			p.hardDeadline ? `deadline ${p.hardDeadline}` : null,
			next ? `next step: ${next.title}` : null,
			p.progress.steps.total ? `${p.progress.steps.done}/${p.progress.steps.total} steps` : null,
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
		...(recentDone.length ? ["", `Finished in the last two weeks: ${recentDone.slice(0, 6).join(", ")}.`] : []),
		"",
		"Use these when they come up — what to do next, what's blocked, how you could help. " +
			"When they tell you they finished something, started something, or want a step or note added, propose update_project " +
			"with the project's title exactly as listed. When they describe something new they want to track, propose add_project. " +
			"Don't recite this list unprompted, and never change a project without proposing it.",
	].join("\n");
}

module.exports = { promptBlock };
