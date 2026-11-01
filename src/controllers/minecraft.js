const minecraftChat = require("../services/minecraftChat");
const { requireAdultActor } = require("../helpers/actor");

async function chat(req, res) {
	// Only the paired bridge talks here; a signed-in page has no reason to.
	if (req.user?.kind !== "device") return res.status(403).json({ success: false, message: "Device token required" });
	if (!(await requireAdultActor(req, res))) return;
	try {
		return res.json({ reply: await minecraftChat.replyTo(req.body || {}) });
	} catch (err) {
		const status = Number.isInteger(err?.status) ? err.status : 500;
		return res.status(status).json({ success: false, code: err?.code || null, message: status >= 500 ? "Athena is unavailable" : err.message });
	}
}

module.exports = { chat };
