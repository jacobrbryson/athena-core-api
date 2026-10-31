const router = require("express").Router();
const express = require("express");
const c = require("../controllers/workItems");
router.use(require("../middleware/auth").requireAuthOrDevice);
router.get("/issue", c.issueRead);
router.get("/comments", c.commentRead);
router.get("/setup", c.setup);
router.post("/environments", c.saveEnvironment);
router.post("/keys", c.saveKey);
router.post("/keys/:credentialUuid/revoke", c.revokeKey);
router.get("/runs", c.listRuns);
router.post("/runs", c.createRun);
router.post("/claim", c.claim);
router.post("/review-checks/claim", c.claimReviewCheck);
router.post("/review-checks/:uuid/finish", c.finishReviewCheck);
router.get("/runs/:uuid", c.getRun);
router.post("/runs/:uuid/propose", c.propose);
router.post("/runs/:uuid/stop", c.stop);
router.post("/runs/:uuid/heartbeat", c.heartbeat);
router.post("/runs/:uuid/transition", c.transition);
router.post("/runs/:uuid/step", c.step);
router.post("/runs/:uuid/comment", c.comment);
router.post("/runs/:uuid/speech", c.speech);
router.post("/runs/:uuid/login", c.login);
router.get("/runs/:uuid/backup", c.backup);
router.get("/runs/:uuid/source/:repository", c.source);
router.post(
  "/runs/:uuid/artifacts",
  express.raw({
    type: ["video/mp4", "text/x-diff", "application/json"],
    limit: "64mb",
  }),
  c.upload,
);
router.get("/artifacts/:artifactUuid", c.download);
module.exports = router;
