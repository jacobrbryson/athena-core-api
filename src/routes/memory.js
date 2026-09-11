const express = require("express");
const { listMine, upsertMine, deleteMine } = require("../controllers/memory");
const companion = require("../controllers/companion");
const { requireAuthOrDevice } = require("../middleware/auth");

const router = express.Router();

// Accessible to parents, child session tokens, and paired devices (own memory only).
router.use(requireAuthOrDevice);

// Memory v2: recall, episodes, photos, and the readable journal.
router.get("/recall", companion.recall);
router.get("/events", companion.listEvents);
router.post("/events", companion.createEvent);
router.delete("/events/:uuid", companion.deleteEvent);
router.post("/photos", companion.rememberPhoto);
router.get("/journal", companion.journal);

// Durable facts (memory foundation).
router.get("/", listMine);
router.post("/", upsertMine);
router.delete("/:memoryUuid", deleteMine);

module.exports = router;
