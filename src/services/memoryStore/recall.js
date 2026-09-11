/**
 * Hybrid recall: "Do you remember…?"
 *
 * Candidates come from four places, then get one blended score:
 *   1. semantic — cosine similarity in the active embedding space
 *   2. keyword  — MySQL FULLTEXT over events and facts (names, rare words, and
 *                 the path that still works when the embedding tier is down)
 *   3. time     — "last week" / "in June" pulls that window's events directly,
 *                 even with no topical overlap ("what did we do last weekend?")
 *   4. transcript — raw chat search, only when an explicit recall question
 *                 found little else
 *
 *   score = 0.55·semantic + 0.20·keyword + 0.15·recency + 0.10·importance
 *   (weights re-balance when semantic is unavailable)
 *
 * Recalled memories are marked (rehearsal), which the nightly consolidation
 * uses to keep often-needed memories strong.
 */
const pool = require("../../helpers/db");
const llm = require("../llm");
const vectorIndex = require("./vectorIndex");
const { parseTimeRange } = require("./timeRange");
const { markRecalled, toMysqlDate } = require("./events");

const DAY = 86_400_000;
const PASSIVE_SEM_FLOOR = Number(process.env.MEMORY_SEM_FLOOR) || 0.5;
const INTENT_SEM_FLOOR = Number(process.env.MEMORY_INTENT_SEM_FLOOR) || 0.35;
const RECALL_TIMEOUT_MS = Number(process.env.MEMORY_RECALL_TIMEOUT_MS) || 2500;

const RECALL_INTENT = new RegExp(
	[
		"\\b(do|did|can|could|would|will) you (still |even )?(remember|recall)\\b",
		"\\bremember (when|that|the|my|what|how|where|who|our|me)\\b",
		"\\bwhat do you (know|remember|recall) about\\b",
		"\\b(have|did) i (ever )?(told|tell|mentioned|mention|said|say|show|shown)\\b",
		"\\bwhat did (i|we) (say|talk|do|see|decide|eat|watch)\\b",
		"\\b(when|where) (did|was) (i|we)\\b",
		"\\blast time (we|i|you)\\b",
		"\\bremind me (what|when|where|who|about)\\b",
	].join("|"),
	"i"
);

const STOPWORDS = new Set(
	"about above after again against also been before being below between both could does doing down during each from further have having here into itself just more most other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your yours remember recall tell told know".split(
		" "
	)
);

function detectRecallIntent(text) {
	return typeof text === "string" && RECALL_INTENT.test(text);
}

function keywordsOf(text, max = 3) {
	return [...new Set((text.toLowerCase().match(/[a-z0-9']{4,}/g) || []).filter((w) => !STOPWORDS.has(w)))]
		.sort((a, b) => b.length - a.length)
		.slice(0, max);
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function recency(date, halfLifeDays, now) {
	const t = date ? new Date(date).getTime() : now;
	const ageDays = Math.max(0, (now - t) / DAY);
	return Math.pow(0.5, ageDays / halfLifeDays);
}

async function semanticCandidates(profileId, query) {
	try {
		const { vectors, space } = await llm.embed(query, { purpose: "query" });
		if (!vectors?.[0]) return null;
		return await vectorIndex.search(profileId, space, vectors[0], { topN: 40 });
	} catch (err) {
		console.warn("[recall] semantic search unavailable, keyword only:", err.message);
		return null;
	}
}

async function keywordCandidates(profileId, query) {
	const q = query.slice(0, 200);
	const out = [];
	try {
		const [events] = await pool.query(
			`SELECT id, MATCH(title, content) AGAINST (? IN NATURAL LANGUAGE MODE) AS kw
       FROM memory_event
       WHERE deleted_at IS NULL
         AND (profile_id = ? OR (scope = 'world' AND occurred_at >= NOW() - INTERVAL 45 DAY))
         AND MATCH(title, content) AGAINST (? IN NATURAL LANGUAGE MODE)
       ORDER BY kw DESC LIMIT 20;`,
			[q, profileId, q]
		);
		for (const r of events) out.push({ type: "event", id: Number(r.id), kw: Number(r.kw) });
		const [facts] = await pool.query(
			`SELECT id, MATCH(memory_key, memory_value) AGAINST (? IN NATURAL LANGUAGE MODE) AS kw
       FROM user_memory
       WHERE profile_id = ? AND deleted_at IS NULL
         AND MATCH(memory_key, memory_value) AGAINST (? IN NATURAL LANGUAGE MODE)
       ORDER BY kw DESC LIMIT 20;`,
			[q, profileId, q]
		);
		for (const r of facts) out.push({ type: "fact", id: Number(r.id), kw: Number(r.kw) });
	} catch (err) {
		console.warn("[recall] keyword search unavailable:", err.message);
	}
	return out;
}

async function timeWindowCandidates(profileId, range) {
	const [rows] = await pool.query(
		`SELECT id FROM memory_event
     WHERE profile_id = ? AND deleted_at IS NULL AND occurred_at >= ? AND occurred_at < ?
     ORDER BY importance DESC, occurred_at DESC LIMIT 15;`,
		[profileId, toMysqlDate(range.from), toMysqlDate(range.to)]
	);
	return rows.map((r) => ({ type: "event", id: Number(r.id), kw: 0.3, inWindow: true }));
}

async function hydrate(profileId, eventIds, factIds) {
	const events = new Map();
	const facts = new Map();
	if (eventIds.length) {
		const [rows] = await pool.query(
			`SELECT id, uuid, kind, scope, title, content, occurred_at, importance, media_ref
       FROM memory_event
       WHERE id IN (${eventIds.map(() => "?").join(", ")}) AND deleted_at IS NULL
         AND (profile_id = ? OR scope = 'world');`,
			[...eventIds, profileId]
		);
		for (const r of rows) events.set(Number(r.id), r);
	}
	if (factIds.length) {
		const [rows] = await pool.query(
			`SELECT id, uuid, category, memory_key, memory_value, confidence, updated_at
       FROM user_memory
       WHERE id IN (${factIds.map(() => "?").join(", ")}) AND profile_id = ? AND deleted_at IS NULL;`,
			[...factIds, profileId]
		);
		for (const r of rows) facts.set(Number(r.id), r);
	}
	return { events, facts };
}

async function transcriptCandidates(profileId, query, limit = 5) {
	const words = keywordsOf(query);
	if (!words.length) return [];
	try {
		const [rows] = await pool.query(
			`SELECT m.uuid, m.text, m.created_at, m.is_human
       FROM message m JOIN session s ON s.id = m.session_id
       WHERE s.profile_id = ? AND m.created_at >= NOW() - INTERVAL 180 DAY
         AND (${words.map(() => "m.text LIKE ?").join(" OR ")})
       ORDER BY m.created_at DESC LIMIT ?;`,
			[profileId, ...words.map((w) => `%${likeEscape(w)}%`), limit]
		);
		return rows.map((r) => ({
			type: "transcript",
			uuid: r.uuid,
			label: r.is_human ? "they said" : "you said",
			title: null,
			text: String(r.text).slice(0, 300),
			when: r.created_at,
			score: 0.3,
		}));
	} catch (err) {
		console.warn("[recall] transcript search failed:", err.message);
		return [];
	}
}

/**
 * Ranked memories relevant to `query` for one profile.
 * Returns { intent, timeRange, semantic, items: [{ type, uuid, label, title, text, when, score }] }.
 */
async function recall(profileId, query, { k, intent, tz, now = Date.now(), includeTranscripts = true } = {}) {
	const isIntent = intent ?? detectRecallIntent(query);
	const limit = k ?? (isIntent ? 8 : 4);
	const timeRange = parseTimeRange(query, { now: new Date(now), tz });

	const [sem, kw, windowed] = await Promise.all([
		semanticCandidates(profileId, query),
		keywordCandidates(profileId, query),
		timeRange ? timeWindowCandidates(profileId, timeRange) : Promise.resolve([]),
	]);

	const cands = new Map(); // "type:id" -> { type, id, sem, kw }
	const touch = (type, id) => {
		const key = `${type}:${id}`;
		if (!cands.has(key)) cands.set(key, { type, id, sem: 0, kw: 0, inWindow: false });
		return cands.get(key);
	};
	const topSim = sem?.[0]?.sim ?? 0;
	const floor = isIntent ? INTENT_SEM_FLOOR : PASSIVE_SEM_FLOOR;
	for (const h of sem || []) {
		if (h.sim >= Math.max(floor, topSim - 0.2)) touch(h.type, h.id).sem = Math.max(0, Math.min(1, h.sim));
	}
	const maxKw = Math.max(0, ...kw.map((c) => c.kw)) || 1;
	for (const c of kw) touch(c.type, c.id).kw = Math.max(touch(c.type, c.id).kw, c.kw / maxKw);
	for (const c of windowed) {
		const entry = touch(c.type, c.id);
		entry.kw = Math.max(entry.kw, c.kw);
		entry.inWindow = true;
	}

	const all = [...cands.values()];
	const { events, facts } = await hydrate(
		profileId,
		all.filter((c) => c.type === "event").map((c) => c.id),
		all.filter((c) => c.type === "fact").map((c) => c.id)
	);

	const semOn = !!sem;
	const w = semOn
		? { sem: 0.55, kw: 0.2, rec: 0.15, imp: 0.1 }
		: { sem: 0, kw: 0.6, rec: 0.25, imp: 0.15 };

	const items = [];
	for (const c of all) {
		if (c.type === "event") {
			const e = events.get(c.id);
			if (!e) continue;
			const at = new Date(e.occurred_at).getTime();
			// A stated time window is a hard filter on episodes.
			if (timeRange && !(at >= timeRange.from.getTime() && at < timeRange.to.getTime())) continue;
			const score =
				w.sem * c.sem + w.kw * c.kw + w.rec * recency(e.occurred_at, 30, now) + w.imp * (e.importance / 10);
			items.push({
				type: "event",
				id: c.id,
				uuid: e.uuid,
				label: e.kind,
				title: e.title,
				text: String(e.content).slice(0, 500),
				when: e.occurred_at,
				mediaRef: e.media_ref || null,
				score,
			});
		} else {
			const f = facts.get(c.id);
			if (!f) continue;
			const score =
				w.sem * c.sem + w.kw * c.kw + w.rec * recency(f.updated_at, 180, now) + w.imp * ((f.confidence ?? 70) / 100);
			items.push({
				type: "fact",
				id: c.id,
				uuid: f.uuid,
				label: f.category,
				title: f.memory_key,
				text: f.memory_value || "",
				when: f.updated_at,
				score,
			});
		}
	}

	items.sort((a, b) => b.score - a.score);
	// Near-duplicate suppression: same title+label or identical text.
	const seen = new Set();
	const ranked = items.filter((i) => {
		const sig = `${i.label}|${(i.title || "").toLowerCase()}|${i.text.slice(0, 60).toLowerCase()}`;
		if (seen.has(sig)) return false;
		seen.add(sig);
		return true;
	});
	let top = ranked.slice(0, limit);

	if (isIntent && includeTranscripts && top.length < 3) {
		top = top.concat(await transcriptCandidates(profileId, query, limit - top.length));
	}

	markRecalled(top.filter((i) => i.type === "event").map((i) => i.id));
	return {
		intent: isIntent,
		timeRange: timeRange ? { label: timeRange.label, from: timeRange.from, to: timeRange.to } : null,
		semantic: semOn,
		items: top.map(({ id, ...rest }) => rest),
	};
}

function formatWhen(when) {
	if (!when) return "";
	const d = new Date(when);
	return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/** Prompt block for the chat model. Returns null when there's nothing worth saying. */
function formatForPrompt(result) {
	if (!result) return null;
	const { intent, items, timeRange } = result;
	if (!items.length && !intent) return null;

	const lines = items.map((i) => {
		if (i.type === "fact") return `- (fact · ${i.label}) ${i.title}${i.text ? `: ${i.text}` : ""}`;
		if (i.type === "transcript") return `- (${formatWhen(i.when)}, ${i.label} in chat) "${i.text}"`;
		const title = i.title ? `"${i.title}" — ` : "";
		return `- (${formatWhen(i.when)}, ${i.label}) ${title}${i.text}`;
	});

	let block = `\n# Long-term memory\n`;
	block += items.length
		? `Retrieved from your memory for this message (most relevant first):\n${lines.join("\n")}\n`
		: `Nothing in your long-term memory matches this message${timeRange ? ` (${timeRange.label})` : ""}.\n`;

	if (intent) {
		block += `
The user is asking what you remember. Answer from the memories above, mentioning roughly when things happened if it helps.
If they don't actually answer the question, say plainly that you don't remember that (or that they may not have told you yet) — never guess, never invent a memory, never pretend. You can ask them to tell you so you'll remember next time.
`;
	} else {
		block += `Use these only if they genuinely fit the conversation — never recite memories unprompted or list what you know.\n`;
	}
	return block;
}

/** recall() with a hard time budget so memory can never stall a reply. */
async function recallWithBudget(profileId, query, opts = {}) {
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve(null), opts.budgetMs || RECALL_TIMEOUT_MS);
	});
	try {
		return await Promise.race([recall(profileId, query, opts).catch(() => null), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

module.exports = {
	recall,
	recallWithBudget,
	formatForPrompt,
	detectRecallIntent,
	keywordsOf,
};
