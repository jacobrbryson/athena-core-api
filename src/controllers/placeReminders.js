const placeReminders = require("../services/placeReminders");
const memory = require("../services/memory");

/** The owner's own profile, from a signed-in session or a paired phone's token. */
async function profileId(req, res) {
	if (req.user?.kind === "child" || !req.user) {
		res.status(403).json({ success: false, message: "Only the account owner has place reminders" });
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
	return res.status(status).json({ success: false, code: err?.code || null, message: status >= 500 ? "Place reminders are unavailable" : err.message });
}

async function list(req, res) {
	const id = await profileId(req, res); if (!id) return;
	try { return res.json({ reminders: await placeReminders.list(id) }); } catch (err) { return fail(res, err); }
}

async function cancel(req, res) {
	if (req.user?.kind === "device") return res.status(403).json({ success: false, message: "Remove reminders from the Companion app" });
	const id = await profileId(req, res); if (!id) return;
	try { return res.json({ success: true, reminders: await placeReminders.cancel(id, req.params.uuid) }); } catch (err) { return fail(res, err); }
}

/** The phone's sync: which fences to hold. */
async function geofences(req, res) {
	if (req.user?.kind !== "device") return res.status(403).json({ success: false, message: "Device token required" });
	try { return res.json(await placeReminders.geofences(req.user.profileId)); } catch (err) { return fail(res, err); }
}

/** The phone has been inside a fence for a couple of minutes. */
async function arrived(req, res) {
	if (req.user?.kind !== "device") return res.status(403).json({ success: false, message: "Device token required" });
	try { return res.json(await placeReminders.arrived(req.user.profileId, req.user.deviceId, req.body || {})); } catch (err) { return fail(res, err); }
}

module.exports = { list, cancel, geofences, arrived };
