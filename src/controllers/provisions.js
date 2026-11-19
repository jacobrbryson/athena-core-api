const { requireAdultActor } = require("../helpers/actor");
const provisions = require("../services/provisions");
const photos = require("../services/provisions/scan");

/**
 * Family → Provisions (services/provisions). The caller's own profile only;
 * nothing here writes to Keep — grocery changes stay on their approval card.
 */
async function guarded(req, res, fn) {
	res.set("Cache-Control", "no-store");
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		return res.json(await fn(actor));
	} catch (err) {
		if (err?.status === 404) return res.status(404).json({ success: false, message: err.message });
		if (err?.status === 400) return res.status(400).json({ success: false, message: err.message });
		if (err?.code === "ER_NO_SUCH_TABLE") return res.status(503).json({ success: false, message: "This part of Provisions needs a database update first." });
		if (err?.code === "not_connected") return res.status(409).json({ success: false, code: "not_connected", message: err.message });
		console.warn("[provisions]", err?.message || err);
		return res.status(503).json({ success: false, message: "Provisions are unavailable. Please retry." });
	}
}

const summary = (req, res) => guarded(req, res, (actor) => provisions.summary(actor.profileId));
const refreshIdeas = (req, res) => guarded(req, res, async (actor) => ({ written: await provisions.refreshIdeas(actor.profileId) }));
/** Photos of a pantry, fridge, freezer or counter → what's in it. The photos are read, never kept. */
const scan = (req, res) => guarded(req, res, (actor) => photos.scan(actor.profileId, req.body || {}));
const removeSeen = (req, res) => guarded(req, res, (actor) => photos.remove(actor.profileId, String(req.params.uuid || "")));
const saveIdea = (req, res) => guarded(req, res, (actor) => provisions.setSaved(actor.profileId, String(req.params.uuid || ""), !!req.body?.saved));

/** A dish's picture: stored, or painted on first view (a few seconds). */
async function ideaImage(req, res) {
	if (!/^[0-9a-f-]{36}$/i.test(String(req.params.uuid || ""))) return res.status(404).end();
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		const { mime, bytes } = await provisions.ideaImage(actor.profileId, req.params.uuid);
		res.set("Content-Type", mime);
		res.set("Cache-Control", "private, max-age=604800");
		return res.end(bytes);
	} catch (err) {
		if (err?.status === 404 || err?.code === "ER_NO_SUCH_TABLE") return res.status(404).end();
		console.warn("[provisions] image", err?.message || err);
		return res.status(503).end();
	}
}

module.exports = { summary, refreshIdeas, saveIdea, ideaImage, scan, removeSeen };
