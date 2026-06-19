const { v4: uuidv4 } = require("uuid");
const pool = require("../helpers/db");
const { authorizeChildForParent, getFamilyForProfile } = require("./family");
const { getProfileByGoogleId } = require("./parent-helpers");

/**
 * Memory foundation service (Phase 7).
 *
 * Stores lightweight, structured facts about a user (interests, favorite
 * subjects, pets, family info, preferences). This is intentionally a simple
 * key/value-per-category store — NOT a full long-term memory / embedding
 * system. See docs/architecture/memory-foundation.md for the extension path.
 *
 * Each row is family-aware (family_id), user-specific (profile_id), and
 * privacy-aware (visibility: 'private' | 'family').
 */

const CATEGORIES = new Set([
	"interest",
	"subject",
	"pet",
	"family",
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
async function resolveProfileId({ googleId, profileUuid }) {
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
		`SELECT uuid, category, memory_key, memory_value, source, visibility, confidence, created_at, updated_at
     FROM user_memory WHERE profile_id = ? AND category = ? AND memory_key = ? LIMIT 1;`,
		[profileId, category, key]
	);
	return publicMemory(rows[0]);
}

/** Create or update a memory slot (unique per profile/category/key). */
async function upsertMemory(actor, payload = {}) {
	const { profileId, familyId } = await resolveProfileId(actor);
	return upsertMemoryForProfile(profileId, familyId, payload);
}

/** Soft-delete a memory by uuid (must belong to the actor). */
async function deleteMemory(actor, memoryUuid) {
	const { profileId } = await resolveProfileId(actor);
	const [result] = await pool.query(
		`UPDATE user_memory SET deleted_at = NOW() WHERE uuid = ? AND profile_id = ? AND deleted_at IS NULL;`,
		[memoryUuid, profileId]
	);
	if (!result.affectedRows) throw new Error("Memory not found");
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
	resolveProfileId,
	listOwnMemory,
	listChildMemoryForParent,
	upsertMemory,
	upsertMemoryForProfile,
	deleteMemory,
	getMemorySummaryForProfileId,
};
