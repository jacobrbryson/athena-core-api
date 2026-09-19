const express = require("express");
const { inbound } = require("../controllers/sms");

const router = express.Router();

/**
 * Twilio's inbound webhook.
 *
 * Deliberately NOT behind requireAuth: Twilio has no session and no device
 * token. It authenticates by signing the request, and the controller verifies
 * that signature before doing anything else — see the header there for why
 * that check is the entire door rather than one lock among several.
 *
 * `urlencoded` and not `json`: Twilio posts a form. The signature is computed
 * over those exact parameters, so the parser has to produce them unchanged —
 * `extended: false` keeps the flat key/value shape the algorithm assumes.
 */
router.post("/inbound", express.urlencoded({ extended: false }), inbound);

module.exports = router;
