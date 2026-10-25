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
	const hello = "Good morning, I hope you slept well through the night.";
	if (!lines.length) return { text: `${hello} All quiet — nothing happened overnight.`, severity: "advisory", quiet: true };
	return { text: `${hello} Overnight: ${join(lines)}.`.slice(0, 600), severity: urgent ? "urgent" : "advisory", quiet: false };
}

module.exports = { eveningText, morningText, join };
