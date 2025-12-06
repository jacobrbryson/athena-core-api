const pool = require("../helpers/db");
const { buildUpdateClauses } = require("../helpers/query");
const { v4: uuidv4 } = require("uuid");
const {
	getProfileByGoogleId: getProfileByGoogleIdService,
	getProfileByEmail,
} = require("./profile");

const allowedChildFields = {
	full_name: "string",
	email: "string",
	birthday: "string",
	profile_editing_locked: "boolean",
	level: "number",
	level_progress: "number",
	wisdom_points: "number",
	mood: "string",
};

const childSelectColumns = `
  pc.id AS relationship_id,
  pc.parent_profile_id,
  pc.child_profile_id,
  pc.created_at AS relationship_created_at,
  pc.updated_at AS relationship_updated_at,
  pc.invited_at AS relationship_invited_at,
  pc.approved_at AS relationship_approved_at,
  pc.denied_at AS relationship_denied_at,
  pc.deleted_at AS relationship_deleted_at,
  child.uuid AS child_uuid,
  child.google_id AS child_google_id,
  child.full_name,
  child.email,
  child.birthday,
  child.picture,
  child.level,
  child.level_progress,
  child.wisdom_points,
  child.mood,
  child.profile_editing_locked,
  child.created_at AS child_created_at,
  child.updated_at AS child_updated_at
`;

function normalizeGoogleId(googleId) {
	if (googleId === undefined || googleId === null) return null;
	if (typeof googleId === "string") {
		const trimmed = googleId.trim();
		return trimmed.length ? trimmed : null;
	}
	if (typeof googleId === "number") {
		return String(googleId);
	}
	return null;
}

function normalizeUuid(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length ? trimmed : null;
}

function normalizeEmail(email) {
	if (typeof email !== "string") return null;
	const trimmed = email.trim().toLowerCase();
	if (!trimmed) return null;
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return emailRegex.test(trimmed) ? trimmed : null;
}

async function getProfileByGoogleId(googleId, conn = pool) {
	const normalized = normalizeGoogleId(googleId);
	if (normalized === null) {
		throw new Error("Invalid google_id");
	}

	const [rows] = await conn.query(
		`SELECT id, uuid, google_id FROM profile WHERE google_id = ? LIMIT 1;`,
		[normalized]
	);

	if (!rows.length) {
		throw new Error("Profile not found for provided google_id");
	}

	return rows[0];
}

function mapChildRow(row) {
	if (!row) return null;

	return {
		id: row.relationship_id,
		relationship_id: row.relationship_id,
		parent_profile_id: row.parent_profile_id,
		child_profile_id: row.child_profile_id,
		uuid: row.child_uuid,
		child_uuid: row.child_uuid,
		google_id: row.child_google_id,
		child_google_id: row.child_google_id,
		full_name: row.full_name,
		email: row.email,
		birthday: row.birthday,
		picture: row.picture,
		level: row.level,
		level_progress: row.level_progress,
		wisdom_points: row.wisdom_points,
		mood: row.mood,
		profile_editing_locked: Boolean(row.profile_editing_locked),
		created_at: row.child_created_at,
		updated_at: row.child_updated_at,
		deleted_at: row.relationship_deleted_at,
		relationship_created_at: row.relationship_created_at,
		relationship_updated_at: row.relationship_updated_at,
		invited_at: row.relationship_invited_at,
		approved_at: row.relationship_approved_at,
		denied_at: row.relationship_denied_at,
	};
}

function extractUpdatableFields(payload = {}) {
	const updates = {};
	for (const [field, expectedType] of Object.entries(allowedChildFields)) {
		const value = payload[field];
		if (typeof value === expectedType) {
			updates[field] = field === "birthday" ? value.slice(0, 10) : value;
		}
	}
	return updates;
}

function extractChildIdentifiers(payload = {}) {
	const childUuid =
		normalizeUuid(payload.child_uuid) ||
		normalizeUuid(payload.childUuid) ||
		normalizeUuid(payload.uuid);

	const childGoogleId =
		normalizeGoogleId(payload.child_google_id) ||
		normalizeGoogleId(payload.childGoogleId) ||
		normalizeGoogleId(payload.google_id);

	if (!childUuid && !childGoogleId) {
		throw new Error("A child identifier (child_uuid or child_google_id) is required.");
	}
	return { childUuid, childGoogleId };
}

async function withTransaction(fn) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const result = await fn(conn);
		await conn.commit();
		return result;
	} catch (err) {
		await conn.rollback();
		throw err;
	} finally {
		conn.release();
	}
}

async function syncHasGuardian(childProfileId, conn = pool) {
	const [rows] = await conn.query(
		`SELECT COUNT(*) AS cnt FROM profile_child WHERE child_profile_id = ? AND deleted_at IS NULL`,
		[childProfileId]
	);
	const count = rows?.[0]?.cnt || 0;
	const hasGuardian = count > 0 ? 1 : 0;
	await conn.query(`UPDATE profile SET has_guardian = ? WHERE id = ?`, [hasGuardian, childProfileId]);
	return hasGuardian === 1;
}

async function getChildProfile(childUuid, childGoogleId, conn = pool) {
	const conditions = [];
	const values = [];

	if (childUuid) {
		conditions.push("uuid = ?");
		values.push(childUuid);
	}

	if (childGoogleId) {
		conditions.push("google_id = ?");
		values.push(childGoogleId);
	}

	const [rows] = await conn.query(
		`SELECT id, uuid, google_id, full_name, email, birthday, created_at, updated_at
    FROM profile
    WHERE ${conditions.join(" OR ")}
    LIMIT 1;`,
		values
	);

	if (!rows.length) {
		throw new Error("Child profile not found");
	}

	return rows[0];
}

async function resolveChildProfileId(childIdentifier, conn = pool) {
	const numericId = Number(childIdentifier);
	if (Number.isFinite(numericId)) return numericId;

	const childUuid = normalizeUuid(childIdentifier);
	if (!childUuid) {
		throw new Error("Invalid child id");
	}

	const [rows] = await conn.query(`SELECT id FROM profile WHERE uuid = ? LIMIT 1;`, [childUuid]);
	if (!rows.length) {
		throw new Error("Invalid child id");
	}

	return rows[0].id;
}

async function getChildRelationship(parentProfileId, relationshipId, conn = pool) {
	const [rows] = await conn.query(
		`SELECT ${childSelectColumns}
    FROM profile_child pc
    JOIN profile child ON child.id = pc.child_profile_id
    WHERE pc.id = ? AND pc.parent_profile_id = ? AND pc.deleted_at IS NULL
    LIMIT 1;`,
		[relationshipId, parentProfileId]
	);

	return mapChildRow(rows[0]);
}

async function getChildRelationshipForParent(parentProfileId, childIdentifier, conn = pool) {
	const relationshipId = Number(childIdentifier);
	if (Number.isFinite(relationshipId)) {
		return getChildRelationship(parentProfileId, relationshipId, conn);
	}

	const childUuid = normalizeUuid(childIdentifier);
	if (!childUuid) {
		throw new Error("Invalid child id");
	}

	const [rows] = await conn.query(
		`SELECT ${childSelectColumns}
    FROM profile_child pc
    JOIN profile child ON child.id = pc.child_profile_id
    WHERE child.uuid = ? AND pc.parent_profile_id = ? AND pc.deleted_at IS NULL
    LIMIT 1;`,
		[childUuid, parentProfileId]
	);

	return mapChildRow(rows[0]);
}

async function ensureChildProfileByEmail(email, payload = {}, conn = pool) {
	const normalizedEmail = normalizeEmail(email);
	if (!normalizedEmail) {
		throw new Error("Invalid child email");
	}

	const existing = await getProfileByEmail(normalizedEmail);
	if (existing) return existing;

	const [result] = await conn.query(
		`INSERT INTO profile 
    (uuid, google_id, email, full_name, birthday, has_guardian, is_guardian, is_teacher, profile_editing_locked) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			uuidv4(),
			`child:${normalizedEmail}`,
			normalizedEmail,
			typeof payload.full_name === "string" ? payload.full_name : null,
			typeof payload.birthday === "string" ? payload.birthday.slice(0, 10) : null,
			true,
			false,
			false,
			false,
		]
	);

	const [rows] = await conn.query(
		`SELECT id, uuid, google_id, email, full_name, birthday, created_at, updated_at 
    FROM profile WHERE id = ? LIMIT 1;`,
		[result.insertId]
	);

	if (!rows.length) {
		throw new Error("Failed to create child profile");
	}

	return rows[0];
}

async function ensureChildProfileByGoogleId(googleId) {
	const profile = await getProfileByGoogleIdService(googleId);
	if (!profile) {
		throw new Error("Child profile not found for provided google_id");
	}
	return profile;
}

async function logChildActivity({
	childProfileId,
	parentProfileId,
	activity,
	tableName = null,
	recordId = null,
	actorProfileId = null,
}) {
	if (!childProfileId || !parentProfileId || !activity) return;
	await pool.query(
		`INSERT INTO child_activity
    (child_profile_id, parent_profile_id, activity, table_name, record_id, actor_profile_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NOW());`,
		[
			childProfileId,
			parentProfileId,
			activity,
			tableName,
			recordId,
			actorProfileId,
		]
	);
}

async function getProfileDisplayName(profileId, conn = pool) {
	if (!profileId) return "Parent";
	const [rows] = await conn.query(
		`SELECT full_name, email FROM profile WHERE id = ? LIMIT 1;`,
		[profileId]
	);
	return rows?.[0]?.full_name || rows?.[0]?.email || "Parent";
}

module.exports = {
	allowedChildFields,
	childSelectColumns,
	getProfileByGoogleId,
	normalizeEmail,
	normalizeGoogleId,
	normalizeUuid,
	mapChildRow,
	extractUpdatableFields,
	extractChildIdentifiers,
	withTransaction,
	syncHasGuardian,
	getChildProfile,
	resolveChildProfileId,
	getChildRelationship,
	getChildRelationshipForParent,
	ensureChildProfileByEmail,
	ensureChildProfileByGoogleId,
	logChildActivity,
	getProfileDisplayName,
};
