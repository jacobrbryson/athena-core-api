/**
 * Live conversation (services/live): start a Gemini Live voice session, run
 * her look_up tool, save each finished exchange.
 *
 * Mounted under the access boundary like every other model route, and each
 * call also needs a signed-in profile that owns (or was admitted to) the
 * session — the same check POST /message makes.
 */
const express = require("express");
const live = require("../services/live");
const sessionService = require("../services/session");
const { resolveCallerProfileId } = require("../helpers/callerIdentity");
const { decodeGuardianFromRequest } = require("../helpers/guardianToken");

const router = express.Router();
router.use(express.json({ limit: "64kb" }));

async function sessionFor(req, res) {
	// Guardian (kids' game) sessions keep the old conversation mode.
	if (decodeGuardianFromRequest(req)) {
		res.status(403).json({ success: false, message: "Live conversation is for adults" });
		return null;
	}
	const profileId = await resolveCallerProfileId(req).catch(() => null);
	const sessionId = req.body?.sessionId;
	if (!profileId || typeof sessionId !== "string" || !sessionId.trim()) {
		res.status(400).json({ success: false, message: "A signed-in session is required" });
		return null;
	}
	const session = await sessionService.getAuthorizedSession(sessionId.trim(), { callerProfileId: profileId });
	if (!session) {
		res.status(404).json({ success: false, message: "Session not found" });
		return null;
	}
	return { session, profileId };
}

function timeZoneOf(req) {
	const tz = req.body?.timeZone;
	return typeof tz === "string" ? tz.slice(0, 64) : undefined;
}

router.post("/session", async (req, res) => {
	try {
		const found = await sessionFor(req, res);
		if (!found) return;
		const out = await live.start(found.session, found.profileId, { timeZone: timeZoneOf(req) });
		res.set("Cache-Control", "no-store");
		res.json(out);
	} catch (err) {
		if (err.status) return res.status(err.status).json({ success: false, code: err.code, message: err.message });
		console.error("[live] start failed:", err.message);
		res.status(502).json({ success: false, message: "Live conversation is unavailable right now" });
	}
});

router.post("/tool", async (req, res) => {
	try {
		const found = await sessionFor(req, res);
		if (!found) return;
		const name = req.body?.name;
		if (name === live.TOOL) return res.json(await live.lookUp(found.profileId, req.body?.args, { timeZone: timeZoneOf(req) }));
		// Their spoken request is the approval; `heard` is what they said this turn.
		if (name === live.ACT) {
			const heard = typeof req.body?.heard === "string" ? req.body.heard : "";
			return res.json(await live.act(found.session, found.profileId, req.body?.args, { heard }));
		}
		res.status(400).json({ success: false, message: "Unknown tool" });
	} catch (err) {
		if (err.status) return res.status(err.status).json({ success: false, message: err.message });
		console.error("[live] tool failed:", err.message);
		res.json({ result: "That failed just now. Say so plainly; don't guess or claim it worked." });
	}
});

router.post("/turn", async (req, res) => {
	try {
		const found = await sessionFor(req, res);
		if (!found) return;
		const { heard, said, interrupted } = req.body || {};
		res.json(await live.saveTurn(found.session, found.profileId, { heard, said, interrupted: interrupted === true }));
	} catch (err) {
		console.error("[live] save failed:", err.message);
		res.status(500).json({ success: false, message: "Couldn't save that turn" });
	}
});

module.exports = router;
