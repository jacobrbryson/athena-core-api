const express = require("express");
const { getStatus, recordConsent, getHistory } = require("../controllers/consent");
const { requireParent } = require("../middleware/auth");

const router = express.Router();

router.use(requireParent);

router.get("/status", getStatus);
router.post("/", recordConsent);
router.get("/history", getHistory);

module.exports = router;
