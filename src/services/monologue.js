/**
 * Athena's inner monologue: a second look at a draft reply before she says it.
 *
 * Phase 1 (web search) gave her a way to look things up; this is the part
 * that notices she should have. The chat reply is one call written from the
 * context gathered up front, so when that context was thin the draft fills
 * the gap itself. Here the draft is:
 *
 *   1. screened — Jev, ~0.3 s: does it state checkable facts about the world?
 *      Most replies don't (small talk, plans, feelings) and go out untouched.
 *   2. critiqued — a different model when one is configured (`avoid` the
 *      drafter), asked only whether each specific claim is supported.
 *   3. acted on — a web search for a current, checkable claim, then a
 *      rewrite; or a rewrite told to drop what it can't support.
 *
 * Every pass is recorded in memory (recent turns per person) for the Brain
 * panel's "what I almost said". In memory on purpose for now: the owner chose
 * to see whether it earns a table before adding one, so it resets on deploy.
 *
 * Since 2026-10-10 it also asks whether she is guessing which thing they mean
 * ("the games" was the wrong games), and it reads drafts that propose an
 * action — checked only for being the thing they asked for, and only ever
 * turned into a question.
 *
 * Adults only, like web search. Never throws and never makes a reply worse:
 * any failure, timeout or unusable rewrite sends the draft as written.
 * The critique is model output — it may trigger reads and a rewrite, never
 * an action: a rewrite that proposes anything is discarded, so the only card
 * that can come out of a reflected turn is the one the draft already had.
 */
const llm = require("./llm");
const jev = require("./llm/adapters/jev");

// Jev's probability that the draft states checkable facts. Lower fires the
// critique more often; it costs one model call, and accuracy is the goal.
const SCREEN_AT = 0.5;
const SCREEN_TIMEOUT_MS = 800;
// Past this the critique is abandoned and the draft goes out.
const CRITIQUE_TIMEOUT_MS = 6000;

const PER_PERSON = 25;
const MAX_PEOPLE = 500;
const records = new Map(); // profileId -> newest-last array

const VERDICTS = new Set(["ok", "search", "revise"]);

const CRITIQUE_SCHEMA = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["ok", "search", "revise"] },
		problems: { type: "array", items: { type: "string" } },
		query: { type: "string" },
	},
	required: ["verdict", "problems", "query"],
};

function clip(text, n) {
	const s = typeof text === "string" ? text : "";
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

function withTimeout(promise, ms, what) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

// Asked of every draft beside `factual`: is she guessing what they meant?
// 2026-10-10: "weather for the games today" was answered about Cleveland's
// playoff game while the person's own soccer games sat on their calendar.
// The draft stated nothing false about Cleveland; it was about the wrong
// games, which a fact-check alone never catches.
const ASSUMES_QUESTION = {
	type: "noul",
	instructions:
		"Does the reply (or what it offers to set up) assume which specific thing the person means — " +
		"which event, game, person, place or time — when what they said could mean something else, " +
		"or when it depends on their own plans or calendar?",
	criteria: {
		true: "Yes — it picks one meaning they didn't spell out",
		false: "No — what they meant is clear from what they said",
	},
};

/**
 * Jev's probability that the draft needs a second look, or null when it can't
 * say: the higher of "states checkable facts" and "assumes what they meant".
 * A draft that proposes an action is asked only the second — the card is the
 * fact, and the risk is that it's the wrong one.
 */
async function screen(message, draft, { proposing = false } = {}) {
	if (!(await jev.configured())) return null;
	const questions = { assumes: ASSUMES_QUESTION };
	if (!proposing) {
		questions.factual = {
			type: "noul",
			instructions:
				"Does the reply state specific facts about the world that could be checked and could be wrong — " +
				"numbers, prices, dates, times, scores, names, news, schedules, opening hours, product details, " +
				"or claims about what is true right now?",
			criteria: {
				true: "Yes — it asserts checkable facts",
				false: "No — it is conversation, feelings, opinions, questions, or the person's own plans",
			},
		};
	}
	const out = await llm.decide({
		task: "screen",
		state: clip(`The person said: ${message}\n\nThe reply about to be sent: ${draft}`, 2000),
		questions,
		timeoutMs: SCREEN_TIMEOUT_MS,
	});
	const scores = Object.keys(questions)
		.map((k) => Number(out?.answers?.[k]?.noul))
		.filter(Number.isFinite);
	return scores.length ? Math.max(...scores) : null;
}

function critiquePrompt({ message, draft, context, searched, today, proposal }) {
	let proposed = null;
	if (proposal) {
		try {
			proposed = clip(JSON.stringify({ id: proposal.id, params: proposal.params }), 800);
		} catch {
			proposed = "(unreadable)";
		}
	}
	return [
		"You are checking a reply that Athena, an AI companion, is about to send. Judge two things only:",
		"factual accuracy, and whether she is guessing which thing the person means.",
		"Tone, length and helpfulness are not your concern.",
		"",
		`Today's date: ${today}.`,
		"",
		"# What the person said",
		message,
		"",
		"# What Athena had to go on (her data for this turn; her memories of the person are not shown)",
		context ? clip(context, 6000) : "(nothing beyond the conversation)",
		"",
		"# Her draft reply",
		draft,
		...(proposed
			? [
					"",
					"# What she is about to put on a card for them to approve",
					proposed,
					"Judge only whether it is what they asked for: the right event, place, time and words. A card is",
					'"ok" when they spelled those out or they are in the conversation or her data above.',
				]
			: []),
		"",
		"# Your verdict",
		'"ok" — every specific claim is supported by what she had, is about the person themselves, or is stable general knowledge that is very unlikely to be wrong; and what she took them to mean is what they said or is settled by her data.',
		proposed
			? '"search" is not available for a card.'
			: searched
				? '"search" is not available: she already searched the web this turn and the results are above. Use "revise" if the draft goes beyond them.'
				: '"search" — a claim is about something current or checkable (news, scores, prices, hours, releases, recent events) and a web search would settle it. Put the search in `query`, written the way a person would type it.',
		'"revise" — a claim is unsupported and a search would not help (for example, a guess about the person\'s own data she doesn\'t have), or she picked one meaning of something ambiguous ("the games" could be their kids\' games or a pro team\'s) that nothing above settles.',
		"List each problem in `problems`, one short line each. Empty `problems` and empty `query` for \"ok\".",
		"Return JSON only.",
	].join("\n");
}

/** The critic's verdict, or null when it couldn't give a usable one. */
async function critique({ message, draft, context, searched, audience, avoid, proposal = null }) {
	const today = new Date().toISOString().slice(0, 10);
	const out = await withTimeout(
		llm.generateJson({
			task: "critique",
			contents: critiquePrompt({ message, draft, context, searched, today, proposal }),
			schema: CRITIQUE_SCHEMA,
			audience,
			avoid,
			check: (v) => (VERDICTS.has(v?.verdict) ? null : "no verdict"),
		}),
		CRITIQUE_TIMEOUT_MS,
		"critique"
	);
	const v = out.data;
	let verdict = v.verdict;
	const query = typeof v.query === "string" ? v.query.trim() : "";
	// A search with nothing to search for, a second search in one turn, or a
	// search about a card is a revise.
	if (verdict === "search" && (searched || !query || proposal)) verdict = "revise";
	return {
		verdict,
		problems: Array.isArray(v.problems) ? v.problems.filter((p) => typeof p === "string").slice(0, 5) : [],
		query: verdict === "search" ? query.slice(0, 300) : "",
		critic: { endpointId: out.endpointId, model: out.model },
	};
}

/** What the rewrite is told about its own first draft. */
function revisionNote(draft, problems, { proposing = false } = {}) {
	return [
		"# Before you answer: your first draft",
		"You drafted a reply to this message and caught problems in it before sending it.",
		"",
		"Your draft:",
		draft,
		"",
		"What was wrong with it:",
		...problems.map((p) => `- ${p}`),
		"",
		"Write the reply again, keeping its voice. Use anything above that settles these points.",
		proposing
			? "Don't propose anything this time. Say back what you'd set up and ask the one question that settles it (\"Your soccer game at 5:30, or the Guardians?\"), so they can answer in a word."
			: "Where nothing does, don't state the claim — say plainly that you're not sure, offer to look it up, or ask the one question that settles which thing they mean.",
		"Never mention this draft or that you revised anything.",
	].join("\n");
}

function remember(profileId, record) {
	if (profileId == null) return;
	const key = String(profileId);
	const list = records.get(key) || [];
	list.push(record);
	if (list.length > PER_PERSON) list.splice(0, list.length - PER_PERSON);
	records.delete(key); // re-insert so the Map's order is least-recently-used first
	records.set(key, list);
	if (records.size > MAX_PEOPLE) records.delete(records.keys().next().value);
}

/** This person's recent monologue, newest first. */
function recent(profileId, limit = PER_PERSON) {
	const list = records.get(String(profileId)) || [];
	return list.slice(-limit).reverse();
}

/**
 * Reflect on a draft. Returns { reply, web } — the reply to send (the draft
 * itself unless a rewrite improved on it) and any web result found on the way.
 *
 *   rewrite({ extraContext, prefer }) -> parsed reply | null
 *   search(query) -> { block, sources } | null
 *   onSearch() — called just before a search, for the "let me double-check" line
 */
async function reflect({
	profileId,
	audience,
	message,
	draft,
	draftEndpointId,
	context,
	searched = false,
	rewrite,
	search,
	onSearch,
}) {
	const started = Date.now();
	const keep = { reply: draft, web: null };
	if (audience !== "adult" || !draft?.response || draft.lyrics) return keep;
	// A draft that proposes something is checked for one thing — is it the
	// thing they meant? — and can only become a question. The monologue never
	// writes a proposal of its own; the card, if any, is the draft's.
	const proposal = draft.proposed_action || null;
	const proposing = !!proposal;

	const record = {
		at: new Date().toISOString(),
		message: clip(message, 300),
		proposed: proposing ? String(proposal.id || "").slice(0, 60) || null : null,
		draft: draft.response,
		screen: null,
		verdict: null,
		problems: [],
		query: null,
		sources: [],
		final: draft.response,
		changed: false,
		ms: 0,
	};
	const finish = (result) => {
		record.ms = Date.now() - started;
		if (record.screen != null) remember(profileId, record);
		return result;
	};

	try {
		record.screen = await screen(message, draft.response, { proposing });
	} catch (err) {
		console.warn("[monologue] screen failed:", err.message);
	}
	if (record.screen == null || record.screen < SCREEN_AT) return finish(keep);

	let verdict;
	try {
		verdict = await critique({
			message,
			draft: draft.response,
			context,
			searched,
			audience,
			avoid: draftEndpointId,
			proposal,
		});
	} catch (err) {
		console.warn("[monologue] critique failed:", err.message);
		record.verdict = "unavailable";
		return finish(keep);
	}
	record.verdict = verdict.verdict;
	record.problems = verdict.problems;
	record.critic = verdict.critic;
	if (verdict.verdict === "ok") return finish(keep);

	let web = null;
	if (verdict.verdict === "search") {
		record.query = verdict.query;
		try {
			onSearch?.();
		} catch {
			// The filler line is a nicety; the search goes ahead without it.
		}
		web = await search(verdict.query).catch(() => null);
		record.sources = (web?.sources || []).map((s) => s.title);
	}

	const extraContext = [web?.block, revisionNote(draft.response, verdict.problems, { proposing })]
		.filter(Boolean)
		.join("\n\n");
	let revised = null;
	try {
		revised = await rewrite({ extraContext, prefer: "frontier" });
	} catch (err) {
		console.warn("[monologue] rewrite failed:", err.message);
	}
	if (!revised?.response || revised.proposed_action) return finish({ reply: draft, web: null });

	record.final = revised.response;
	record.changed = revised.response !== draft.response;
	console.info(
		"[monologue]",
		`verdict=${verdict.verdict}`,
		verdict.query ? `searched="${clip(verdict.query, 80)}"` : "",
		`changed=${record.changed}`,
		`${Date.now() - started}ms`
	);
	return finish({ reply: revised, web });
}

module.exports = {
	reflect,
	recent,
	screen,
	critique,
	revisionNote,
	SCREEN_AT,
	_clear: () => records.clear(),
};
