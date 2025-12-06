const pool = require("../helpers/db");

function buildFilters(filters = {}) {
	const conditions = [];
	const params = [];

	if (filters.age_range) {
		conditions.push("age_range = ?");
		params.push(filters.age_range);
	}
	if (filters.grade_range) {
		conditions.push("grade_range = ?");
		params.push(filters.grade_range);
	}
	if (filters.subject) {
		conditions.push("subject = ?");
		params.push(filters.subject);
	}

	const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
	return { where, params };
}

async function listCatalogGoals(filters = {}) {
	const { where, params } = buildFilters(filters);
	const [rows] = await pool.query(
		`SELECT id, topic, description, age_range, grade_range, subject, created_at, updated_at
     FROM learning_goal_catalog
     ${where}
     ORDER BY id ASC`,
		params
	);

	const ids = rows.map((r) => r.id);
	const targetsByGoal = {};

	if (ids.length) {
		const [targets] = await pool.query(
			`SELECT id, catalog_id, title, description, sort_order
       FROM learning_goal_target
       WHERE catalog_id IN (?)
       ORDER BY sort_order ASC, id ASC`,
			[ids]
		);
		for (const t of targets) {
			if (!targetsByGoal[t.catalog_id]) targetsByGoal[t.catalog_id] = [];
			targetsByGoal[t.catalog_id].push({
				id: t.id,
				title: t.title,
				description: t.description,
				sort_order: t.sort_order,
			});
		}
	}

	return rows.map((row) => ({
		...row,
		targets: targetsByGoal[row.id] || [],
	}));
}

async function getCatalogGoal(id) {
	const numericId = Number(id);
	if (!Number.isFinite(numericId)) return null;

	const [rows] = await pool.query(
		`SELECT id, topic, description, age_range, grade_range, subject, created_at, updated_at
     FROM learning_goal_catalog
     WHERE id = ?
     LIMIT 1`,
		[numericId]
	);

	if (!rows.length) return null;

	const goal = rows[0];
	const [targets] = await pool.query(
		`SELECT id, catalog_id, title, description, sort_order
     FROM learning_goal_target
     WHERE catalog_id = ?
     ORDER BY sort_order ASC, id ASC`,
		[goal.id]
	);

	return {
		...goal,
		targets: targets.map((t) => ({
			id: t.id,
			title: t.title,
			description: t.description,
			sort_order: t.sort_order,
		})),
	};
}

module.exports = {
	listCatalogGoals,
	getCatalogGoal,
};
