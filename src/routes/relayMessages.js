const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { resolveActor } = require("../helpers/actor");
const messages = require("../services/relayMessages");

/**
 * Secret messages in Signal Relay (owner, 2026-11-25) — services/relayMessages.js.
 * Behind the access boundary like every /api/v1 route; any signed-in person
 * with access (kid or adult) can send and receive. The caller is always
 * resolved from the session, never from the body.
 *
 *   GET  /relay-messages/recipients      everyone else with Athena access
 *   POST /relay-messages                 { messages: [{ id, to, body, at }] }
 *   GET  /relay-messages/inbox           waiting to be decoded (marks delivered)
 *   POST /relay-messages/:uuid/decoded   the recipient finished decoding it
 */
const router = express.Router();
const json = express.json({ limit: "16kb" });

const as = (fn) => async (req, res) => {
	res.set("Cache-Control", "no-store");
	let who;
	try { who = await resolveActor(req); } catch { return res.status(401).json({ success: false, message: "Unauthorized" }); }
	try { return res.json(await fn(req, who.profileId)); } catch (err) {
		console.error("[relay-messages]", err.message);
		return res.status(500).json({ success: false, message: "Messages are unavailable right now." });
	}
};

router.get("/recipients", requireAuth, as(async (_req, profileId) => ({ people: await messages.recipients(profileId) })));
router.post("/", requireAuth, json, as(async (req, profileId) => messages.send(profileId, req.body?.messages)));
router.get("/inbox", requireAuth, as(async (_req, profileId) => ({ messages: await messages.inbox(profileId) })));
router.post("/:uuid/decoded", requireAuth, as(async (req, profileId) => messages.decoded(profileId, req.params.uuid)));

module.exports = router;
