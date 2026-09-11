/**
 * Background memory extraction: after a few conversation turns, distill what's
 * worth remembering into durable FACTS (user_memory) and notable MOMENTS
 * (memory_event, kind "conversation").
 *
 * Runs off the reply path (fire-and-forget, one in flight per session) on the
 * "extract" task, which the router prefers to run locally on Orcwood — cheap,
 * and private conversation text never needs to leave Orcwood hardware.
 *
 * Guarantees:
 *   - Only what the PERSON said — never Athena's own lines, never guesses.
 *   - Children: interests/favorites/pets/hobbies only; no names, places,
 *     schools, contact details, health, or family conflict.
 *   - Parent-curated facts are never overwritten by AI; user-entered facts
 *     only by a high-confidence restatement.
 *   - "Forget that…" soft-deletes the matching facts.
 */
const llm = require("../llm");
const memory = require("../memory");
const messageService = require("../message");
const pool = require("../../helpers/db");
const { createEvent } = require("./events");

const TURNS_BEFORE_EXTRACT = Number(process.env.MEMORY_EXTRACT_EVERY_TURNS) || 3;
const EXPLICIT_CUE = /\b(remember (that|this|my|me|when)|don'?t forget|forget (that|about|what|my)|note that|keep in mind)\b/i;
const PERSONAL_CUE = /\bmy (name|birthday|wife|husband|partner|son|daughter|kids?|mom|dad|brother|sister|dog|cat|pet|job|boss|favorite|anniversary)\b/i;

const inFlight = new Set();
const pendingTurns = new Map(); // sessionId -> human turns since last extraction

const CATEGORY_LIST = [...memory.CATEGORIES];

const EXTRACT_SCHEMA = {
	type: "object",
	properties: {
		facts: {
			type: "array",
			items: {
				type: "object",
				properties: {
					category: { type: "string", enum: CATEGORY_LIST },
					key: { type: "string" },
					value: { type: "string" },
					confidence: { type: "number" },
				},
				required: ["category", "key", "value", "confidence"],
			},
		},
		moments: {
			type: "array",
			items: {
				type: "object",
				properties: {
					title: { type: "string" },
					summary: { type: "string" },
					importance: { type: "number" },
				},
				required: ["title", "summary", "importance"],
			},
		},
		forget: { type: "array", items: { type: "string" } },
	},
	required: ["facts", "moments", "forget"],
};

function checkShape(data) {
	if (!data || typeof data !== "object") return "not an object";
	for (const k of ["facts", "moments", "forget"]) {
		if (!Array.isArray(data[k])) return `missing ${k}[]`;
	}
	return null;
}

function buildPrompt({ lines, knownFacts, audience }) {
	const known = knownFacts.length
		? knownFacts.map((f) => `- ${f.category}: ${f.key}${f.value ? ` = ${f.value}` : ""}`).join("\n")
		: "(none yet)";
	const audienceRules =
		audience === "adult"
			? `- Never store passwords, financial account numbers, or government ID numbers, even if mentioned.
- Health, relationships, and beliefs: only if the person clearly shared them as something about their life, never inferred.`
			: `- THIS IS A CHILD. Store ONLY interests, favorite things, hobbies, pets and pets' names, and what they like to learn.
- NEVER store: other people's names, addresses, towns, schools, phone numbers, emails, ages of others, anything about health, bodies, or family conflict.`;

	return `You maintain Athena's long-term memory about one person. Read the NEW conversation lines and extract only what is worth remembering long-term.

Already known facts (category: key = value):
${known}

Rules:
- facts: durable things THE PERSON said about themselves or their life — people, pets, places, work/school, interests, preferences, goals, routines, important dates. Use a short stable key ("dog's name", "favorite team", "sister") and put the detail in value. If a known fact changed, reuse its exact category and key with the new value. confidence 0-100.
- Only what the person stated or clearly confirmed. Never facts about Athena, never guesses, never things only Athena said.
- moments: at most 2 genuinely notable things that happened or were discussed — a plan made, a story told, a feeling shared, a decision, a milestone. Skip small talk and games. importance 1-10 (10 = life event).
- forget: exact keys of known facts the person explicitly asked you to forget or said were wrong.
- Empty arrays are normal and correct for most conversations.
${audienceRules}

Return ONLY JSON matching this schema: ${JSON.stringify(EXTRACT_SCHEMA)}

NEW conversation lines (oldest first):
${lines.join("\n")}`;
}

/**
 * Called after every Athena reply. Cheap: it only counts turns and decides
 * whether to launch an extraction in the background.
 */
function afterTurn(session, userText, { audience, memoryEnabled }) {
	if (!session?.profile_id || !memoryEnabled) return;
	const count = (pendingTurns.get(session.id) || 0) + 1;
	pendingTurns.set(session.id, count);
	const cue = EXPLICIT_CUE.test(userText || "") || PERSONAL_CUE.test(userText || "");
	if (cue || count >= TURNS_BEFORE_EXTRACT) {
		pendingTurns.set(session.id, 0);
		extractSession(session, { audience }).catch((err) =>
			console.warn("[memory] extraction failed:", err.message)
		);
	}
}

async function getCursor(sessionId) {
	const [rows] = await pool.query(
		`SELECT last_created_at FROM memory_extraction_cursor WHERE session_id = ? LIMIT 1;`,
		[sessionId]
	);
	return rows[0]?.last_created_at || null;
}

async function setCursor(sessionId, createdAt) {
	await pool.query(
		`INSERT INTO memory_extraction_cursor (session_id, last_created_at) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE last_created_at = VALUES(last_created_at);`,
		[sessionId, createdAt]
	);
}

/**
 * Extract memories from a session's not-yet-processed messages.
 * Returns { facts, moments, forgotten } counts (all zero when nothing new).
 */
async function extractSession(session, { audience = "child" } = {}) {
	const empty = { facts: 0, moments: 0, forgotten: 0 };
	if (!session?.profile_id || inFlight.has(session.id)) return empty;
	inFlight.add(session.id);
	try {
		const since = await getCursor(session.id);
		const messages = await messageService.getMessagesSince(session.id, since, 40);
		if (!messages.some((m) => m.is_human)) return empty;

		const knownFacts = await memory.getMemorySummaryForProfileId(session.profile_id, 50);
		const lines = messages.map(
			(m) => `[${m.is_human ? "person" : "athena"}] ${String(m.text).replace(/\s+/g, " ").slice(0, 600)}`
		);

		const { data } = await llm.generateJson({
			task: "extract",
			audience,
			schema: EXTRACT_SCHEMA,
			contents: buildPrompt({ lines, knownFacts, audience }),
			check: checkShape,
			temperature: 0.1,
		});

		const result = await applyExtraction(session, data, {
			audience,
			occurredAt: messages[messages.length - 1].created_at,
		});
		await setCursor(session.id, messages[messages.length - 1].created_at);
		return result;
	} finally {
		inFlight.delete(session.id);
	}
}

async function applyExtraction(session, data, { audience, occurredAt }) {
	const profileId = session.profile_id;
	const familyId = session.family_id || null;
	let facts = 0;
	let moments = 0;

	for (const f of (data.facts || []).slice(0, 8)) {
		if (!f || typeof f.key !== "string" || !f.key.trim() || typeof f.value !== "string") continue;
		const confidence = Math.max(0, Math.min(100, Number(f.confidence) || 60));
		if (confidence < 50) continue;
		const existing = await memory.getFactSlot(profileId, f.category, f.key);
		if (existing && !existing.deleted_at) {
			if (existing.source === "parent") continue; // parent-curated: never overwritten by AI
			if (existing.source === "user" && confidence < 80) continue;
			if ((existing.memory_value || "") === f.value) continue;
		}
		await memory.upsertMemoryForProfile(profileId, familyId, {
			category: f.category,
			key: f.key,
			value: f.value,
			source: "ai",
			confidence,
			visibility: "private",
		});
		facts += 1;
	}

	for (const m of (data.moments || []).slice(0, 2)) {
		if (!m || typeof m.summary !== "string" || !m.summary.trim()) continue;
		await createEvent({
			profileId,
			familyId,
			kind: "conversation",
			title: typeof m.title === "string" ? m.title : null,
			content: m.summary,
			importance: m.importance,
			occurredAt,
			source: "ai",
			visibility: "private",
			sessionId: session.id,
			metadata: { audience },
		});
		moments += 1;
	}

	const forgotten = await memory.forgetFactsByKey(profileId, (data.forget || []).slice(0, 10));
	return { facts, moments, forgotten };
}

/** Nightly sweep: extract any session with unprocessed messages from the last 2 days. */
async function extractPendingSessions({ limit = 200, audienceFor } = {}) {
	const [sessions] = await pool.query(
		`SELECT s.id, s.profile_id, s.family_id FROM session s
     LEFT JOIN memory_extraction_cursor c ON c.session_id = s.id
     WHERE s.profile_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM message m WHERE m.session_id = s.id
           AND m.created_at >= NOW() - INTERVAL 2 DAY
           AND (c.last_created_at IS NULL OR m.created_at > c.last_created_at)
       )
     LIMIT ?;`,
		[limit]
	);
	const totals = { sessions: 0, facts: 0, moments: 0, forgotten: 0, failed: 0 };
	for (const s of sessions) {
		try {
			const audience = audienceFor ? await audienceFor(s.profile_id) : "child";
			if (audienceFor?.memoryEnabled && !(await audienceFor.memoryEnabled(s.profile_id))) continue;
			const r = await extractSession(s, { audience });
			totals.sessions += 1;
			totals.facts += r.facts;
			totals.moments += r.moments;
			totals.forgotten += r.forgotten;
		} catch (err) {
			totals.failed += 1;
			console.warn(`[memory] nightly extraction failed for session ${s.id}:`, err.message);
		}
	}
	return totals;
}

module.exports = {
	afterTurn,
	extractSession,
	applyExtraction,
	extractPendingSessions,
	buildPrompt,
	EXTRACT_SCHEMA,
	EXPLICIT_CUE,
};
