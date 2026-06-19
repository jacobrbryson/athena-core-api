const familyService = require("../services/family");
const permissionService = require("../services/familyPermissions");

function handleError(res, err, fallback = "Request failed") {
	const message = err?.message || fallback;
	const known = [
		"No family found",
		"Child not found",
		"Profile not found",
		"Invalid",
		"required",
	].some((m) => message.includes(m));
	console.error("[family controller]", message);
	return res.status(known ? 400 : 500).json({ success: false, message });
}

async function getFamily(req, res) {
	try {
		const context = await familyService.getFamilyContext(req.user.googleId);
		return res.json(context);
	} catch (err) {
		return handleError(res, err, "Failed to load family");
	}
}

async function createFamily(req, res) {
	try {
		const family = await familyService.createFamily(
			req.user.googleId,
			req.body || {}
		);
		return res.status(201).json({ success: true, family });
	} catch (err) {
		return handleError(res, err, "Failed to create family");
	}
}

async function getChildren(req, res) {
	try {
		const children = await familyService.getChildrenForParent(
			req.user.googleId
		);
		return res.json(children);
	} catch (err) {
		return handleError(res, err, "Failed to load children");
	}
}

async function createChild(req, res) {
	try {
		const child = await familyService.createChild(
			req.user.googleId,
			req.body || {}
		);
		return res.status(201).json({ success: true, child });
	} catch (err) {
		return handleError(res, err, "Failed to create child");
	}
}

/**
 * Phase 4 — profile switching. A parent requests a child session token so
 * they can view / troubleshoot the child experience without a separate
 * Google account. The actual JWT is minted by the proxy (which captures the
 * real client IP); this endpoint authorizes the switch and returns the
 * child identity the proxy needs.
 */
async function authorizeSwitch(req, res) {
	try {
		const childUuid = req.params.childUuid || req.body?.child_uuid;
		const { child, family } = await familyService.authorizeChildForParent(
			req.user.googleId,
			childUuid
		);
		return res.json({
			success: true,
			child: {
				profile_uuid: child.profile_uuid,
				child_uuid: child.child_uuid,
				display_name: child.display_name,
				family_uuid: family.uuid,
			},
		});
	} catch (err) {
		return handleError(res, err, "Unable to switch profile");
	}
}

async function getPermissions(req, res) {
	try {
		const perms = await permissionService.getPermissions(
			req.user.googleId,
			req.query.child_uuid || null
		);
		return res.json(perms);
	} catch (err) {
		return handleError(res, err, "Failed to load permissions");
	}
}

async function setPermission(req, res) {
	try {
		const perms = await permissionService.setPermission(
			req.user.googleId,
			req.body || {}
		);
		return res.json({ success: true, ...perms });
	} catch (err) {
		return handleError(res, err, "Failed to update permission");
	}
}

module.exports = {
	getFamily,
	createFamily,
	getChildren,
	createChild,
	authorizeSwitch,
	getPermissions,
	setPermission,
};
