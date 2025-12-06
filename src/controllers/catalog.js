const catalogService = require("../services/catalog");

async function listGoals(req, res) {
	try {
		const filters = {
			age_range: req.query.age_range,
			grade_range: req.query.grade_range,
			subject: req.query.subject,
		};
		const goals = await catalogService.listCatalogGoals(filters);
		return res.status(200).json(goals);
	} catch (err) {
		console.error("Error listing catalog goals:", err);
		return res
			.status(500)
			.json({ success: false, message: "Failed to list catalog goals" });
	}
}

async function getGoal(req, res) {
	try {
		const goal = await catalogService.getCatalogGoal(req.params.id);
		if (!goal) {
			return res.status(404).json({ success: false, message: "Goal not found" });
		}
		return res.status(200).json(goal);
	} catch (err) {
		console.error("Error fetching catalog goal:", err);
		return res
			.status(500)
			.json({ success: false, message: "Failed to fetch catalog goal" });
	}
}

module.exports = {
	listGoals,
	getGoal,
};
