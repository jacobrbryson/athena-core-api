const express = require("express");
const { requireAuthOrDevice } = require("../middleware/auth");
const controller = require("../controllers/minecraft");

const router = express.Router();
router.post("/chat", requireAuthOrDevice, express.json({ limit: "2kb" }), controller.chat);
module.exports = router;
