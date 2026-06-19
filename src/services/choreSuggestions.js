const geminiService = require("./gemini");

/**
 * AI-powered chore suggestions for the Family Chores integration.
 *
 * Family Chores passes context (the child, the chores they already have, and
 * any notes); Athena (Gemini) returns a list of fresh, age-appropriate chore
 * ideas. Read-only and stateless — this does not write anything back to
 * Family Chores; the partner app decides what to do with the suggestions.
 */

const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;

function clampCount(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return DEFAULT_COUNT;
	return Math.min(MAX_COUNT, Math.max(1, Math.round(n)));
}

/** Build the single-string prompt. The Gemini service enforces JSON output. */
function buildPrompt({ child = {}, existingChores = [], context, count }) {
	const n = clampCount(count);
	const safeChild = {
		displayName: typeof child.displayName === "string" ? child.displayName : undefined,
		age: Number.isFinite(Number(child.age)) ? Number(child.age) : undefined,
		interests: Array.isArray(child.interests)
			? child.interests.filter((i) => typeof i === "string").slice(0, 20)
			: undefined,
	};
	const existing = (Array.isArray(existingChores) ? existingChores : [])
		.map((c) => (typeof c === "string" ? { title: c } : c))
		.filter((c) => c && typeof c.title === "string")
		.slice(0, 50);

	return `You are "Athena," a kids' AI learning companion, helping a parent in the Family Chores app come up with chore ideas.

Generate ${n} NEW chore suggestions appropriate for this child. Requirements:
- Safe and age-appropriate. For young children avoid anything involving heat, sharp tools, chemicals, ladders, or going outside alone.
- Do NOT duplicate any chore in the "existingChores" list (avoid near-duplicates too).
- Keep titles short (2-5 words). Descriptions one sentence.
- If existing chores include coin values, suggest "suggestedCoinValue" in a similar range; otherwise pick a small reasonable number (1-15) scaled by effort.

Return ONLY a single valid JSON object, no prose, matching exactly:
{"suggestions":[{"title":string,"description":string,"suggestedCoinValue":number,"ageAppropriate":boolean,"rationale":string}]}

child: ${JSON.stringify(safeChild)}
existingChores: ${JSON.stringify(existing)}
notes: ${typeof context === "string" && context.trim() ? context.trim().slice(0, 500) : "none"}`;
}

function normalizeSuggestion(s) {
	if (!s || typeof s.title !== "string" || !s.title.trim()) return null;
	const coin = Number(s.suggestedCoinValue);
	return {
		title: s.title.trim().slice(0, 120),
		description:
			typeof s.description === "string" ? s.description.trim().slice(0, 280) : "",
		suggestedCoinValue: Number.isFinite(coin) ? Math.max(0, Math.round(coin)) : null,
		ageAppropriate: s.ageAppropriate !== false,
		rationale:
			typeof s.rationale === "string" ? s.rationale.trim().slice(0, 280) : "",
	};
}

/**
 * Generate chore suggestions. Returns an array (possibly empty). Throws an
 * Error with `.status` on AI/transport failure.
 */
async function generateChoreSuggestions(input = {}) {
	const n = clampCount(input.count);
	let raw;
	try {
		raw = await geminiService.generateResponse(buildPrompt(input));
	} catch (err) {
		const e = new Error("The suggestion service is temporarily unavailable");
		e.status = 502;
		e.cause = err;
		throw e;
	}

	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		const e = new Error("The suggestion service returned an unexpected response");
		e.status = 502;
		throw e;
	}

	const list = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
	return list.map(normalizeSuggestion).filter(Boolean).slice(0, n);
}

module.exports = { generateChoreSuggestions };
