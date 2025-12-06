const express = require("express");
const { listGoals, getGoal } = require("../controllers/catalog");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

router.get("/learning-goals", listGoals);
router.get("/learning-goals/:id", getGoal);

module.exports = router;
