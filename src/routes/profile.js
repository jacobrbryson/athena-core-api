const express = require("express");
const {
	getProfile,
	createProfile,
	updateProfile,
	inviteParent,
	getGuardians,
} = require("../controllers/profile");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

router.get("/", getProfile);
router.post("/", createProfile);
router.put("/", updateProfile);
router.post("/invite-parent", inviteParent);
router.get("/guardians", getGuardians);

module.exports = router;
