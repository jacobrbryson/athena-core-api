const express = require("express");
const {
	getFamily,
	createFamily,
	getChildren,
	createChild,
	authorizeSwitch,
	getPermissions,
	setPermission,
} = require("../controllers/family");
const {
	createCode,
	listCodes,
	revokeCode,
} = require("../controllers/childAuth");
const { listChild } = require("../controllers/memory");
const { requireParent } = require("../middleware/auth");

const router = express.Router();

router.use(requireParent);

// Family
router.get("/", getFamily);
router.post("/", createFamily);

// Permissions (parent-configurable AI / feature toggles)
router.get("/permissions", getPermissions);
router.put("/permissions", setPermission);

// Children
router.get("/children", getChildren);
router.post("/children", createChild);

// Profile switching (Phase 4)
router.post("/children/:childUuid/switch", authorizeSwitch);

// Child login codes (Phase 3)
router.get("/children/:childUuid/codes", listCodes);
router.post("/children/:childUuid/codes", createCode);
router.delete("/children/:childUuid/codes/:codeUuid", revokeCode);

// Child memory (parent view of family-visible memories)
router.get("/children/:childUuid/memory", listChild);

module.exports = router;
