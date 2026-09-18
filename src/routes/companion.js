const express = require("express");
const companion = require("../controllers/companion");
const { requireAuth, requireAuthOrDevice } = require("../middleware/auth");

/**
 * Companion platform routes: model router status + device manifest, paired
 * devices, and camera perception. Memory v2 lives under /memory.
 */
const router = express.Router();

// Public: the on-device model manifest carries no secrets, and devices poll it
// before (and after) pairing.
router.get("/llm/manifest", companion.llmManifest);
// Public: redeem a pairing code — the short-lived code is the credential.
router.post("/devices/pair", express.json(), companion.redeemPairingCode);

router.get("/llm/status", requireAuthOrDevice, companion.llmStatus);
router.post("/llm/device-report", requireAuthOrDevice, companion.deviceReport);

// Where to reach a handset. Device-authenticated: only the device knows its
// own registration, and revoking the device revokes this with it.
router.post("/devices/push-token", requireAuthOrDevice, express.json(), companion.registerPushToken);
router.delete("/devices/push-token", requireAuthOrDevice, companion.forgetPushToken);

// Device management happens from the signed-in Companion app, never a device.
router.post("/devices/pairing-code", requireAuth, companion.createPairingCode);
router.get("/devices", requireAuth, companion.listDevices);
router.delete("/devices/:uuid", requireAuth, companion.revokeDevice);

router.post("/vision/observe", requireAuthOrDevice, companion.observe);
router.post("/vision/describe", requireAuthOrDevice, companion.describeScene);

module.exports = router;
