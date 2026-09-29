const express = require("express");
const { requireAuth, requireAuthOrDevice } = require("../middleware/auth");
const controller = require("../controllers/heartRate");

const router = express.Router();
router.get("/pref", requireAuthOrDevice, controller.getPref);
router.put("/pref", requireAuth, express.json(), controller.setPref);
router.get("/recent", requireAuth, controller.recent);
// A day of queued minutes at ~150 bytes each.
router.post("/minutes", requireAuthOrDevice, express.json({ limit: "256kb" }), controller.recordMinutes);
module.exports = router;
