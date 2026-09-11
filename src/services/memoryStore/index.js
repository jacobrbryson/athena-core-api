/**
 * Memory v2 — Athena's long-term memory. See docs/architecture/memory-v2.md.
 *
 *   facts      user_memory (services/memory.js)   durable "semantic" memory
 *   episodes   memory_event (./events)            what happened
 *   vectors    memory_embedding (./embeddings)    semantic recall
 *   recall     ./recall                           hybrid search + prompt block
 *   writers    ./extract (chat), ./photos, ./news, ./journal (reflections)
 */
const pool = require("../../helpers/db");
const memory = require("../memory");
const { audienceForSession, audienceForProfile, memoryEnabledForProfile } = require("../audience");
const embeddings = require("./embeddings");
const vectorIndex = require("./vectorIndex");
const events = require("./events");
const recallModule = require("./recall");
const extract = require("./extract");
const photos = require("./photos");
const news = require("./news");
const journal = require("./journal");

let started = false;

/** Wire fact writes/deletes to the embedding index. Call once at server start. */
function start() {
	if (started) return;
	started = true;
	memory.memoryEvents.on("fact:written", (row) => {
		embeddings.embedInBackground([
			{ type: "fact", id: row.id, profileId: row.profile_id, text: embeddings.textForFact(row) },
		]);
	});
	memory.memoryEvents.on("fact:deleted", ({ id, profile_id }) => {
		vectorIndex.remove(profile_id, "fact", id);
	});
}

/**
 * Everything the chat pipeline needs from memory for one incoming message:
 * { audience, memoryEnabled, recall, promptBlock }. Never throws and never
 * takes longer than the recall budget — memory must not stall a reply.
 */
async function buildMemoryContext(session, message, ctx = {}) {
	const audience = await audienceForSession(session, ctx).catch(() => "child");
	const profileId = session?.profile_id || null;
	// Long-term memory (recall + extraction) runs for bound profiles only —
	// Guardian AR-game sessions keep their existing lightweight fact summary.
	if (!profileId || ctx.guardian || ctx.guardianAuth) {
		return { audience, memoryEnabled: false, recall: null, promptBlock: null };
	}
	const memoryEnabled = await memoryEnabledForProfile(profileId).catch(() => false);
	if (!memoryEnabled) return { audience, memoryEnabled, recall: null, promptBlock: null };

	const result = await recallModule.recallWithBudget(profileId, message, { tz: ctx.companion?.timezone || undefined });
	return {
		audience,
		memoryEnabled,
		recall: result,
		promptBlock: recallModule.formatForPrompt(result),
	};
}

/**
 * Nightly consolidation: memories that keep getting recalled get stronger;
 * old unrecalled low-importance conversation moments fade a step.
 */
async function consolidate() {
	const [strengthened] = await pool.query(
		`UPDATE memory_event SET importance = LEAST(10, importance + 1)
     WHERE deleted_at IS NULL AND recall_count >= 3 AND importance < 9
       AND last_recalled_at >= NOW() - INTERVAL 1 DAY;`
	);
	const [faded] = await pool.query(
		`UPDATE memory_event SET importance = GREATEST(1, importance - 1)
     WHERE deleted_at IS NULL AND kind = 'conversation' AND importance BETWEEN 2 AND 4
       AND recall_count = 0 AND occurred_at < NOW() - INTERVAL 90 DAY
       AND (last_recalled_at IS NULL OR last_recalled_at < NOW() - INTERVAL 90 DAY);`
	);
	return { strengthened: strengthened?.affectedRows || 0, faded: faded?.affectedRows || 0 };
}

module.exports = {
	start,
	buildMemoryContext,
	consolidate,
	audienceForProfile,
	memoryEnabledForProfile,
	recall: recallModule.recall,
	formatForPrompt: recallModule.formatForPrompt,
	detectRecallIntent: recallModule.detectRecallIntent,
	createEvent: events.createEvent,
	listEvents: events.listEvents,
	deleteEvent: events.deleteEvent,
	afterTurn: extract.afterTurn,
	extractSession: extract.extractSession,
	extractPendingSessions: extract.extractPendingSessions,
	rememberPhoto: photos.rememberPhoto,
	describeImage: photos.describeImage,
	ingestNews: news.ingestNews,
	renderJournal: journal.renderJournal,
	reflectOnDay: journal.reflectOnDay,
	profilesNeedingReflection: journal.profilesNeedingReflection,
	backfillEmbeddings: embeddings.backfill,
};
