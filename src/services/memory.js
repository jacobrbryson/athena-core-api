const { EventEmitter } = require("events");
const { v4: uuidv4 } = require("uuid");
const pool = require("../helpers/db");
const { authorizeChildForParent, getFamilyForProfile } = require("./family");
const { getProfileByGoogleId } = require("./parent-helpers");

/**
 * Memory foundation service (Phase 7) — durable FACTS about a user.
 *
 * Stores structured facts (interests, pets, people, preferences, …) as
 * category/key/value slots. Memory v2 (services/memoryStore) builds on this:
 * episodes live in memory_event, and every fact written here is embedded for
 * semantic recall via the `memoryEvents` hook below.
 * See docs/architecture/memory-v2.md.
 *
 * Each row is family-aware (family_id), user-specific (profile_id), and
 * privacy-aware (visibility: 'private' | 'family').
 */

// Emits "fact:written" (row) and "fact:deleted" ({ id, profile_id }) so the
// memory store can keep embeddings in sync with every writer (UI, AI
// extraction, the Family Chores integration) without each one knowing.
const memoryEvents = new EventEmitter();

const CATEGORIES = new Set([
	"interest",
	"subject",
	"pet",
	"family",
	"person",
	"place",
	"work",
	"goal",
	"routine",
	"preference",
	"other",
]);
const VISIBILITIES = new Set(["private", "family"]);
const SOURCES = new Set(["user", "parent", "ai"]);

function normalizeCategory(v) {
	if (typeof v !== "string") return "other";
	const c = v.trim().toLowerCase();
	return CATEGORIES.has(c) ? c : "other";
}

function publicMemory(row) {
	return {
		uuid: row.uuid,
		category: row.category,
		key: row.memory_key,
		value: row.memory_value,
		source: row.source,
		visibility: row.visibility,
		confidence: row.confidence,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

/** Resolve the profile.id + family for an actor (parent google id or child profile uuid). */
async function resolveProfileId({ googleId, profileUuid, profileId }) {
	if (Number.isFinite(Number(profileId)) && Number(profileId) > 0) {
		// Already-verified profile (e.g. a paired device token).
		const family = await getFamilyForProfile(Number(profileId)).catch(() => null);
		return { profileId: Number(profileId), familyId: family ? family.id : null };
	}
	if (googleId) {
		const p = await getProfileByGoogleId(googleId);
		const family = await getFamilyForProfile(p.id);
		return { profileId: p.id, familyId: family ? family.id : null };
	}
	if (profileUuid) {
		const [rows] = await pool.query(
			`SELECT p.id, cp.family_id
       FROM profile p
       LEFT JOIN child_profiles cp ON cp.profile_id = p.id
       WHERE p.uuid = ? LIMIT 1;`,
			[profileUuid]
		);
		if (!rows.length) throw new Error("Profile not found");
		return { profileId: rows[0].id, familyId: rows[0].family_id || null };
	}
	throw new Error("No actor provided");
}

/** List a profile's own memories. includePrivate controls 'private' rows. */
async function listOwnMemory(actor, options = {}) {
	const { profileId } = await resolveProfileId(actor);
	const includePrivate = options.includePrivate !== false;
	const conditions = ["profile_id = ?", "deleted_at IS NULL"];
	const params = [profileId];
	if (!includePrivate) {
		conditions.push("visibility = 'family'");
	}
	const [rows] = await pool.query(
		`SELECT uuid, category, memory_key, memory_value, source, visibility, confidence, created_at, updated_at
     FROM user_memory WHERE ${conditions.join(" AND ")}
     ORDER BY category ASC, updated_at DESC;`,
		params
	);
	return rows.map(publicMemory);
}

/** Parent view of a child's family-visible memories. */
async function listChildMemoryForParent(googleId, childUuid) {
	const { child } = await authorizeChildForParent(googleId, childUuid);
	const [rows] = await pool.query(
		`SELECT uuid, category, memory_key, memory_value, source, visibility, confidence, created_at, updated_at
     FROM user_memory
     WHERE profile_id = ? AND deleted_at IS NULL AND visibility = 'family'
     ORDER BY category ASC, updated_at DESC;`,
		[child.profile_id]
	);
	return rows.map(publicMemory);
}

/**
 * Core upsert keyed directly on a resolved profile/family. Used both by the
 * actor-based `upsertMemory` and by server-to-server callers (e.g. the Family
 * Chores integration) that have already resolved the target child profile.
 */
async function upsertMemoryForProfile(profileId, familyId, payload = {}) {
	const category = normalizeCategory(payload.category);
	const key =
		typeof payload.key === "string" && payload.key.trim()
			? payload.key.trim().slice(0, 120)
			: null;
	if (!key) throw new Error("A memory key is required");
	const value =
		typeof payload.value === "string" ? payload.value.slice(0, 2000) : null;
	const visibility = VISIBILITIES.has(payload.visibility) ? payload.visibility : "private";
	const source = SOURCES.has(payload.source) ? payload.source : "user";
	const confidence = Number.isFinite(payload.confidence)
		? Math.max(0, Math.min(100, Number(payload.confidence)))
		: null;
	const uuid = uuidv4();

	await pool.query(
		`INSERT INTO user_memory
     (uuid, profile_id, family_id, category, memory_key, memory_value, source, visibility, confidence, created_by_profile_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       memory_value = VALUES(memory_value),
       visibility = VALUES(visibility),
       source = VALUES(source),
       confidence = VALUES(confidence),
       deleted_at = NULL,
       updated_at = CURRENT_TIMESTAMP;`,
		[uuid, profileId, familyId, category, key, value, source, visibility, confidence, profileId]
	);

	const [rows] = await pool.query(
		`SELECT id, profile_id, uuid, category, memory_key, memory_value, source, visibility, confidence, created_at, updated_at
     FROM user_memory WHERE profile_id = ? AND category = ? AND memory_key = ? LIMIT 1;`,
		[profileId, category, key]
	);
	if (rows[0]) memoryEvents.emit("fact:written", rows[0]);
	return publicMemory(rows[0]);
}

/** Existing fact slot (any source) or null — lets AI extraction respect curated facts. */
async function getFactSlot(profileId, category, key) {
	const [rows] = await pool.query(
		`SELECT id, uuid, source, memory_value, deleted_at
     FROM user_memory WHERE profile_id = ? AND category = ? AND memory_key = ? LIMIT 1;`,
		[profileId, normalizeCategory(category), String(key).trim().slice(0, 120)]
	);
	return rows[0] || null;
}

/** Soft-delete facts by key (case-insensitive) — "forget that my…". Returns the count. */
async function forgetFactsByKey(profileId, keys = []) {
	let count = 0;
	for (const key of keys) {
		if (typeof key !== "string" || !key.trim()) continue;
		const [rows] = await pool.query(
			`SELECT id FROM user_memory WHERE profile_id = ? AND LOWER(memory_key) = LOWER(?) AND deleted_at IS NULL;`,
			[profileId, key.trim().slice(0, 120)]
		);
		for (const r of rows) {
			await pool.query(`UPDATE user_memory SET deleted_at = NOW() WHERE id = ?;`, [r.id]);
			memoryEvents.emit("fact:deleted", { id: r.id, profile_id: profileId });
			count += 1;
		}
	}
	return count;
}

/** Create or update a memory slot (unique per profile/category/key). */
async function upsertMemory(actor, payload = {}) {
	const { profileId, familyId } = await resolveProfileId(actor);
	return upsertMemoryForProfile(profileId, familyId, payload);
}

/** Soft-delete a memory by uuid (must belong to the actor). */
async function deleteMemory(actor, memoryUuid) {
	const { profileId } = await resolveProfileId(actor);
	const [rows] = await pool.query(
		`SELECT id FROM user_memory WHERE uuid = ? AND profile_id = ? AND deleted_at IS NULL LIMIT 1;`,
		[memoryUuid, profileId]
	);
	if (!rows.length) throw new Error("Memory not found");
	await pool.query(`UPDATE user_memory SET deleted_at = NOW() WHERE id = ?;`, [rows[0].id]);
	memoryEvents.emit("fact:deleted", { id: rows[0].id, profile_id: profileId });
	return { success: true };
}

/**
 * Compact prompt-ready summary of a profile's memories. Used by the
 * conversation prompt builder to personalize responses (companion mode).
 */
async function getMemorySummaryForProfileId(profileId, limit = 25) {
	if (!profileId) return [];
	const [rows] = await pool.query(
		`SELECT category, memory_key, memory_value
     FROM user_memory
     WHERE profile_id = ? AND deleted_at IS NULL
     ORDER BY updated_at DESC LIMIT ?;`,
		[profileId, Math.min(Number(limit) || 25, 50)]
	);
	return rows.map((r) => ({
		category: r.category,
		key: r.memory_key,
		value: r.memory_value,
	}));
}

module.exports = {
	CATEGORIES,
	VISIBILITIES,
	memoryEvents,
	resolveProfileId,
	listOwnMemory,
	listChildMemoryForParent,
	upsertMemory,
	upsertMemoryForProfile,
	getFactSlot,
	forgetFactsByKey,
	deleteMemory,
	getMemorySummaryForProfileId,
};
