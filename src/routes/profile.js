const express = require("express");
const {
	getProfile,
	createProfile,
	updateProfile,
} = require("../controllers/profile");

const router = express.Router();

router.get("/", getProfile);
router.post("/", createProfile);
router.put("/", updateProfile);

module.exports = router;
