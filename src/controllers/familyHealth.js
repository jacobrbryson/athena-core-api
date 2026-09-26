const { requireAdultActor } = require("../helpers/actor");
const familyHealth = require("../services/familyHealth");

async function report(req, res) {
	res.set("Cache-Control", "no-store");
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		const status = await familyHealth.report(actor.profileId, req.body || {});
		return res.status(201).json({ status });
	} catch (err) {
		return res.status(err.status || 400).json({ success: false, message: err.message || "Could not save that." });
	}
}

async function resolve(req, res) {
	res.set("Cache-Control", "no-store");
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		const status = await familyHealth.resolve(actor.profileId, req.params.uuid);
		if (!status) return res.status(404).json({ success: false, message: "Not found." });
		return res.json({ status });
	} catch (err) {
		return res.status(err.status || 400).json({ success: false, message: err.message || "Could not update that." });
	}
}

module.exports = { report, resolve };
