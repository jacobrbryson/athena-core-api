const express = require("express");
const {
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
} = require("../controllers/parent");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

router.get("/children", getChildren);
router.post("/children", addChild);
router.put("/children/:childId", updateChild);
router.delete("/children/:childId", deleteChild);
router.post("/children/:childId/approve", approveChild);
router.post("/children/:childId/deny", denyChild);
router.post("/children/:childId/block", blockChild);
router.get("/children/:childId/goals", getLearningGoals);
router.post("/children/:childId/goals", addLearningGoal);
router.delete("/children/:childId/goals/:goalId", deleteLearningGoal);
router.get("/children/:childId/activity", getChildActivity);
router.get("/children/:childId/guardians", getChildGuardians);
router.get("/children/:childId/siblings", getChildSiblings);
router.get("/blocklist", getBlocklist);
router.post("/blocklist/:childProfileId/unblock", unblockChild);

module.exports = router;
