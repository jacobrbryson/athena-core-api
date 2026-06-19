const express = require("express");
const { listMine, upsertMine, deleteMine } = require("../controllers/memory");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Accessible to both parents and child session tokens (own memory only).
router.use(requireAuth);

router.get("/", listMine);
router.post("/", upsertMine);
router.delete("/:memoryUuid", deleteMine);

module.exports = router;
