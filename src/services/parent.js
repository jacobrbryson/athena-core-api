const pool = require("../helpers/db");
const { buildUpdateClauses } = require("../helpers/query");
const { v4: uuidv4 } = require("uuid");
const {
	getProfileByGoogleId: getProfileByGoogleIdService,
	getProfileByEmail,
} = require("./profile");
const { publicChild } = require("../helpers/serialize");

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
		throw new Error(
			"A child identifier (child_uuid or child_google_id) is required."
		);
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

async function syncHasGuardian(childProfileId, conn = pool) {
	const [rows] = await conn.query(
		`SELECT COUNT(*) AS cnt FROM profile_child WHERE child_profile_id = ? AND deleted_at IS NULL`,
		[childProfileId]
	);
	const count = rows?.[0]?.cnt || 0;
	const hasGuardian = count > 0 ? 1 : 0;
	await conn.query(
		`UPDATE profile SET has_guardian = ? WHERE id = ?`,
		[hasGuardian, childProfileId]
	);
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

	const [rows] = await conn.query(
		`SELECT id FROM profile WHERE uuid = ? LIMIT 1;`,
		[childUuid]
	);

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
			typeof payload.birthday === "string"
				? payload.birthday.slice(0, 10)
				: null,
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

async function getChildRelationshipForParent(
	parentProfileId,
	childIdentifier,
	conn = pool
) {
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

async function getChildrenByGoogleId(googleId) {
	const parentProfile = await getProfileByGoogleId(googleId);

	const [rows] = await pool.query(
		`SELECT ${childSelectColumns}
    FROM profile_child pc
    JOIN profile child ON child.id = pc.child_profile_id
    WHERE pc.parent_profile_id = ? AND pc.deleted_at IS NULL
    ORDER BY pc.created_at DESC;`,
		[parentProfile.id]
	);

	return rows
		.map(mapChildRow)
		.filter(Boolean)
		.map((child) => publicChild(child));
}

async function addChild(googleId, payload = {}) {
	return withTransaction(async (conn) => {
		const parentProfile = await getProfileByGoogleId(googleId, conn);
		let childProfile = null;

		try {
			const { childUuid, childGoogleId } = extractChildIdentifiers(payload);
			childProfile = await getChildProfile(
				childUuid,
				childGoogleId,
				conn
			);
		} catch (err) {
			// If no identifier was provided, allow creation via email.
			if (err.message?.includes("child identifier")) {
				if (!payload.email) {
					throw new Error("Invalid child email");
				}
				childProfile = await ensureChildProfileByEmail(
					payload.email,
					payload,
					conn
				);
			} else {
				throw err;
			}
		}

	const [existing] = await conn.query(
		`SELECT id, deleted_at FROM profile_child WHERE parent_profile_id = ? AND child_profile_id = ? LIMIT 1;`,
		[parentProfile.id, childProfile.id]
	);

	if (existing.length && existing[0].deleted_at === null) {
		throw new Error("Child is already linked to this parent");
	}

		const updates = extractUpdatableFields(payload);
		if (Object.keys(updates).length) {
			const { setClauses, values } = buildUpdateClauses(
				updates,
				allowedChildFields
			);

			await conn.query(
				`UPDATE profile SET ${setClauses} WHERE id = ?`,
				[...values, childProfile.id]
			);
		}

		const [result] = await conn.query(
			`INSERT INTO profile_child (parent_profile_id, child_profile_id, deleted_at)
    VALUES (?, ?, NULL)
    ON DUPLICATE KEY UPDATE deleted_at = NULL, invited_at = NULL, approved_at = NULL, denied_at = NULL;`,
			[parentProfile.id, childProfile.id]
		);
		await syncHasGuardian(childProfile.id, conn);

		const relationshipId =
			result.insertId || existing[0]?.id;
		const relationship = await getChildRelationship(
			parentProfile.id,
			relationshipId,
			conn
		);
		return publicChild(relationship);
	});
}

async function updateChild(googleId, childRelationshipId, payload = {}) {
	const parentProfile = await getProfileByGoogleId(googleId);

	const relationship = await getChildRelationshipForParent(
		parentProfile.id,
		childRelationshipId
	);
	if (!relationship) {
		throw new Error("Child not found for this parent");
	}

	const updates = extractUpdatableFields(payload);
	if (!Object.keys(updates).length) {
		throw new Error("No valid child fields provided to update.");
	}

	const { setClauses, values } = buildUpdateClauses(
		updates,
		allowedChildFields
	);

	await pool.query(
		`UPDATE profile SET ${setClauses} WHERE id = ?`,
		[...values, relationship.child_profile_id]
	);

	const updated = await getChildRelationship(
		parentProfile.id,
		relationship.relationship_id
	);
	return publicChild(updated);
}

async function deleteChild(googleId, childRelationshipId) {
	return withTransaction(async (conn) => {
		const parentProfile = await getProfileByGoogleId(googleId, conn);

		const relationship = await getChildRelationshipForParent(
			parentProfile.id,
			childRelationshipId,
			conn
		);
		if (!relationship) {
			throw new Error("Child not found for this parent");
		}

		await conn.query(
			`UPDATE profile_child SET deleted_at = NOW() WHERE id = ? AND parent_profile_id = ?`,
			[relationship.relationship_id, parentProfile.id]
		);

		await syncHasGuardian(relationship.child_profile_id, conn);

		return { success: true };
	});
}

async function isBlocked(parentProfileId, childProfileId) {
	const [rows] = await pool.query(
		`SELECT 1 FROM parent_child_blocklist WHERE parent_profile_id = ? AND child_profile_id = ? LIMIT 1;`,
		[parentProfileId, childProfileId]
	);

	return rows.length > 0;
}

async function getBlocklist(googleId) {
	const parentProfile = await getProfileByGoogleId(googleId);

	const [rows] = await pool.query(
		`SELECT 
      b.parent_profile_id,
      b.child_profile_id,
      b.child_email,
      b.blocked_at,
      child.uuid AS child_uuid,
      child.google_id AS child_google_id,
      child.full_name,
      child.email
    FROM parent_child_blocklist b
    LEFT JOIN profile child ON child.id = b.child_profile_id
    WHERE b.parent_profile_id = ?
    ORDER BY b.blocked_at DESC;`,
		[parentProfile.id]
	);

	return rows.map((row) => ({
		child_uuid: row.child_uuid,
		child_google_id: row.child_google_id,
		full_name: row.full_name,
		email: row.email || row.child_email,
		blocked_at: row.blocked_at,
	}));
}

async function blockChild(googleId, childRelationshipId) {
	return withTransaction(async (conn) => {
		const parentProfile = await getProfileByGoogleId(googleId, conn);

		const relationship = await getChildRelationshipForParent(
			parentProfile.id,
			childRelationshipId,
			conn
		);
		if (!relationship) {
			throw new Error("Child not found for this parent");
		}

		const childEmail = normalizeEmail(relationship.email);

		await conn.query(
			`INSERT INTO parent_child_blocklist (parent_profile_id, child_profile_id, child_email, blocked_at)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE blocked_at = NOW(), child_email = VALUES(child_email);`,
			[parentProfile.id, relationship.child_profile_id, childEmail]
		);

		await conn.query(
			`UPDATE profile_child SET deleted_at = NOW() WHERE id = ? AND parent_profile_id = ?`,
			[relationship.relationship_id, parentProfile.id]
		);

		await syncHasGuardian(relationship.child_profile_id, conn);

		return { success: true, blocked: true };
	});
}

async function unblockChild(googleId, childProfileId, options = {}) {
	return withTransaction(async (conn) => {
		const parentProfile = await getProfileByGoogleId(googleId, conn);
		const childProfileIdNumber = await resolveChildProfileId(
			childProfileId,
			conn
		);

		await conn.query(
			`DELETE FROM parent_child_blocklist WHERE parent_profile_id = ? AND child_profile_id = ?`,
			[parentProfile.id, childProfileIdNumber]
		);

		if (options.addChild) {
			await conn.query(
				`INSERT INTO profile_child (parent_profile_id, child_profile_id, invited_at, approved_at, denied_at, deleted_at)
       VALUES (?, ?, NOW(), NOW(), NULL, NULL)
       ON DUPLICATE KEY UPDATE invited_at = VALUES(invited_at), approved_at = VALUES(approved_at), denied_at = NULL, deleted_at = NULL;`,
				[parentProfile.id, childProfileIdNumber]
			);

			await syncHasGuardian(childProfileIdNumber, conn);

			return { success: true, unblocked: true, added: true };
		}

		return { success: true, unblocked: true };
	});
}

function normalizeEmail(email) {
	if (typeof email !== "string") return null;
	const trimmed = email.trim().toLowerCase();
	if (!trimmed) return null;
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return emailRegex.test(trimmed) ? trimmed : null;
}

async function ensureChildProfileByGoogleId(googleId) {
	const profile = await getProfileByGoogleIdService(googleId);
	if (!profile) {
		throw new Error("Child profile not found for provided google_id");
	}
	return profile;
}

async function ensureParentProfileByEmail(email, conn = pool) {
	const normalizedEmail = normalizeEmail(email);
	if (!normalizedEmail) {
		throw new Error("Invalid parent email");
	}

	const existingByEmail = await getProfileByEmail(normalizedEmail);
	if (existingByEmail) return existingByEmail;

	const syntheticGoogleId = `invite:${normalizedEmail}`;
	const [result] = await conn.query(
		`INSERT INTO profile 
    (uuid, google_id, email, full_name, picture, birthday, has_guardian, is_guardian, is_teacher) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			uuidv4(),
			syntheticGoogleId,
			normalizedEmail,
			null,
			null,
			null,
			null,
			true,
			false,
		]
	);

	const [rows] = await conn.query(
		`SELECT id, uuid, google_id, email, full_name, birthday, created_at, updated_at 
    FROM profile WHERE id = ? LIMIT 1;`,
		[result.insertId]
	);

	if (!rows.length) {
		throw new Error("Failed to create parent profile");
	}

	return rows[0];
}

async function inviteParentByEmail(childGoogleId, parentEmail) {
	const childProfile = await ensureChildProfileByGoogleId(childGoogleId);
	const parentProfile = await ensureParentProfileByEmail(parentEmail);

	// If this parent has blocked this child, treat the request as accepted but do not surface it.
	if (await isBlocked(parentProfile.id, childProfile.id)) {
		return { success: true, blocked: true };
	}

		await pool.query(
			`INSERT INTO profile_child (parent_profile_id, child_profile_id, invited_at, approved_at, denied_at, deleted_at)
    VALUES (?, ?, NOW(), NULL, NULL, NULL)
    ON DUPLICATE KEY UPDATE invited_at = NOW(), approved_at = NULL, denied_at = NULL, deleted_at = NULL;`,
			[parentProfile.id, childProfile.id]
		);

	await syncHasGuardian(childProfile.id);

	return {
		success: true,
		child_uuid: childProfile.uuid,
	};
}

async function respondToInvite(googleId, childRelationshipId, action) {
	return withTransaction(async (conn) => {
		const parentProfile = await getProfileByGoogleId(googleId, conn);

		const relationship = await getChildRelationshipForParent(
			parentProfile.id,
			childRelationshipId,
			conn
		);
		if (!relationship) {
			throw new Error("Child not found for this parent");
		}

		let approvedAt = null;
		let deniedAt = null;

		if (action === "approve") {
			approvedAt = new Date();
		} else if (action === "deny") {
			deniedAt = new Date();
		} else {
			throw new Error("Invalid action");
		}

		await conn.query(
			`UPDATE profile_child 
    SET approved_at = ?, denied_at = ?, invited_at = COALESCE(invited_at, NOW()), deleted_at = NULL
    WHERE id = ? AND parent_profile_id = ?`,
			[approvedAt, deniedAt, relationship.relationship_id, parentProfile.id]
		);

		if (action === "approve") {
			await conn.query(
				`UPDATE profile SET has_guardian = 1 WHERE id = (SELECT child_profile_id FROM profile_child WHERE id = ?)`,
				[relationship.relationship_id]
			);
		}

		const updated = await getChildRelationship(
			parentProfile.id,
			relationship.relationship_id,
			conn
		);
		return publicChild(updated);
	});
}

async function getLearningGoalsForChild(
	googleId,
	childRelationshipId,
	options = {}
) {
	const parentProfile = await getProfileByGoogleId(googleId);
	const relationship = await getChildRelationshipForParent(
		parentProfile.id,
		childRelationshipId
	);
	if (!relationship) {
		throw new Error("Child not found for this parent");
	}

	const rawPage = Number(options.page);
	const rawPageSize = Number(options.pageSize || options.page_size);
	const paginated =
		Number.isFinite(rawPage) || Number.isFinite(rawPageSize) || options.paginate === true;
	const includeDeleted = options.includeDeleted === true;
	const activeOnly = options.activeOnly === true;

	const conditions = ["child_profile_id = ?", "parent_profile_id = ?"];
	const params = [relationship.child_profile_id, parentProfile.id];

	if (!includeDeleted) {
		conditions.push("deleted_at IS NULL");
	}

	if (activeOnly) {
		conditions.push("(progress IS NULL OR progress < 100)");
		conditions.push("(status IS NULL OR status NOT IN ('completed', 'complete'))");
	}

	if (!paginated) {
		const [rows] = await pool.query(
			`SELECT id, topic, progress, status, created_by, created_at, updated_at
     FROM child_learning_goal
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC;`,
			params
		);

		return rows.map((row) => ({
			id: row.id,
			topic: row.topic,
			progress: row.progress ?? 0,
			status: includeDeleted && row.deleted_at ? "removed" : row.status || "active",
			created_by: row.created_by || null,
			created_at: row.created_at,
			updated_at: row.updated_at,
		}));
	}

	const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
	const pageSize =
		Number.isFinite(rawPageSize) && rawPageSize > 0
			? Math.min(rawPageSize, 100)
			: 10;
	const offset = (page - 1) * pageSize;

	const [[countRow]] = await pool.query(
		`SELECT COUNT(*) AS total
     FROM child_learning_goal
     WHERE ${conditions.join(" AND ")};`,
		params
	);

	const total = Number(countRow?.total || 0);

	const paginatedParams = [...params, pageSize, offset];

	const [rows] = await pool.query(
		`SELECT id, topic, progress, status, created_by, created_at, updated_at, deleted_at
     FROM child_learning_goal
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?;`,
		paginatedParams
	);

	return {
		items: rows.map((row) => ({
			id: row.id,
			topic: row.topic,
			progress: row.progress ?? 0,
			status: includeDeleted && row.deleted_at ? "removed" : row.status || "active",
			created_by: row.created_by || null,
			created_at: row.created_at,
			updated_at: row.updated_at,
		})),
		total,
		page,
		pageSize,
	};
}

async function addLearningGoal(googleId, childRelationshipId, payload = {}) {
	const parentProfile = await getProfileByGoogleId(googleId);
	const relationship = await getChildRelationshipForParent(
		parentProfile.id,
		childRelationshipId
	);
	if (!relationship) {
		throw new Error("Child not found for this parent");
	}

	const topic =
		typeof payload.topic === "string" ? payload.topic.trim().slice(0, 255) : "";
	if (!topic) {
		throw new Error("A topic is required for a learning goal");
	}

	const progress = Number.isFinite(payload.progress)
		? Math.max(0, Math.min(100, Number(payload.progress)))
		: 0;
	const status =
		typeof payload.status === "string" && payload.status.trim().length
			? payload.status.trim().toLowerCase().slice(0, 32)
			: "active";
	const createdBy =
		typeof payload.created_by === "string" && ["parent", "child", "teacher"].includes(payload.created_by)
			? payload.created_by
			: "parent";

	const [result] = await pool.query(
		`INSERT INTO child_learning_goal
     (child_profile_id, parent_profile_id, topic, progress, status, created_by, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), NULL);`,
		[relationship.child_profile_id, parentProfile.id, topic, progress, status, createdBy]
	);

	const [rows] = await pool.query(
		`SELECT id, topic, progress, status, created_by, created_at, updated_at
     FROM child_learning_goal
     WHERE id = ? AND deleted_at IS NULL
     LIMIT 1;`,
		[result.insertId]
	);

	if (!rows.length) {
		throw new Error("Failed to create learning goal");
	}

	return {
		id: rows[0].id,
		topic: rows[0].topic,
		progress: rows[0].progress ?? 0,
		status: rows[0].status || "active",
		created_by: rows[0].created_by || createdBy,
		created_at: rows[0].created_at,
		updated_at: rows[0].updated_at,
	};
}

async function deleteLearningGoal(googleId, childRelationshipId, goalId) {
	const parentProfile = await getProfileByGoogleId(googleId);
	const relationship = await getChildRelationshipForParent(
		parentProfile.id,
		childRelationshipId
	);
	if (!relationship) {
		throw new Error("Child not found for this parent");
	}

	const numericGoalId = Number(goalId);
	if (!Number.isFinite(numericGoalId)) {
		throw new Error("Invalid learning goal id");
	}

	const [rows] = await pool.query(
		`SELECT id FROM child_learning_goal 
     WHERE id = ? AND child_profile_id = ? AND parent_profile_id = ? AND deleted_at IS NULL
     LIMIT 1;`,
		[numericGoalId, relationship.child_profile_id, parentProfile.id]
	);
	if (!rows.length) {
		throw new Error("Learning goal not found for this child");
	}

	await pool.query(
		`UPDATE child_learning_goal SET deleted_at = NOW() WHERE id = ?;`,
		[numericGoalId]
	);

	return { success: true };
}

async function getActivityForChild(googleId, childRelationshipId) {
	const parentProfile = await getProfileByGoogleId(googleId);
	const relationship = await getChildRelationshipForParent(
		parentProfile.id,
		childRelationshipId
	);
	if (!relationship) {
		throw new Error("Child not found for this parent");
	}

	const [rows] = await pool.query(
		`SELECT id, activity, created_at
     FROM child_activity
     WHERE child_profile_id = ? AND parent_profile_id = ?
     ORDER BY created_at DESC
     LIMIT 50;`,
		[relationship.child_profile_id, parentProfile.id]
	);

	return rows.map((row) => ({
		id: row.id,
		activity: row.activity,
		time: row.created_at,
	}));
}

module.exports = {
	getChildrenByGoogleId,
	addChild,
	updateChild,
	deleteChild,
	blockChild,
	getBlocklist,
	unblockChild,
	respondToInvite,
	inviteParentByEmail,
	getLearningGoalsForChild,
	addLearningGoal,
	deleteLearningGoal,
	getActivityForChild,
};
