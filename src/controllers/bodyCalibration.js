const { requireAdultActor } = require("../helpers/actor");
const bodyCalibration = require("../services/bodyCalibration");

async function add(req, res) {
	res.set("Cache-Control", "no-store");
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		const reference = await bodyCalibration.add(actor.profileId, req.body || {});
		return res.status(201).json({ reference });
	} catch (err) {
		if (err.code === "ER_NO_SUCH_TABLE") return res.status(503).json({ success: false, message: "Calibration isn't set up on this server yet." });
		return res.status(err.status || 400).json({ success: false, message: err.message || "Could not save that." });
	}
}

async function remove(req, res) {
	res.set("Cache-Control", "no-store");
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		if (!(await bodyCalibration.remove(actor.profileId, req.params.uuid))) return res.status(404).json({ success: false, message: "Not found." });
		return res.json({ removed: true });
	} catch (err) {
		return res.status(err.status || 400).json({ success: false, message: err.message || "Could not remove that." });
	}
}

module.exports = { add, remove };
