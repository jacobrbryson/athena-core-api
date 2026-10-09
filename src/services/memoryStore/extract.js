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
const { describeNow } = require("../clock");

const TURNS_BEFORE_EXTRACT =
  Number(process.env.MEMORY_EXTRACT_EVERY_TURNS) || 3;
const MAX_FACT_WRITES = 8; // durable facts stored per extraction
const MAX_FACT_CANDIDATES = 25; // how many the model may propose before we stop reading
const EXPLICIT_CUE =
  /\b(remember (that|this|my|me|when)|don'?t forget|forget (that|about|what|my)|note that|keep in mind)\b/i;
const PERSONAL_CUE =
  /\bmy (name|birthday|wife|husband|partner|son|daughter|kids?|mom|dad|brother|sister|dog|cat|pet|job|boss|favorite|anniversary)\b/i;

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
    merge: {
      type: "array",
      items: {
        type: "object",
        properties: {
          into: { type: "string" },
          from: { type: "array", items: { type: "string" } },
          value: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["into", "from", "value", "confidence"],
      },
    },
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

function buildPrompt({ lines, knownFacts, audience, now = new Date() }) {
  const today = describeNow(now);
  const known = knownFacts.length
    ? knownFacts
        .map(
          (f) => `- ${f.category}: ${f.key}${f.value ? ` = ${f.value}` : ""}`,
        )
        .join("\n")
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
- Never repeat a known fact whose value hasn't changed — it is already remembered. Only NEW facts and CHANGED values belong in facts.
- Only what the person stated or clearly confirmed. Never facts about Athena, never guesses, never things only Athena said.
- moments: at most 2 genuinely notable things that happened or were discussed — a plan made, a story told, a feeling shared, a decision, a milestone. Skip small talk and games. importance 1-10 (10 = life event).
- One key per person, pet or place: theirs. A new detail about someone already known — how they are related, their birthday, where they live — is a CHANGED value for their existing key: reuse that exact key and write the whole value, every old detail kept and the new one added ("aunt missy" = "Lives in Charlotte; my dad's sister"). Never make a key like "aunt missy relation" or "skylar birthday".
- merge: when known facts already split one person across keys ("aunt missy" and "aunt missy relation"), fold them together: into = the person's own key, from = the other keys (each starts with that key), value = one combined value that keeps every detail from all of them. confidence 0-100.
- forget: exact keys of known facts the person explicitly asked you to forget or said were wrong.
- These lines were written on ${today.weekday} ${today.iso}. A memory outlives the conversation, so never store a relative day ("tonight", "tomorrow", "Friday", "next week"): work out the real date from today and write it in, e.g. "line dancing on Fri 2026-09-25". Read later, "Friday night" says nothing about which Friday.
- A one-off plan or event with a date is a moment, never a fact. Facts are only for things that stay true.
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
  const cue =
    EXPLICIT_CUE.test(userText || "") || PERSONAL_CUE.test(userText || "");
  if (cue || count >= TURNS_BEFORE_EXTRACT) {
    pendingTurns.set(session.id, 0);
    extractSession(session, { audience, source: "turn" }).catch((err) =>
      console.warn("[memory] extraction failed:", err.message),
    );
  }
}

async function getCursor(sessionId) {
  const [rows] = await pool.query(
    `SELECT last_created_at FROM memory_extraction_cursor WHERE session_id = ? LIMIT 1;`,
    [sessionId],
  );
  return rows[0]?.last_created_at || null;
}

async function setCursor(sessionId, createdAt) {
  await pool.query(
    `INSERT INTO memory_extraction_cursor (session_id, last_created_at) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE last_created_at = VALUES(last_created_at);`,
    [sessionId, createdAt],
  );
}

/**
 * Extract memories from a session's not-yet-processed messages.
 * Returns { facts, moments, forgotten } counts (all zero when nothing new).
 */
async function extractSession(
  session,
  { audience = "child", source = "turn" } = {},
) {
  const empty = emptyResult();
  if (!session?.profile_id || inFlight.has(session.id)) return empty;
  inFlight.add(session.id);
  try {
    const since = await getCursor(session.id);
    const all = await messageService.getMessagesSince(session.id, since, 40);
    if (!all.some((m) => m.is_human)) return empty;

    // `applyExtraction` writes everything it finds to `session.profile_id`, so
    // only that person's own words may feed it. A session can hold two
    // guardians now (0030_session_participant), and extracting across them
    // would file one person's disclosures as the other's memories — the exact
    // thing a shared conversation must not do.
    //
    // Athena's own turns stay: they are the context that makes a reply like
    // "yes, the 14th" mean anything. The other guardian's turns are dropped
    // rather than relabelled, because a model given both names will attribute
    // across them however firmly it is told not to.
    const owner = Number(session.profile_id);
    const messages = all.filter(
      (m) =>
        !m.is_human ||
        m.profile_id == null || // written before speakers were recorded
        Number(m.profile_id) === owner,
    );

    // Somebody else did all the talking. Nothing to remember for this profile,
    // but the cursor still moves — otherwise their turns are re-read on every
    // pass, forever.
    if (!messages.some((m) => m.is_human)) {
      await setCursor(session.id, all[all.length - 1].created_at);
      return empty;
    }

    const knownFacts = await memory.getMemorySummaryForProfileId(
      session.profile_id,
      50,
    );
    const lines = messages.map(
      (m) =>
        `[${m.is_human ? "person" : "athena"}] ${String(m.text).replace(/\s+/g, " ").slice(0, 600)}`,
    );

    const { data } = await llm.generateJson({
      task: "extract",
      audience,
      schema: EXTRACT_SCHEMA,
      // The conversation's own date, not the job's: a late extraction pass
      // must still resolve "tomorrow" against the day it was said.
      contents: buildPrompt({
        lines,
        knownFacts,
        audience,
        now: new Date(messages[messages.length - 1].created_at),
      }),
      check: checkShape,
      temperature: 0.1,
    });

    const result = await applyExtraction(session, data, {
      audience,
      occurredAt: messages[messages.length - 1].created_at,
    });
    // Advance past everything read, not just everything extracted from, or
    // another participant's turns are reconsidered on every pass.
    await setCursor(session.id, all[all.length - 1].created_at);
    await logExtraction(
      session,
      source,
      messages.filter((m) => m.is_human).length,
      result,
    );
    return result;
  } finally {
    inFlight.delete(session.id);
  }
}

/** Every reason a proposal can fail to become a memory, all zero. */
function emptyDropped() {
  return { duplicate: 0, lowConfidence: 0, locked: 0, malformed: 0, overCap: 0 };
}

/** What an extraction produced — and, as importantly, what it threw away. */
function emptyResult() {
  return {
    facts: 0,
    moments: 0,
    forgotten: 0,
    merged: 0,
    proposed: { facts: 0, moments: 0 },
    dropped: emptyDropped(),
  };
}

/**
 * Write what the model proposed, and account for everything that wasn't
 * written. "0 facts" alone can't tell "nothing new was said" from "the
 * extractor is broken" — the 2026-09 stall looked like the second and was
 * the model re-stating known facts that the duplicate check then skipped.
 *
 * `dryRun` decides everything the same way but writes nothing, and returns
 * a `decisions` list so a replay can show why each proposal landed where it did.
 */
async function applyExtraction(
  session,
  data,
  { audience, occurredAt, dryRun = false },
) {
  const profileId = session.profile_id;
  const familyId = session.family_id || null;
  const result = emptyResult();
  const decisions = [];
  const decide = (kind, item, outcome) => {
    if (dryRun) decisions.push({ kind, category: item?.category, key: item?.key ?? item?.title, outcome });
  };

  const proposedFacts = Array.isArray(data.facts) ? data.facts : [];
  const proposedMoments = Array.isArray(data.moments) ? data.moments : [];
  result.proposed = { facts: proposedFacts.length, moments: proposedMoments.length };

  // Cap WRITES, not candidates. The model re-states facts it was already told
  // about in the prompt, so capping the candidate list let those duplicates
  // eat the budget and silently drop genuinely new facts off the end.
  const candidates = proposedFacts.slice(0, MAX_FACT_CANDIDATES);
  result.dropped.overCap += proposedFacts.length - candidates.length;
  for (let i = 0; i < candidates.length; i++) {
    const f = candidates[i];
    if (result.facts >= MAX_FACT_WRITES) {
      result.dropped.overCap += candidates.length - i;
      break;
    }
    if (
      !f ||
      typeof f.key !== "string" ||
      !f.key.trim() ||
      typeof f.value !== "string"
    ) {
      result.dropped.malformed += 1;
      decide("fact", f, "malformed");
      continue;
    }
    const confidence = Math.max(0, Math.min(100, Number(f.confidence) || 60));
    if (confidence < 50) {
      result.dropped.lowConfidence += 1;
      decide("fact", f, "lowConfidence");
      continue;
    }
    const existing = await memory.getFactSlot(profileId, f.category, f.key);
    if (existing && !existing.deleted_at) {
      // parent-curated: never overwritten by AI; user-entered: only by a
      // high-confidence restatement
      if (existing.source === "parent" || (existing.source === "user" && confidence < 80)) {
        result.dropped.locked += 1;
        decide("fact", f, "locked");
        continue;
      }
      if ((existing.memory_value || "") === f.value) {
        result.dropped.duplicate += 1;
        decide("fact", f, "duplicate");
        continue;
      }
    }
    decide("fact", f, existing && !existing.deleted_at ? "update" : "new");
    if (!dryRun) {
      await memory.upsertMemoryForProfile(profileId, familyId, {
        category: f.category,
        key: f.key,
        value: f.value,
        source: "ai",
        confidence,
        visibility: "private",
      });
    }
    result.facts += 1;
  }

  result.dropped.overCap += Math.max(0, proposedMoments.length - 2);
  for (const m of proposedMoments.slice(0, 2)) {
    if (!m || typeof m.summary !== "string" || !m.summary.trim()) {
      result.dropped.malformed += 1;
      decide("moment", m, "malformed");
      continue;
    }
    decide("moment", m, "new");
    result.moments += 1;
    if (dryRun) continue;
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
  }

  await applyMerges(profileId, familyId, data.merge, { result, decide, dryRun });

  const forget = (Array.isArray(data.forget) ? data.forget : []).slice(0, 10);
  if (dryRun) {
    for (const key of forget) decisions.push({ kind: "forget", key, outcome: "forget" });
    return { ...result, decisions };
  }
  result.forgotten = await memory.forgetFactsByKey(profileId, forget);
  return result;
}

const MAX_MERGES = 5;
// "aunt missy relation" and "aunt missy's birthday" are details of "aunt missy";
// "aunt mary" is somebody else. Only the first kind may be folded in, so a model
// can tidy one person's keys but never fuse two people.
const detailOf = (from, into) => {
  const f = from.trim().toLowerCase();
  const i = into.trim().toLowerCase();
  return f !== i && (f.startsWith(`${i} `) || f.startsWith(`${i}'s `) || f.startsWith(`${i}’s `));
};

/**
 * Fold one person's facts, scattered across keys, back under their own key:
 * write the combined value there, then soft-delete the others. Curated facts
 * are held to the same locks as an ordinary write, and a merge that can't
 * take every key it names takes none.
 */
async function applyMerges(profileId, familyId, merges, { result, decide, dryRun }) {
  const proposed = Array.isArray(merges) ? merges : [];
  result.merged = 0;
  for (const m of proposed.slice(0, MAX_MERGES)) {
    const from = Array.isArray(m?.from) ? m.from.filter((k) => typeof k === "string" && k.trim()) : [];
    const item = { category: null, key: m?.into };
    if (typeof m?.into !== "string" || !m.into.trim() || typeof m.value !== "string" || !m.value.trim() || !from.length || !from.every((k) => detailOf(k, m.into))) {
      result.dropped.malformed += 1;
      decide("merge", item, "malformed");
      continue;
    }
    const confidence = Math.max(0, Math.min(100, Number(m.confidence) || 60));
    const [target] = await memory.findLiveFactsByKey(profileId, m.into);
    const parts = (await Promise.all(from.map((k) => memory.findLiveFactsByKey(profileId, k)))).flat();
    if (!target || !parts.length) {
      result.dropped.malformed += 1;
      decide("merge", item, "malformed");
      continue;
    }
    const locked = (row) => row.source === "parent" || (row.source === "user" && confidence < 80);
    if (confidence < 50 || [target, ...parts].some(locked)) {
      result.dropped[confidence < 50 ? "lowConfidence" : "locked"] += 1;
      decide("merge", { ...item, category: target.category }, confidence < 50 ? "lowConfidence" : "locked");
      continue;
    }
    decide("merge", { ...item, category: target.category }, "merge");
    result.merged += 1;
    if (dryRun) continue;
    await memory.upsertMemoryForProfile(profileId, familyId, {
      category: target.category,
      key: target.memory_key,
      value: m.value,
      source: "ai",
      confidence,
      visibility: "private",
    });
    for (const p of parts) await memory.forgetFactById(profileId, p.id);
  }
  result.dropped.overCap += Math.max(0, proposed.length - MAX_MERGES);
}

/**
 * One row per extraction, counts only — never content, so it is safe for
 * child profiles too. The self-review reads it to tell a quiet extractor from
 * a broken one. Best-effort: until migration 0045 is applied the insert fails
 * and extraction carries on exactly as before.
 */
let extractionLogEnabled = true;
async function logExtraction(session, source, humanLines, r) {
  if (!extractionLogEnabled) return;
  try {
    await pool.query(
      `INSERT INTO memory_extraction_log
         (session_id, profile_id, source, human_lines, proposed_facts, proposed_moments,
          written_facts, written_moments, forgotten, dropped_duplicate, dropped_low_confidence,
          dropped_locked, dropped_malformed, dropped_over_cap)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        session.id,
        session.profile_id,
        source,
        humanLines,
        r.proposed.facts,
        r.proposed.moments,
        r.facts,
        r.moments,
        r.forgotten,
        r.dropped.duplicate,
        r.dropped.lowConfidence,
        r.dropped.locked,
        r.dropped.malformed,
        r.dropped.overCap,
      ],
    );
  } catch (err) {
    if (err?.code === "ER_NO_SUCH_TABLE") extractionLogEnabled = false;
    else console.warn("[memory] extraction log write failed:", err.message);
  }
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
    [limit],
  );
  const totals = {
    sessions: 0,
    facts: 0,
    moments: 0,
    forgotten: 0,
    failed: 0,
    proposed: { facts: 0, moments: 0 },
    dropped: emptyDropped(),
  };
  for (const s of sessions) {
    try {
      const audience = audienceFor ? await audienceFor(s.profile_id) : "child";
      if (
        audienceFor?.memoryEnabled &&
        !(await audienceFor.memoryEnabled(s.profile_id))
      )
        continue;
      const r = await extractSession(s, { audience, source: "nightly" });
      totals.sessions += 1;
      totals.facts += r.facts;
      totals.moments += r.moments;
      totals.forgotten += r.forgotten;
      totals.proposed.facts += r.proposed?.facts || 0;
      totals.proposed.moments += r.proposed?.moments || 0;
      for (const k of Object.keys(totals.dropped)) totals.dropped[k] += r.dropped?.[k] || 0;
    } catch (err) {
      totals.failed += 1;
      console.warn(
        `[memory] nightly extraction failed for session ${s.id}:`,
        err.message,
      );
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
