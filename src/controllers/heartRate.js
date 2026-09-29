const heartRate = require("../services/heartRate");
const { requireAdultActor } = require("../helpers/actor");

/** Health data: adult profiles only, for every route here — never a child's. */
async function adult(req, res) {
	const who = await requireAdultActor(req, res);
	return who ? who.profileId : null;
}

function fail(res, err) {
	const status = Number.isInteger(err?.status) ? err.status : 500;
	return res.status(status).json({ success: false, code: err?.code || null, message: status >= 500 ? "Heart rate service unavailable" : err.message });
}

async function getPref(req, res) {
	const id = await adult(req, res); if (!id) return;
	try { return res.json({ pref: await heartRate.getPref(id) }); } catch (err) { return fail(res, err); }
}

async function setPref(req, res) {
	// A handset may report, never switch itself on.
	if (req.user?.kind === "device") return res.status(403).json({ success: false, message: "Manage heart rate from the Companion app" });
	const id = await adult(req, res); if (!id) return;
	try { return res.json({ success: true, pref: await heartRate.setPref(id, req.body || {}) }); } catch (err) { return fail(res, err); }
}

async function recordMinutes(req, res) {
	if (req.user?.kind !== "device") return res.status(403).json({ success: false, message: "Device token required" });
	const id = await adult(req, res); if (!id) return;
	try { return res.json(await heartRate.recordMinutes({ profileId: id, deviceId: req.user.deviceId, body: req.body || {} })); } catch (err) { return fail(res, err); }
}

async function recent(req, res) {
	const id = await adult(req, res); if (!id) return;
	try { return res.json({ minutes: await heartRate.recent(id, { minutes: req.query.minutes }) }); } catch (err) { return fail(res, err); }
}

module.exports = { getPref, setPref, recordMinutes, recent };
