/**
 * In-process vector index over memory_embedding.
 *
 * A person's memories number in the thousands, not millions, so exact
 * (brute-force) cosine search over a cached, pre-normalized Float32 matrix is
 * both simpler and more accurate than an ANN service — ~1ms for 5k x 768.
 * Each profile's index loads lazily, then syncs incrementally (rows with a
 * higher id) so other Cloud Run instances' writes show up within SYNC_MS.
 * World-scope memories (news) live in one shared index.
 *
 * Scaling path: past ~50k memories per profile, swap this module for pgvector
 * / Qdrant / Vertex Vector Search behind the same search() signature.
 */
const pool = require("../../helpers/db");

const MAX_PROFILES = 64;
const SYNC_MS = 60_000;
const WORLD_KEY = "world";
const WORLD_WINDOW_DAYS = 45;

const indexes = new Map(); // `${key}|${space}` -> { entries, maxId, syncedAt }

function encode(vector) {
	return Buffer.from(new Float32Array(vector).buffer);
}

function decodeNormalized(buf) {
	const view = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
	const out = new Float32Array(view.length);
	let norm = 0;
	for (let i = 0; i < view.length; i++) norm += view[i] * view[i];
	norm = Math.sqrt(norm) || 1;
	for (let i = 0; i < view.length; i++) out[i] = view[i] / norm;
	return out;
}

function normalize(vector) {
	let norm = 0;
	for (const v of vector) norm += v * v;
	norm = Math.sqrt(norm) || 1;
	return Float32Array.from(vector, (v) => v / norm);
}

function dot(a, b) {
	const n = Math.min(a.length, b.length);
	let s = 0;
	for (let i = 0; i < n; i++) s += a[i] * b[i];
	return s;
}

async function sync(key, space, idx) {
	const params = [space, idx.maxId];
	let where;
	if (key === WORLD_KEY) {
		where = `profile_id IS NULL AND space = ? AND id > ? AND created_at >= NOW() - INTERVAL ${WORLD_WINDOW_DAYS} DAY`;
	} else {
		where = "profile_id = ? AND space = ? AND id > ?";
		params.unshift(key);
	}
	const [rows] = await pool.query(
		`SELECT id, memory_type, memory_id, vector FROM memory_embedding WHERE ${where} ORDER BY id ASC LIMIT 20000;`,
		params
	);
	for (const r of rows) {
		idx.entries.push({ type: r.memory_type, id: Number(r.memory_id), vec: decodeNormalized(r.vector) });
		idx.maxId = Math.max(idx.maxId, Number(r.id));
	}
	idx.syncedAt = Date.now();
}

async function getIndex(key, space) {
	const cacheKey = `${key}|${space}`;
	let idx = indexes.get(cacheKey);
	if (!idx) {
		idx = { entries: [], maxId: 0, syncedAt: 0 };
		indexes.set(cacheKey, idx);
		if (indexes.size > MAX_PROFILES) indexes.delete(indexes.keys().next().value); // LRU-ish
	} else {
		indexes.delete(cacheKey); // refresh recency
		indexes.set(cacheKey, idx);
	}
	if (Date.now() - idx.syncedAt > SYNC_MS) await sync(key, space, idx);
	return idx;
}

/**
 * Top-N most similar memories for a query vector across the profile's own
 * index and (optionally) the shared world index.
 * Returns [{ type, id, sim }] sorted by similarity.
 */
async function search(profileId, space, queryVector, { topN = 40, includeWorld = true } = {}) {
	const q = normalize(queryVector);
	const pools = [await getIndex(String(profileId), space)];
	if (includeWorld) pools.push(await getIndex(WORLD_KEY, space));

	const hits = [];
	for (const idx of pools) {
		for (const e of idx.entries) hits.push({ type: e.type, id: e.id, sim: dot(q, e.vec) });
	}
	hits.sort((a, b) => b.sim - a.sim);
	return hits.slice(0, topN);
}

/** Make a vector this instance just wrote searchable immediately. */
function add(profileId, space, { type, id, vector, rowId }) {
	const key = profileId == null ? WORLD_KEY : String(profileId);
	const idx = indexes.get(`${key}|${space}`);
	if (!idx) return; // not loaded yet; the lazy load will pick it up
	idx.entries = idx.entries.filter((e) => !(e.type === type && e.id === Number(id)));
	idx.entries.push({ type, id: Number(id), vec: normalize(vector) });
	if (rowId) idx.maxId = Math.max(idx.maxId, Number(rowId));
}

function remove(profileId, type, id) {
	const prefix = `${profileId == null ? WORLD_KEY : String(profileId)}|`;
	for (const [k, idx] of indexes) {
		if (k.startsWith(prefix)) idx.entries = idx.entries.filter((e) => !(e.type === type && e.id === Number(id)));
	}
}

module.exports = {
	encode,
	decodeNormalized,
	normalize,
	dot,
	search,
	add,
	remove,
	_reset: () => indexes.clear(),
};
