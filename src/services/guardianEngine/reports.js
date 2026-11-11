/**
 * The words of the evening and morning reports (owner, 2026-10-25).
 *
 * Pure functions of what the engine recorded — no model writes these, so a
 * report can never say "all clear" about something nobody looked at. Every
 * claim maps to an observation: "checked the garage doors" only when they
 * were looked at, "peaceful" only when the forecast was read and was calm.
 */
const { REASONS, lower } = require("./checks");

const join = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The evening report.
 *   garage:   [{ name, status, reason }]           what the sweep saw of each door
 *   umbrella: { name, status, reason } | null      null when not set up / not included
 *   risk:     the storm assessment (weatherRisk.assess)
 *   tonight:  { known, calm, phrase } (weatherRisk.tonight)
 * Returns { text, severity } — urgent when something is open or a door is unverified.
 */
function eveningText({ garage = [], umbrella = null, risk = null, tonight = null }) {
	const stormy = !!risk?.atRisk || (tonight?.known && !tonight.calm);
	const weatherNoun = risk?.atRisk && risk.reasons?.length ? risk.reasons[0].text : tonight?.phrase || "the weather turns";
	const problems = [];
	const unknowns = [];
	const checked = [];
	const doors = garage.filter((g) => g.status !== "not_applicable");
	if (doors.length) checked.push(doors.length > 1 ? "the garage doors" : `the ${lower(doors[0].name)}`);
	for (const g of doors) {
		if (g.status === "open") problems.push(`your ${lower(g.name)} is still open`);
		else if (g.status !== "closed") unknowns.push(`I couldn't verify the ${lower(g.name)} — ${REASONS[g.reason] || "I couldn't get a clear look"}`);
	}
	let umbrellaNote = "";
	if (umbrella && umbrella.status !== "not_applicable") {
		checked.push(`the ${lower(umbrella.name)}`);
		if (umbrella.status === "up" && stormy) problems.push(`the ${lower(umbrella.name)} needs to be brought down before ${weatherNoun}`);
		else if (umbrella.status === "up") umbrellaNote = ` The ${lower(umbrella.name)} is up, but the night looks calm.`;
		else if (umbrella.status !== "down") unknowns.push(`I couldn't see whether the ${lower(umbrella.name)} is down — ${REASONS[umbrella.reason] || "I couldn't get a clear look"}`);
	}
	const weatherSentence = !tonight?.known
		? "I couldn't read tonight's forecast"
		: tonight.calm
			? "the weather looks peaceful tonight"
			: `there's ${tonight.phrase} tonight`;
	const urgent = problems.length > 0 || doors.some((g) => g.status !== "closed");
	if (problems.length) {
		const also = unknowns.length ? ` Also, ${join(unknowns)}.` : "";
		// The umbrella line already names the weather; otherwise say it.
		const weather = stormy && problems.some((p) => p.includes("brought down")) ? "" : ` ${capital(weatherSentence)}.`;
		return { text: `ALERT: ${capital(join(problems))}.${also}${weather}`.slice(0, 600), severity: "urgent" };
	}
	if (unknowns.length) {
		return { text: `Heads up: ${join(unknowns)}. ${capital(weatherSentence)}.${umbrellaNote}`.slice(0, 600), severity: urgent ? "urgent" : "advisory" };
	}
	if (!checked.length) {
		return { text: `Evening check: nothing is set up for me to look at yet, and ${weatherSentence}.`, severity: "advisory" };
	}
	const link = tonight?.known && tonight.calm ? "and" : tonight?.known ? "but" : "though";
	return { text: `All clear — I checked ${join(checked)}, ${link} ${weatherSentence}.${umbrellaNote}`.slice(0, 600), severity: "advisory" };
}

const CONDITION = { open: "was open", up: "was up", unknown: "couldn't be verified", offline: "couldn't be checked (camera not responding)" };

/**
 * The morning report: what happened between last evening's sweep and now.
 *   incidents: Guardian incidents (store rows) opened, closed or still open in the window
 *   missed:    runs in the window that never ran
 *   strangers: { count, firstAt, camera } of stranger sightings overnight, or null
 *   clock:     (Date) => "11:40 PM" in the household's zone
 */
function morningText({ from, to, incidents = [], missed = [], strangers = null, clock }) {
	const inWindow = (v) => v && new Date(v) >= from && new Date(v) <= to;
	const lines = [];
	let urgent = false;
	for (const i of incidents) {
		const name = lower(i.context?.subjectName || i.subject_key);
		const opened = inWindow(i.first_detected_at);
		const active = ["open", "notified", "acknowledged"].includes(i.state);
		const how = CONDITION[i.condition_status] || "needed attention";
		if (active) {
			urgent = urgent || i.condition_status === "open";
			lines.push(`the ${name} ${how === "was open" ? "is still open" : how === "was up" ? "is still up" : "still " + how.replace(/^couldn't/, "can't")} (since ${clock(new Date(i.first_detected_at))})`);
		} else if (opened || inWindow(i.resolved_at)) {
			const end = i.state === "resolved" ? `, fixed by ${clock(new Date(i.resolved_at))}` : i.state === "dismissed" ? ", dismissed" : "";
			lines.push(`the ${name} ${how} at ${clock(new Date(i.first_detected_at))}${end}`);
		}
	}
	if (missed.length) lines.push(`${missed.length === 1 ? "one check" : `${missed.length} checks`} didn't run (the cameras weren't reachable)`);
	if (strangers?.count) lines.push(`the cameras saw a stranger ${strangers.count === 1 ? "once" : `${strangers.count} times`} (first at ${clock(new Date(strangers.firstAt))}${strangers.camera ? ` on the ${strangers.camera}` : ""})`);
	if (!lines.length) return { text: "Good morning. All quiet overnight.", severity: "advisory", quiet: true };
	return { text: `Good morning. Overnight: ${join(lines)}.`.slice(0, 600), severity: urgent ? "urgent" : "advisory", quiet: false };
}

/** "7h 12m" */
function hoursText(hours) {
	const total = Math.round(hours * 60);
	return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, "0")}m`;
}

/**
 * The morning report's lines after the house (owner, 2026-11-10): values only,
 * no comparisons, one line each, and a line is left out when there's nothing
 * to say. Owner asked for it "as short and direct as possible".
 *   weather:  "High 54°, rain from around 3 PM" | null
 *   personal: { sleep: { asleepHours, hrv, rhr } | null, meeting: { at, title } | null, due: [string] } | null
 */
function morningPersonal({ weather = null, personal = null, clock }) {
	const lines = [];
	const s = personal?.sleep;
	if (s) {
		const bits = [s.asleepHours ? `Slept ${hoursText(s.asleepHours)}` : null, s.hrv ? `HRV ${Math.round(s.hrv)}` : null, s.rhr ? `RHR ${Math.round(s.rhr)}` : null].filter(Boolean);
		if (bits.length) lines.push(`${bits.join(" · ")}.`);
	}
	if (weather) lines.push(`${capital(weather)}.`);
	if (personal?.meeting) lines.push(`First meeting ${clock(personal.meeting.at)}, ${personal.meeting.title}.`);
	if (personal?.due?.length) lines.push(`Due today: ${personal.due.join(", ")}.`);
	return lines;
}

const MACROS = [
	["calories", "calories", ""],
	["protein_g", "protein", " g"],
	["carbs_g", "carbs", " g"],
	["fat_g", "fat", " g"],
	["water_oz", "water", " oz"],
];

/**
 * The evening report's food line (owner, 2026-11-10): only the targets more
 * than 20% over or under, "No meals logged." when nothing was, and "Food on
 * target." when everything is within 20% — so silence never stands in for a
 * read that didn't happen. Null when the person has set no targets.
 */
function macroLine(food) {
	if (!food?.targets) return null;
	const set = MACROS.filter(([k]) => Number(food.targets[k]) > 0);
	if (!set.length) return null;
	if (!food.logged) return "No meals logged today.";
	const off = [];
	for (const [k, name, unit] of set) {
		const target = Number(food.targets[k]);
		const got = Math.round(Number(food.totals?.[k]) || 0);
		const pct = Math.round(((got - target) / target) * 100);
		if (Math.abs(pct) > 20) off.push(`${name} ${got.toLocaleString("en-US")} of ${Math.round(target).toLocaleString("en-US")}${unit} (${Math.abs(pct)}% ${pct > 0 ? "over" : "under"})`);
	}
	return off.length ? `Food: ${off.join(", ")}.` : "Food on target.";
}

module.exports = { eveningText, morningText, morningPersonal, macroLine, join };
