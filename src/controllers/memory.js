const memoryService = require("../services/memory");

/** Build a memory-service actor descriptor from the authenticated user. */
function actorFromReq(req) {
	if (req.user?.kind === "child") {
		return { profileUuid: req.user.profileUuid };
	}
	return { googleId: req.user.googleId };
}

/** List the authenticated user's own memories (parent or child). */
async function listMine(req, res) {
	try {
		const memories = await memoryService.listOwnMemory(actorFromReq(req));
		return res.json(memories);
	} catch (err) {
		console.error("[memory] listMine", err.message);
		return res
			.status(500)
			.json({ success: false, message: "Failed to load memory" });
	}
}

async function upsertMine(req, res) {
	try {
		const memory = await memoryService.upsertMemory(
			actorFromReq(req),
			req.body || {}
		);
		return res.status(201).json({ success: true, memory });
	} catch (err) {
		console.error("[memory] upsertMine", err.message);
		const known = /required|Invalid|not found/i.test(err.message || "");
		return res
			.status(known ? 400 : 500)
			.json({ success: false, message: err.message || "Failed to save memory" });
	}
}

async function deleteMine(req, res) {
	try {
		const result = await memoryService.deleteMemory(
			actorFromReq(req),
			req.params.memoryUuid
		);
		return res.json(result);
	} catch (err) {
		console.error("[memory] deleteMine", err.message);
		const known = /not found/i.test(err.message || "");
		return res
			.status(known ? 404 : 500)
			.json({ success: false, message: err.message || "Failed to delete memory" });
	}
}

/** Parent view of a child's family-visible memories. */
async function listChild(req, res) {
	try {
		if (req.user?.kind === "child") {
			return res.status(403).json({ success: false, message: "Forbidden" });
		}
		const memories = await memoryService.listChildMemoryForParent(
			req.user.googleId,
			req.params.childUuid
		);
		return res.json(memories);
	} catch (err) {
		console.error("[memory] listChild", err.message);
		return res
			.status(400)
			.json({ success: false, message: err.message || "Failed to load child memory" });
	}
}

module.exports = { listMine, upsertMine, deleteMine, listChild };
