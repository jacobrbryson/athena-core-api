const geminiService = require("./gemini");

/**
 * AI-powered "ghost chore" suggestions for the Family Chores integration.
 *
 * This is a richer sibling of `choreSuggestions.js`. Family Chores' dashboard
 * shows "ghost chores" — suggested, not-yet-real chores — when a child has
 * nothing left to do. When a family has Athena connected, Family Chores asks us
 * for these instead of using its own deterministic templates.
 *
 * Family Chores passes a sanitized context payload (the selected user, their
 * role/age, tenure, recent/active/historical chores, available categories,
 * relevant family settings, coin balance, and recent suggestion activity) and
 * Athena (Gemini) returns STRUCTURED suggestions that are age-aware, role-aware,
 * safe, and parent-approval friendly.
 *
 * Read-only and stateless: Athena never writes back to Family Chores and stores
 * nothing. The partner secret alone authorizes the call (verified by the caller).
 */

const MODEL_VERSION = "ghost-chores-v1/gemini-2.5-flash";

const DEFAULT_COUNT = 6;
const MAX_COUNT = 12;

const DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const SUGGESTION_TYPES = new Set([
	"repeat",
	"next_step",
	"skill_building",
	"novelty",
]);

function clampCount(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return DEFAULT_COUNT;
	return Math.min(MAX_COUNT, Math.max(1, Math.round(n)));
}

function asString(value, max) {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function asPositiveInt(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
	const n = Number(value);
	if (!Number.isFinite(n)) return undefined;
	return Math.min(max, Math.max(min, Math.round(n)));
}

/** Trim a list of {title, ...} chores to a compact, size-bounded shape. */
function compactChores(value, limit) {
	if (!Array.isArray(value)) return [];
	return value
		.map((c) => {
			if (typeof c === "string") return { title: c.slice(0, 120) };
			if (!c || typeof c.title !== "string") return null;
			const out = { title: c.title.trim().slice(0, 120) };
			const coin = asPositiveInt(c.coinValue ?? c.suggestedCoinValue);
			if (coin !== undefined) out.coinValue = coin;
			if (typeof c.category === "string") out.category = c.category.slice(0, 60);
			return out;
		})
		.filter(Boolean)
		.slice(0, limit);
}

/**
 * Normalize the inbound context into a small, model-friendly object. Defensive:
 * never trusts arbitrary shapes, never forwards anything not explicitly listed.
 */
function buildSafeContext(input = {}) {
	const user = input.user || input.child || {};
	const settings = input.familySettings || {};
	return {
		user: {
			displayName: asString(user.displayName, 80) || undefined,
			role: user.role === "admin" ? "admin" : "player",
			age: asPositiveInt(user.age, { min: 1, max: 100 }),
			tenureDays: asPositiveInt(input.tenureDays ?? user.tenureDays, {
				max: 100000,
			}),
			totalChoresCompleted: asPositiveInt(
				input.totalChoresCompleted ?? user.totalChoresCompleted,
				{ max: 1000000 }
			),
			coinBalance: asPositiveInt(input.coinBalance ?? user.coinBalance, {
				max: 100000000,
			}),
		},
		activeChores: compactChores(input.activeChores, 40),
		recentlyCompleted: compactChores(input.recentlyCompleted, 30),
		pastChores: compactChores(input.pastChores, 40),
		recentSuggestionActivity: {
			suggested: compactChores(
				input.recentSuggestionActivity?.suggested,
				20
			),
			dismissed: compactChores(
				input.recentSuggestionActivity?.dismissed,
				20
			),
			accepted: compactChores(input.recentSuggestionActivity?.accepted, 20),
		},
		categories: Array.isArray(input.categories)
			? input.categories
					.map((c) =>
						typeof c === "string"
							? c.slice(0, 60)
							: asString(c && c.name, 60)
					)
					.filter(Boolean)
					.slice(0, 40)
			: [],
		familySettings: {
			minCoin: asPositiveInt(settings.minCoin, { max: 100000 }),
			maxCoin: asPositiveInt(settings.maxCoin, { max: 100000 }),
			requireApproval: settings.requireApproval !== false,
		},
	};
}

/** Build the single-string prompt. The Gemini service enforces JSON output. */
function buildPrompt(ctx, count) {
	const n = clampCount(count);
	const isChild = ctx.user.role !== "admin";
	const ageLine = ctx.user.age
		? `The selected user is about ${ctx.user.age} years old.`
		: "The selected user's age is unknown — keep suggestions broadly safe and simple.";

	return `You are "Athena," a kids' AI learning companion, suggesting "ghost chores" for the Family Chores app — fresh chore ideas a parent can approve and assign.

${ageLine}
They are a ${isChild ? "child/player" : "parent/admin"} account.

Generate ${n} suggestions. Requirements:
- Safe and age-appropriate. For young children avoid anything involving heat, sharp tools, chemicals, ladders, power tools, pools, pets' medical care, or going outside alone. Set "requiresParentReview": true for any suggestion a parent should look at before assigning${isChild ? "; for a child account, ALWAYS true." : "."}
- Do NOT duplicate chores already in "activeChores" or "recentlyCompleted" UNLESS the suggestion is an explicit next-step progression — in that case set "suggestionType":"next_step" and explain the progression in "reason".
- Prefer a mix of suggestion types: "repeat" (a good recurring chore), "next_step" (builds on a completed chore), "skill_building" (teaches a new skill), "novelty" (something fresh and motivating).
- Keep "title" short (2-6 words). "description" one clear sentence a child can understand.
- "difficulty" must be one of: easy, medium, hard.
- "estimatedMinutes": a small integer (1-60) or null if unsure.
- "suggestedCoins": an integer scaled by effort${
		ctx.familySettings.minCoin || ctx.familySettings.maxCoin
			? `, within the family's range ${ctx.familySettings.minCoin ?? 0}-${ctx.familySettings.maxCoin ?? 100}`
			: " (a small reasonable number, 1-20)"
	}.
- "category": pick from the family's "categories" when one fits, else null. "pillar" optional, else null.
- "reason": one sentence explaining WHY this suits THIS user, referencing their history/age when relevant.
- "confidence": a number 0-1 reflecting how strong a fit this is.
- "safetyNotes": a short note if a parent should supervise, else null.

Return ONLY a single valid JSON object, no prose, matching exactly:
{"suggestions":[{"title":string,"description":string,"difficulty":"easy"|"medium"|"hard","estimatedMinutes":number|null,"suggestedCoins":number,"category":string|null,"pillar":string|null,"suggestionType":"repeat"|"next_step"|"skill_building"|"novelty","reason":string,"confidence":number,"requiresParentReview":boolean,"safetyNotes":string|null}]}

context: ${JSON.stringify(ctx)}`;
}

function normalizeSuggestion(s, { forceParentReview }) {
	if (!s || typeof s.title !== "string" || !s.title.trim()) return null;

	const difficulty = DIFFICULTIES.has(s.difficulty) ? s.difficulty : "easy";
	const suggestionType = SUGGESTION_TYPES.has(s.suggestionType)
		? s.suggestionType
		: "novelty";
	const minutes = asPositiveInt(s.estimatedMinutes, { min: 1, max: 600 });
	const coins = asPositiveInt(s.suggestedCoins ?? s.suggestedCoinValue, {
		min: 0,
		max: 1000,
	});
	let confidence = Number(s.confidence);
	if (!Number.isFinite(confidence)) confidence = 0.5;
	confidence = Math.min(1, Math.max(0, confidence));

	return {
		title: s.title.trim().slice(0, 120),
		description: asString(s.description, 280),
		difficulty,
		estimatedMinutes: minutes ?? null,
		suggestedCoins: coins ?? 0,
		category: asString(s.category, 60) || null,
		pillar: asString(s.pillar, 60) || null,
		suggestionType,
		reason: asString(s.reason, 280),
		confidence: Math.round(confidence * 100) / 100,
		// Children can NEVER bypass parent review.
		requiresParentReview: forceParentReview ? true : s.requiresParentReview !== false,
		safetyNotes: asString(s.safetyNotes, 280) || null,
	};
}

/**
 * Generate structured ghost-chore suggestions. Returns
 * `{ suggestions, meta }`. Throws an Error with `.status` on AI/transport
 * failure or an unparseable response so the caller can map it to an HTTP status.
 */
/**
 * Tolerantly parse the model's JSON. Even with responseMimeType=application/json,
 * models occasionally wrap output in ```json fences, add a stray prose line, or
 * return an object embedded in extra text. We strip fences and, failing that,
 * extract the outermost {...} before giving up. Returns null when unparseable.
 */
function parseModelJson(raw) {
	if (typeof raw !== "string" || !raw.trim()) {
		return null;
	}
	let text = raw.trim();
	// Strip a leading ```json / ``` fence and trailing ```.
	text = text
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();
	try {
		return JSON.parse(text);
	} catch {
		// Fall back to the outermost brace span.
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start !== -1 && end > start) {
			try {
				return JSON.parse(text.slice(start, end + 1));
			} catch {
				/* ignore */
			}
		}
		return null;
	}
}

async function generateGhostChoreSuggestions(input = {}) {
	const n = clampCount(input.count);
	const ctx = buildSafeContext(input);
	const forceParentReview = ctx.user.role !== "admin";

	let raw;
	try {
		raw = await geminiService.generateResponse(buildPrompt(ctx, n));
	} catch (err) {
		const e = new Error("The suggestion service is temporarily unavailable");
		e.status = 502;
		e.cause = err;
		throw e;
	}

	const parsed = parseModelJson(raw);
	if (!parsed) {
		// Log a bounded snippet so we can see what the model actually returned.
		console.warn(
			"[ghostChoreSuggestions] Unparseable model response:",
			typeof raw === "string" ? `${raw.slice(0, 300)} (len=${raw.length})` : typeof raw,
		);
		const e = new Error("The suggestion service returned an unexpected response");
		e.status = 502;
		throw e;
	}

	const list = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
	const suggestions = list
		.map((s) => normalizeSuggestion(s, { forceParentReview }))
		.filter(Boolean)
		.slice(0, n);

	return {
		suggestions,
		meta: {
			source: "athena",
			modelVersion: MODEL_VERSION,
			generatedAt: new Date().toISOString(),
		},
	};
}

module.exports = {
	generateGhostChoreSuggestions,
	// Exported for unit tests.
	buildSafeContext,
	normalizeSuggestion,
	parseModelJson,
	MODEL_VERSION,
};
