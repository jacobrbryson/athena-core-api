const pool = require("../helpers/db");
const { sanitizePagination, sanitizeLimit, sanitizeOrderBy } = require("../helpers/query");
const {
	getChildRelationshipForParent,
	getProfileDisplayName,
	logChildActivity,
} = require("./parent-helpers");

async function getLearningGoalsForChild(googleId, parentService, childRelationshipId, options = {}) {
	const parentProfile = await parentService.getProfileByGoogleId(googleId);
	const relationship = await getChildRelationshipForParent(parentProfile.id, childRelationshipId);
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

async function addLearningGoal(googleId, parentService, childRelationshipId, payload = {}) {
	const parentProfile = await parentService.getProfileByGoogleId(googleId);
	const relationship = await getChildRelationshipForParent(parentProfile.id, childRelationshipId);
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
		activity: `"${goal.topic}" was added by ${await getProfileDisplayName(parentProfile.id)}`,
		tableName: "child_learning_goal",
		recordId: goal.id,
		actorProfileId: parentProfile.id,
	});

	return goal;
}

async function deleteLearningGoal(googleId, parentService, childRelationshipId, goalId, options = {}) {
	const parentProfile = await parentService.getProfileByGoogleId(googleId);
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

	await pool.query(`UPDATE child_learning_goal SET deleted_at = NOW() WHERE id = ?;`, [numericGoalId]);

	await logChildActivity({
		childProfileId: relationship.child_profile_id,
		parentProfileId: parentProfile.id,
		activity: `"${goalTopic}" was removed by ${await getProfileDisplayName(parentProfile.id)}`,
		tableName: "child_learning_goal",
		recordId: numericGoalId,
		actorProfileId: parentProfile.id,
	});

	return { success: true };
}

module.exports = {
	getLearningGoalsForChild,
	addLearningGoal,
	deleteLearningGoal,
};
