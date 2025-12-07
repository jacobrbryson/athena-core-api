const parentService = require("../services/parent");

async function getChildren(req, res) {
	try {
		const { googleId } = req.user;

		const children = await parentService.getChildrenByGoogleId(googleId);
		return res.status(200).json(children);
	} catch (err) {
		console.error("Error fetching children:", err);
		return res
			.status(500)
			.json({ success: false, message: "Failed to fetch children" });
	}
}

async function addChild(req, res) {
	try {
		const { googleId } = req.user;

		const child = await parentService.addChild(googleId, req.body || {});
		return res.status(201).json(child);
	} catch (err) {
		console.error("Error adding child:", err);
		if (
			err.message?.includes("Invalid child id") ||
			err.message?.includes("Invalid child email")
		) {
			return res.status(400).json({
				success: false,
				message: err.message?.includes("email")
					? "A valid child email is required to create a new child"
					: "Invalid child id",
			});
		}
		return res
			.status(500)
			.json({ success: false, message: "Failed to add child" });
	}
}

async function updateChild(req, res) {
	try {
		const { googleId } = req.user;

		const { childId } = req.params;
		const updated = await parentService.updateChild(
			googleId,
			childId,
			req.body || {}
		);
		return res.json(updated);
	} catch (err) {
		console.error("Error updating child:", err);
		if (err.message?.includes("No valid child fields provided")) {
			return res.status(400).json({
				success: false,
				message: "No valid child fields provided",
			});
		}
		return res
			.status(500)
			.json({ success: false, message: "Failed to update child" });
	}
}

async function deleteChild(req, res) {
	try {
		const { googleId } = req.user;

		const { childId } = req.params;
		await parentService.deleteChild(googleId, childId);
		return res.status(204).send();
	} catch (err) {
		console.error("Error deleting child:", err);
		if (err.message?.includes("Invalid child id")) {
			return res.status(400).json({
				success: false,
				message: "Invalid child id",
			});
		}
		return res
			.status(500)
			.json({ success: false, message: "Failed to delete child" });
	}
}

async function respondToChildInvite(req, res, action) {
	try {
		const { googleId } = req.user;

		const { childId } = req.params;
		const updated = await parentService.respondToInvite(
			googleId,
			childId,
			action
		);
		return res.json(updated);
	} catch (err) {
		console.error(`Error ${action} child invite:`, err);
		if (err.message?.includes("Invalid child id")) {
			return res.status(400).json({
				success: false,
				message: "Invalid child id",
			});
		}
		return res.status(500).json({
			success: false,
			message: `Failed to ${action} child invite`,
		});
	}
}

async function approveChild(req, res) {
	return respondToChildInvite(req, res, "approve");
}

async function denyChild(req, res) {
	return respondToChildInvite(req, res, "deny");
}

async function blockChild(req, res) {
	try {
		const { googleId } = req.user;

		const { childId } = req.params;
		const result = await parentService.blockChild(googleId, childId);
		return res.status(200).json(result);
	} catch (err) {
		console.error("Error blocking child:", err);
		if (err.message?.includes("Invalid child id")) {
			return res.status(400).json({
				success: false,
				message: "Invalid child id",
			});
		}
		return res
			.status(500)
			.json({ success: false, message: "Failed to block child" });
	}
}

async function getBlocklist(req, res) {
	try {
		const { googleId } = req.user;

		const blocked = await parentService.getBlocklist(googleId);
		return res.status(200).json(blocked);
	} catch (err) {
		console.error("Error fetching blocklist:", err);
		return res
			.status(500)
			.json({ success: false, message: "Failed to fetch blocklist" });
	}
}

async function unblockChild(req, res) {
	try {
		const { googleId } = req.user;

		const { childProfileId } = req.params;
		const addChild = Boolean(req.body?.add_child);
		const result = await parentService.unblockChild(
			googleId,
			childProfileId,
			{ addChild }
		);
		return res.status(200).json(result);
	} catch (err) {
		console.error("Error unblocking child:", err);
		if (err.message?.includes("Invalid child id")) {
			return res.status(400).json({
				success: false,
				message: "Invalid child id",
			});
		}
		return res
			.status(500)
			.json({ success: false, message: "Failed to unblock child" });
	}
}

async function getLearningGoals(req, res) {
	try {
		const { googleId } = req.user;
		const { childId } = req.params;
		const rawPage = parseInt(req.query.page, 10);
		const rawPageSize =
			parseInt(req.query.page_size, 10) || parseInt(req.query.pageSize, 10);
		const paginate =
			Number.isFinite(rawPage) || Number.isFinite(rawPageSize) || req.query.paginate === "true";
		const includeDeleted = req.query.include_deleted === "true";
		const activeOnly = req.query.active_only !== "false"; // default true
		const limit = parseInt(req.query.limit, 10);
		const orderBy = req.query.order_by || req.query.orderBy;

		const goals = await parentService.getLearningGoalsForChild(
			googleId,
			childId,
			{
				page: rawPage,
				pageSize: rawPageSize,
				paginate,
				includeDeleted,
				activeOnly,
				limit,
				orderBy,
			}
		);
		return res.status(200).json(goals);
	} catch (err) {
		console.error("Error fetching learning goals:", err);
		return res
			.status(500)
			.json({ success: false, message: "Failed to fetch learning goals" });
	}
}

async function addLearningGoal(req, res) {
	try {
		const { googleId } = req.user;
		const { childId } = req.params;
		const goal = await parentService.addLearningGoal(
			googleId,
			childId,
			req.body || {}
		);
		return res.status(201).json(goal);
	} catch (err) {
		console.error("Error adding learning goal:", err);
		if (err.message?.includes("topic is required")) {
			return res.status(400).json({ success: false, message: err.message });
		}
		if (err.message?.includes("Invalid learning goal id")) {
			return res.status(400).json({ success: false, message: err.message });
		}
		if (err.message?.includes("Child not found")) {
			return res.status(404).json({ success: false, message: err.message });
		}
		return res
			.status(500)
			.json({ success: false, message: "Failed to add learning goal" });
	}
}

async function deleteLearningGoal(req, res) {
	try {
		const { googleId } = req.user;
		const { childId, goalId } = req.params;
		const markComplete = req.query.mark_complete === "true";
		await parentService.deleteLearningGoal(googleId, childId, goalId, { markComplete });
		return res.status(204).send();
	} catch (err) {
		console.error("Error deleting learning goal:", err);
		if (err.message?.includes("Invalid learning goal id")) {
			return res.status(400).json({ success: false, message: err.message });
		}
		if (err.message?.includes("not found")) {
			return res.status(404).json({ success: false, message: err.message });
		}
		return res
			.status(500)
			.json({ success: false, message: "Failed to delete learning goal" });
	}
}

async function getChildActivity(req, res) {
	try {
		const { googleId } = req.user;
		const { childId } = req.params;
		const limit = parseInt(req.query.limit, 10);
		const items = await parentService.getActivityForChild(googleId, childId, {
			limit: Number.isFinite(limit) ? limit : undefined,
		});
		return res.status(200).json(items);
	} catch (err) {
		console.error("Error fetching child activity:", err);
		return res
			.status(500)
			.json({ success: false, message: "Failed to fetch activity" });
	}
}

async function getChildGuardians(req, res) {
	try {
		const { googleId } = req.user;
		const { childId } = req.params;
		const guardians = await parentService.getGuardiansForChild(
			googleId,
			childId
		);
		return res.status(200).json(guardians);
	} catch (err) {
		console.error("Error fetching child guardians:", err);
		if (err.message?.includes("Invalid child id")) {
			return res.status(400).json({
				success: false,
				message: "Invalid child id",
			});
		}
		if (err.message?.includes("Child not found")) {
			return res.status(404).json({
				success: false,
				message: "Child not found for this parent",
			});
		}
		return res.status(500).json({
			success: false,
			message: "Failed to fetch child guardians",
		});
	}
}

async function getChildSiblings(req, res) {
	try {
		const { googleId } = req.user;
		const { childId } = req.params;
		const siblings = await parentService.getSiblingsForChild(
			googleId,
			childId
		);
		return res.status(200).json(siblings);
	} catch (err) {
		console.error("Error fetching child siblings:", err);
		if (err.message?.includes("Invalid child id")) {
			return res.status(400).json({
				success: false,
				message: "Invalid child id",
			});
		}
		if (err.message?.includes("Child not found")) {
			return res.status(404).json({
				success: false,
				message: "Child not found for this parent",
			});
		}
		return res.status(500).json({
			success: false,
			message: "Failed to fetch child siblings",
		});
	}
}

module.exports = {
	getChildren,
	addChild,
	updateChild,
	deleteChild,
	approveChild,
	denyChild,
	blockChild,
	getBlocklist,
	unblockChild,
	getLearningGoals,
	addLearningGoal,
	deleteLearningGoal,
	getChildActivity,
	getChildGuardians,
	getChildSiblings,
};
