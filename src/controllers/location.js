const location = require("../services/location");
const memory = require("../services/memory");

async function profileId(req, res) {
	if (req.user?.kind === "child" || !req.user) {
		res.status(403).json({ success: false, message: "Only the account owner can manage location sharing" });
		return null;
	}
	try {
		return (await memory.resolveProfileId(req.user.kind === "device" ? { profileId: req.user.profileId } : { googleId: req.user.googleId })).profileId;
	} catch {
		res.status(404).json({ success: false, message: "Profile not found" });
		return null;
	}
}

function fail(res, err) {
	const status = Number.isInteger(err?.status) ? err.status : 500;
	return res.status(status).json({ success: false, code: err?.code || null, message: status >= 500 ? "Location service unavailable" : err.message });
}

async function getPref(req, res) {
	const id = await profileId(req, res); if (!id) return;
	try { return res.json({ pref: await location.getPref(id) }); } catch (err) { return fail(res, err); }
}

async function setPref(req, res) {
	if (req.user?.kind === "device") return res.status(403).json({ success: false, message: "Manage location sharing from the Companion app" });
	const id = await profileId(req, res); if (!id) return;
	try { return res.json({ success: true, pref: await location.setPref(id, req.body || {}) }); } catch (err) { return fail(res, err); }
}

async function recordSample(req, res) {
	if (req.user?.kind !== "device") return res.status(403).json({ success: false, message: "Device token required" });
	try { return res.json(await location.recordSample({ profileId: req.user.profileId, deviceId: req.user.deviceId, body: req.body || {} })); } catch (err) { return fail(res, err); }
}

async function recent(req, res) {
	const id = await profileId(req, res); if (!id) return;
	try { return res.json({ samples: await location.recent(id) }); } catch (err) { return fail(res, err); }
}

module.exports = { getPref, setPref, recordSample, recent };
