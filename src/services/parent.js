const { buildUpdateClauses, sanitizePagination, sanitizeLimit, sanitizeOrderBy } = require("../helpers/query");
const { publicChild } = require("../helpers/serialize");
const {
	allowedChildFields,
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
	childSelectColumns,
	getProfileByGoogleId,
} = require("./parent-helpers");
const pool = require("../helpers/db");

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
	const limit = sanitizeLimit(options.limit, 200, paginated ? null : null);
	const orderByRaw = options.orderBy || options.order_by;
	const orderClause = sanitizeOrderBy(
		orderByRaw,
		{
			progress_desc: "progress DESC, created_at DESC",
			created_at: "created_at DESC",
		},
		"created_at DESC"
	);

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
			`SELECT g.id, g.topic, g.progress, g.status, g.created_by, g.created_by_profile_id, g.created_at, g.updated_at,
            creator.email AS created_by_email
     FROM child_learning_goal g
     LEFT JOIN profile creator ON creator.id = g.created_by_profile_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY ${orderClause}
     ${limit ? "LIMIT ?" : ""};`,
			limit ? [...params, limit] : params
		);

		return rows.map((row) => ({
			id: row.id,
			topic: row.topic,
			progress: row.progress ?? 0,
			status: includeDeleted && row.deleted_at ? "removed" : row.status || "active",
			created_by: row.created_by || null,
			created_by_profile_id: row.created_by_profile_id || null,
			created_at: row.created_at,
			updated_at: row.updated_at,
		}));
	}

	const { page, pageSize, offset } = sanitizePagination(
		{ page: rawPage, pageSize: rawPageSize },
		{ defaultPageSize: 10, maxPageSize: 100 }
	);

	const [[countRow]] = await pool.query(
		`SELECT COUNT(*) AS total
     FROM child_learning_goal
     WHERE ${conditions.join(" AND ")};`,
		params
	);

	const total = Number(countRow?.total || 0);

	const paginatedParams = [...params, pageSize, offset];

	const [rows] = await pool.query(
		`SELECT g.id, g.topic, g.progress, g.status, g.created_by, g.created_by_profile_id, g.created_at, g.updated_at, g.deleted_at,
        creator.email AS created_by_email
     FROM child_learning_goal g
     LEFT JOIN profile creator ON creator.id = g.created_by_profile_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY ${orderClause}
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
			created_by_profile_id: row.created_by_profile_id || null,
			created_by_email: row.created_by_email || null,
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
	const rawStatus =
		typeof payload.status === "string" && payload.status.trim().length
			? payload.status.trim().toLowerCase().slice(0, 32)
			: "active";
	const status = progress >= 100 ? "completed" : rawStatus;
	const createdBy =
		typeof payload.created_by === "string" && ["parent", "child", "teacher"].includes(payload.created_by)
			? payload.created_by
			: "parent";
	const createdByProfileId =
		Number.isFinite(payload.created_by_profile_id) && payload.created_by_profile_id > 0
			? Number(payload.created_by_profile_id)
			: parentProfile.id;

	const [result] = await pool.query(
		`INSERT INTO child_learning_goal
     (child_profile_id, parent_profile_id, topic, progress, status, created_by, created_by_profile_id, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NULL);`,
		[
			relationship.child_profile_id,
			parentProfile.id,
			topic,
			progress,
			status,
			createdBy,
			createdByProfileId,
		]
	);

	const [rows] = await pool.query(
		`SELECT g.id, g.topic, g.progress, g.status, g.created_by, g.created_by_profile_id, g.created_at, g.updated_at,
        creator.email AS created_by_email
     FROM child_learning_goal g
     LEFT JOIN profile creator ON creator.id = g.created_by_profile_id
     WHERE g.id = ? AND g.deleted_at IS NULL
     LIMIT 1;`,
		[result.insertId]
	);

	if (!rows.length) {
		throw new Error("Failed to create learning goal");
	}

	const goal = {
		id: rows[0].id,
		topic: rows[0].topic,
		progress: rows[0].progress ?? 0,
		status: rows[0].status || "active",
		created_by: rows[0].created_by || createdBy,
		created_by_profile_id: rows[0].created_by_profile_id || createdByProfileId,
		created_by_email: rows[0].created_by_email || null,
		created_at: rows[0].created_at,
		updated_at: rows[0].updated_at,
	};

	await logChildActivity({
		childProfileId: relationship.child_profile_id,
		parentProfileId: parentProfile.id,
		activity: `"${goal.topic}" was added by ${await getProfileDisplayName(
			parentProfile.id
		)}`,
		tableName: "child_learning_goal",
		recordId: goal.id,
		actorProfileId: parentProfile.id,
	});

	return goal;
}

async function deleteLearningGoal(googleId, childRelationshipId, goalId, options = {}) {
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
		`SELECT id, topic, progress, status FROM child_learning_goal 
     WHERE id = ? AND child_profile_id = ? AND parent_profile_id = ? AND deleted_at IS NULL
     LIMIT 1;`,
		[numericGoalId, relationship.child_profile_id, parentProfile.id]
	);
	if (!rows.length) {
		throw new Error("Learning goal not found for this child");
	}
	const goalTopic = rows[0]?.topic || `Learning goal #${numericGoalId}`;
	const goalProgress = Number(rows[0]?.progress) || 0;
	const markComplete = options.markComplete === true || goalProgress >= 100;

	if (markComplete) {
		await pool.query(
			`UPDATE child_learning_goal SET status = 'completed', progress = LEAST(COALESCE(progress, 0), 100) WHERE id = ?;`,
			[numericGoalId]
		);
	}

	await pool.query(
		`UPDATE child_learning_goal SET deleted_at = NOW() WHERE id = ?;`,
		[numericGoalId]
	);

	await logChildActivity({
		childProfileId: relationship.child_profile_id,
		parentProfileId: parentProfile.id,
		activity: `"${goalTopic}" was removed by ${await getProfileDisplayName(
			parentProfile.id
		)}`,
		tableName: "child_learning_goal",
		recordId: numericGoalId,
		actorProfileId: parentProfile.id,
	});

	return { success: true };
}

async function getActivityForChild(googleId, childRelationshipId, options = {}) {
	const parentProfile = await getProfileByGoogleId(googleId);
	const relationship = await getChildRelationshipForParent(
		parentProfile.id,
		childRelationshipId
	);
	if (!relationship) {
		throw new Error("Child not found for this parent");
	}

	const limit = sanitizeLimit(options.limit, 200, 50);

	const [rows] = await pool.query(
		`SELECT ca.id,
            ca.activity,
            ca.created_at,
            ca.actor_profile_id,
            actor.full_name AS actor_name,
            actor.email AS actor_email
     FROM child_activity ca
     LEFT JOIN profile actor ON actor.id = ca.actor_profile_id
     WHERE ca.child_profile_id = ? AND ca.parent_profile_id = ?
     ORDER BY ca.created_at DESC
     LIMIT ?;`,
		[relationship.child_profile_id, parentProfile.id, limit]
	);

	return rows.map((row) => ({
		id: row.id,
		activity: row.activity,
		time: row.created_at,
		actor_profile_id: row.actor_profile_id,
		actor_name: row.actor_name || null,
		actor_email: row.actor_email || null,
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
