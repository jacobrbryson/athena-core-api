/**
 * Web search as a grounding source.
 *
 * Without it Athena answers questions about the world from whatever the model
 * remembers, and a small local model answers those confidently and wrong.
 * This runs a Google-grounded search (llm.search) before the reply is
 * written and hands the result to the prompt as context, exactly like a
 * connector read: the reply itself stays one schema-constrained call.
 *
 * Two ways in, mirroring the connectors:
 *   matches(message)  — a keyword gate for explicit asks ("look up", "latest")
 *                       and for any message that names a site or link.
 *   toolIntent        — Jev's guess catches the plain ones ("who won last night?").
 *
 * A named site or link ("today's prompt from orcwood.com") is opened, not just
 * searched for: the pages go to llm.search as `urls` and Gemini reads them
 * itself (URL context), so this server never fetches an address a message
 * supplied. Search alone answered from Google's index, which holds nothing a
 * page builds in the browser — and filled the silence with a guess.
 *
 * Adults only. A child's words do not go out to a search engine.
 *
 * Never throws: a failed or empty search means no web block, and the prompt
 * already tells her not to claim she looked something up when the context
 * doesn't say so.
 */
const llm = require("./llm");

// A search plus its summary takes a few seconds. Past this the reply goes
// ahead without it rather than leaving the person waiting. Opening a named
// page on top of the search takes longer, and was asked for by name.
const TIMEOUT_MS = 8000;
const PAGE_TIMEOUT_MS = 15000;
const MAX_SOURCES = 5;
const MAX_PAGES = 3;
// The same question asked twice in a few minutes (a retry, a repeat in voice)
// should not pay for two searches.
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map();

const EXPLICIT = [
	/\b(look|looking|check) (it |that |this )?up\b/i,
	// Not bare "search": "search my email for…" is a Gmail question.
	/\bgoogle (it|that|this|for)\b/i,
	/\b(search|look|check) (the )?(web|internet|online)\b/i,
	/\b(on|from) the (internet|web)\b/i,
	/\b(latest|breaking|current(ly)?|right now|as of)\b.*\b(news|price|prices|score|scores|version|release|status|rate|rates|results?)\b/i,
	/\b(news|price|prices|score|scores|version|release|status|rate|rates|results?)\b.*\b(latest|today|tonight|this week|right now|currently)\b/i,
	/\bwho won\b/i,
	/\b(stock|share) price\b/i,
	/\bfact[- ]check\b/i,
	/\bis it true that\b/i,
];

// A pasted link, or a bare domain on a common TLD ("orcwood.com/orctober").
// Not after "@" or a dot, so an email address or "node.js" never reads as a
// site; a TLD list rather than any letters, so "e.g." and "3.5" don't either.
const LINK = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const DOMAIN =
	/(?<![@\w.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|edu|gov|io|app|dev|ai|co|us|uk|ca|info|me|tv|gg|xyz|games|tech|site|blog|news|shop|store))(\/[^\s<>"'`]*)?(?![\w-])/gi;

/** The pages a message names outright, as https URLs (at most a few). */
function pagesIn(message) {
	if (typeof message !== "string") return [];
	const found = [];
	const add = (raw) => {
		const trimmed = raw.replace(/[.,!?;:)\]}]+$/, "");
		let url;
		try {
			url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
		} catch {
			return;
		}
		if (url.username || url.password) return;
		if (!found.includes(url.href)) found.push(url.href);
	};
	const rest = message.replace(LINK, (link) => {
		add(link);
		return " ";
	});
	for (const m of rest.matchAll(DOMAIN)) add(m[0]);
	return found.slice(0, MAX_PAGES);
}

/** True when the person explicitly asked for something only a search can answer. */
function matches(message) {
	if (typeof message !== "string" || !message.trim()) return false;
	return EXPLICIT.some((pattern) => pattern.test(message)) || pagesIn(message).length > 0;
}

function remember(key, value) {
	cache.set(key, { value, at: Date.now() });
	if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function recalled(key) {
	const hit = cache.get(key);
	if (!hit) return null;
	if (Date.now() - hit.at > CACHE_MS) {
		cache.delete(key);
		return null;
	}
	return hit.value;
}

function withTimeout(promise, ms) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`web search timed out after ${ms} ms`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

/** The prompt block for a search result. Sources are numbered so she can attribute them. */
function formatBlock(result) {
	const lines = [
		"# From the web (you searched this just now)",
		"You looked this up a moment ago. For facts about the world, use it and let it overrule what you remember.",
		"It knows nothing about this person: when it's about a different event, team or place than their own calendar",
		"or plans show (\"the games\" were their kids' games, not a pro team's), go with theirs, or ask which they mean.",
		"Where it doesn't settle the question, say so rather than filling the gap. Mention a source by name when it matters (\"according to Reuters\");",
		"the links are shown under your reply, so never read out a URL.",
		"",
		result.text,
	];
	if (result.sources.length) {
		lines.push("", "Sources:");
		result.sources.forEach((s, i) => lines.push(`${i + 1}. ${s.title}`));
	}
	return lines.join("\n");
}

/**
 * Search for `message` and return { block, sources } for the prompt and the
 * reply, or null (not an adult, nothing found, or the search failed).
 */
async function buildContext(message, { audience } = {}) {
	if (audience !== "adult") return null;
	const query = typeof message === "string" ? message.trim().slice(0, 1000) : "";
	if (!query) return null;

	const key = query.toLowerCase();
	const urls = pagesIn(query);
	let result = recalled(key);
	if (!result) {
		try {
			const out = urls.length
				? await withTimeout(llm.search(query, { audience, urls }), PAGE_TIMEOUT_MS)
				: await withTimeout(llm.search(query, { audience }), TIMEOUT_MS);
			if (!out?.text) return null;
			result = { text: out.text, sources: (out.sources || []).slice(0, MAX_SOURCES) };
			remember(key, result);
		} catch (err) {
			console.warn("[webSearch] no result:", err.message);
			return null;
		}
	}
	return { block: formatBlock(result), sources: result.sources };
}

module.exports = {
	matches,
	pagesIn,
	buildContext,
	formatBlock,
	TIMEOUT_MS,
	_clearCache: () => cache.clear(),
};
