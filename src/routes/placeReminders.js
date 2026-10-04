const express = require("express");
const { requireAuth, requireAuthOrDevice } = require("../middleware/auth");
const controller = require("../controllers/placeReminders");

// Setting a reminder is not here on purpose: it is the remind_at_place action,
// approved through /actions like every other change Athena proposes.
const router = express.Router();
router.get("/", requireAuth, controller.list);
router.delete("/:uuid", requireAuth, controller.cancel);
router.get("/geofences", requireAuthOrDevice, controller.geofences);
router.post("/arrived", requireAuthOrDevice, express.json({ limit: "4kb" }), controller.arrived);
module.exports = router;
