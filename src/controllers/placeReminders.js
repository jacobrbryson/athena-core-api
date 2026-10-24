const placeReminders = require("../services/placeReminders");
const timeReminders = require("../services/timeReminders");
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
	try {
		const [reminders, times, phone] = await Promise.all([placeReminders.list(id), timeReminders.list(id).catch(() => []), placeReminders.phoneStatus(id).catch(() => null)]);
		return res.json({ reminders, timeReminders: times, phone });
	} catch (err) { return fail(res, err); }
}

async function cancel(req, res) {
	if (req.user?.kind === "device") return res.status(403).json({ success: false, message: "Remove reminders from the Companion app" });
	const id = await profileId(req, res); if (!id) return;
	try {
		// One Remove button for both kinds: try the place reminder, then the time one.
		let reminders;
		try {
			reminders = await placeReminders.cancel(id, req.params.uuid);
		} catch (err) {
			if (err?.status !== 404) throw err;
			await timeReminders.cancel(id, req.params.uuid);
			reminders = await placeReminders.list(id);
		}
		return res.json({ success: true, reminders, timeReminders: await timeReminders.list(id).catch(() => []) });
	} catch (err) { return fail(res, err); }
}

/** The phone's sync: which fences to hold. */
async function geofences(req, res) {
	if (req.user?.kind !== "device") return res.status(403).json({ success: false, message: "Device token required" });
	try { return res.json(await placeReminders.geofences(req.user.profileId, req.user.deviceId)); } catch (err) { return fail(res, err); }
}

/** The phone has been inside a fence for a couple of minutes. */
async function arrived(req, res) {
	if (req.user?.kind !== "device") return res.status(403).json({ success: false, message: "Device token required" });
	try { return res.json(await placeReminders.arrived(req.user.profileId, req.user.deviceId, req.body || {})); } catch (err) { return fail(res, err); }
}

/** The phone says whether it can hold its fences (no position). */
async function phoneStatus(req, res) {
	if (req.user?.kind !== "device") return res.status(403).json({ success: false, message: "Device token required" });
	try { return res.json(await placeReminders.recordPhoneStatus(req.user.profileId, req.user.deviceId, req.body || {})); } catch (err) { return fail(res, err); }
}

module.exports = { list, cancel, geofences, arrived, phoneStatus };
