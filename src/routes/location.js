const express = require("express");
const { requireAuth, requireAuthOrDevice } = require("../middleware/auth");
const controller = require("../controllers/location");

const router = express.Router();
router.get("/pref", requireAuthOrDevice, controller.getPref);
router.put("/pref", requireAuth, express.json(), controller.setPref);
router.get("/recent", requireAuth, controller.recent);
router.post("/sample", requireAuthOrDevice, express.json({ limit: "4kb" }), controller.recordSample);
module.exports = router;
