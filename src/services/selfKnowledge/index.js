const { loadCatalog, USER_SECTIONS, SPOKEN_STATUSES } = require("./catalog");

/**
 * Turns the capability catalog into a prompt block for one conversation turn.
 *
 * Two tiers, because both failure modes are real:
 *
 *   index   Every capability available on this surface, one line each, ALWAYS
 *           included. Without it Athena denies features she has — the worst
 *           answer in the product, because the person believes her.
 *   detail  The full user-facing sections for the capabilities this message
 *           is actually about. Budgeted, so a catalog of fifty features costs
 *           the same per turn as a catalog of five.
 *
 * `## Under the hood` never leaves the repository — the renderer only ever
 * emits the sections named in USER_SECTIONS.
 */

// Full detail for at most this many capabilities per turn...
const MAX_DETAIL = 2;
// ...and at most this much of each. Long enough for the sections a capability
// file is required to have; short enough that two of them can't crowd out the
// person's own conversation.
const DETAIL_CHAR_BUDGET = 2200;
// The index is the part that grows forever. Past this, the lowest-ranked lines
// are dropped and Athena is told the list was trimmed, so she offers to look
// again rather than declaring something impossible.
const INDEX_CHAR_BUDGET = 2600;

/** Word-ish boundary match, so "car" doesn't fire on "card". */
function mentions(haystack, trigger) {
	const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/** How strongly this message is about this capability. 0 = not at all. */
function score(cap, message) {
	let hits = 0;
	for (const trigger of cap.triggers) if (mentions(message, trigger)) hits++;
	if (cap.title && mentions(message, cap.title.toLowerCase())) hits += 2;
	return hits;
}

/**
 * The capabilities this person can actually reach. A child is never told
 * about an adult-only panel, and a Guardian is never pointed at a menu that
 * only exists in the Companion app.
 */
function availableTo({ surface, audience }) {
	return loadCatalog().filter(
		(cap) =>
			SPOKEN_STATUSES.has(cap.status) &&
			(!surface || cap.surfaces.includes(surface)) &&
			(!audience || cap.audiences.includes(audience))
	);
}

function indexLine(cap) {
	const where = cap.where ? ` · Where: ${cap.where}` : "";
	const partial = cap.status === "partial" ? " (partly built)" : "";
	return `- **${cap.title}**${partial} — ${cap.summary}${where}`;
}

/** Cut at a line boundary, so a truncated block never ends mid-word. */
function trimToLine(text, budget) {
	const cut = text.slice(0, budget);
	const lastBreak = cut.lastIndexOf("\n");
	return `${(lastBreak > budget / 2 ? cut.slice(0, lastBreak) : cut).trimEnd()}…`;
}

function detailBlock(cap) {
	const render = (headings) =>
		[`### ${cap.title}`]
			.concat(
				headings
					.filter((h) => cap.sections.get(h))
					.map((h) => `**${h}**\n${cap.sections.get(h)}`)
			)
			.join("\n\n");

	let text = render(USER_SECTIONS);
	if (text.length <= DETAIL_CHAR_BUDGET) return text;

	// Over budget: drop the troubleshooting section before anything else. A fix
	// list is something Athena can reason her way back to; the boundaries in
	// "Limits" are the part she cannot invent, and losing them to a blunt
	// character cut is how she starts promising things she can't do.
	text = render(USER_SECTIONS.filter((h) => h !== "When it doesn't work"));
	return text.length <= DETAIL_CHAR_BUDGET ? text : trimToLine(text, DETAIL_CHAR_BUDGET);
}

/**
 * The block appended to the system prompt.
 *
 * Returns null when there is nothing to say (no catalog, or nothing this
 * person can reach) so the caller can skip the section entirely rather than
 * emitting an empty heading the model has to interpret.
 */
function buildCapabilityBlock(message, { surface, audience } = {}) {
	const text = typeof message === "string" ? message : "";
	const available = availableTo({ surface, audience });
	if (!available.length) return null;

	const scored = available
		.map((cap) => ({ cap, score: score(cap, text) }))
		.sort((a, b) => b.score - a.score || a.cap.title.localeCompare(b.cap.title));

	let used = 0;
	let trimmed = 0;
	const lines = [];
	for (const { cap } of scored) {
		const line = indexLine(cap);
		if (used + line.length > INDEX_CHAR_BUDGET) {
			trimmed++;
			continue;
		}
		used += line.length;
		lines.push(line);
	}
	if (trimmed) {
		lines.push(
			`- …and ${trimmed} more feature${trimmed === 1 ? "" : "s"} not listed here. If they ask about something missing from this list, say you think you can and offer to check, rather than saying no.`
		);
	}

	const details = scored
		.filter((s) => s.score > 0)
		.slice(0, MAX_DETAIL)
		.map((s) => detailBlock(s.cap));

	return `
# What I can actually do
This is the real, current feature list for me, Athena — written from the code, not remembered. Treat it as fact about myself.
- Never invent a capability, a menu, a button, or a setting that isn't described here. If someone asks for something that isn't on this list, say plainly that I can't do it yet.
- When someone asks whether I can do something I CAN do, don't just say yes — tell them exactly where to switch it on.
- Don't recite this list unprompted, and never read it out wholesale. It's what I know, not what I say.

${lines.join("\n")}
${details.length ? `\n${details.join("\n\n")}\n` : ""}`;
}

module.exports = {
	buildCapabilityBlock,
	availableTo,
	// Exported for the tests and for any future "what can you do?" endpoint.
	score,
	MAX_DETAIL,
};
