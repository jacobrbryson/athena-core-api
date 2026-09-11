/**
 * Embedding writer: turns memories into vectors in the active embedding space.
 *
 * Idempotent — a content hash (space + text) means re-embedding unchanged text
 * is a no-op — so it is safe to call after every write AND from the nightly
 * backfill, which also re-embeds everything when LLM_EMBED_MODEL changes.
 */
const crypto = require("crypto");
const pool = require("../../helpers/db");
const llm = require("../llm");
const vectorIndex = require("./vectorIndex");

const BATCH = 32;

function textForEvent(e) {
	return [e.title, e.content].filter(Boolean).join("\n").slice(0, 4000);
}

function textForFact(f) {
	const value = f.memory_value ?? f.value;
	return `${f.category}: ${f.memory_key ?? f.key}${value ? ` — ${value}` : ""}`.slice(0, 2000);
}

function contentHash(space, text) {
	return crypto.createHash("sha1").update(`${space}\n${text}`).digest("hex");
}

/**
 * Embed and upsert vectors. items: [{ type: 'event'|'fact', id, profileId, text }].
 * Returns the number of vectors written. Throws if the embedding endpoint is
 * down; callers that must not fail wrap it.
 */
async function embedAndStore(items) {
	const list = (items || []).filter((i) => i && i.id && i.text && i.text.trim());
	if (!list.length) return 0;
	const space = llm.embeddingSpace();

	// Skip memories whose text is unchanged in this space.
	const tuples = list.map(() => "(?, ?)").join(", ");
	const [existing] = await pool.query(
		`SELECT memory_type, memory_id, content_hash FROM memory_embedding
     WHERE space = ? AND (memory_type, memory_id) IN (${tuples});`,
		[space, ...list.flatMap((i) => [i.type, i.id])]
	);
	const known = new Map(existing.map((r) => [`${r.memory_type}:${r.memory_id}`, r.content_hash]));
	const todo = list
		.map((i) => ({ ...i, hash: contentHash(space, i.text) }))
		.filter((i) => known.get(`${i.type}:${i.id}`) !== i.hash);

	let written = 0;
	for (let start = 0; start < todo.length; start += BATCH) {
		const batch = todo.slice(start, start + BATCH);
		const { vectors, dims } = await llm.embed(
			batch.map((i) => i.text),
			{ purpose: "document" }
		);
		for (let j = 0; j < batch.length; j++) {
			const item = batch[j];
			const vector = vectors[j];
			if (!Array.isArray(vector) && !(vector instanceof Float32Array)) continue;
			const [result] = await pool.query(
				`INSERT INTO memory_embedding (memory_type, memory_id, profile_id, space, dims, vector, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE profile_id = VALUES(profile_id), dims = VALUES(dims),
           vector = VALUES(vector), content_hash = VALUES(content_hash), created_at = CURRENT_TIMESTAMP;`,
				[item.type, item.id, item.profileId ?? null, space, dims, vectorIndex.encode(vector), item.hash]
			);
			vectorIndex.add(item.profileId ?? null, space, {
				type: item.type,
				id: item.id,
				vector,
				rowId: result?.insertId || null,
			});
			written += 1;
		}
	}
	return written;
}

/** Fire-and-forget variant for write paths: never throws, never blocks. */
function embedInBackground(items) {
	embedAndStore(items).catch((err) =>
		console.warn("[memory] background embedding failed (will backfill nightly):", err.message)
	);
}

/**
 * Embed memories that have no vector in the current space (new since the last
 * run, written while the embed endpoint was down, or the model changed).
 */
async function backfill({ limit = 500 } = {}) {
	const space = llm.embeddingSpace();
	const [events] = await pool.query(
		`SELECT e.id, e.profile_id, e.title, e.content FROM memory_event e
     LEFT JOIN memory_embedding m ON m.memory_type = 'event' AND m.memory_id = e.id AND m.space = ?
     WHERE e.deleted_at IS NULL AND m.id IS NULL
     ORDER BY e.id DESC LIMIT ?;`,
		[space, limit]
	);
	const [facts] = await pool.query(
		`SELECT f.id, f.profile_id, f.category, f.memory_key, f.memory_value FROM user_memory f
     LEFT JOIN memory_embedding m ON m.memory_type = 'fact' AND m.memory_id = f.id AND m.space = ?
     WHERE f.deleted_at IS NULL AND m.id IS NULL
     ORDER BY f.id DESC LIMIT ?;`,
		[space, limit]
	);
	const items = [
		...events.map((e) => ({ type: "event", id: e.id, profileId: e.profile_id, text: textForEvent(e) })),
		...facts.map((f) => ({ type: "fact", id: f.id, profileId: f.profile_id, text: textForFact(f) })),
	];
	const written = await embedAndStore(items);
	return { space, pending: items.length, written };
}

module.exports = {
	textForEvent,
	textForFact,
	contentHash,
	embedAndStore,
	embedInBackground,
	backfill,
};
