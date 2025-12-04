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
		if (err.message?.includes("Invalid child id")) {
			return res.status(400).json({
				success: false,
				message: "Invalid child id",
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
};
