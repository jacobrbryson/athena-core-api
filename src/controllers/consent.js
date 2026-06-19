const consentService = require("../services/consent");
const { extractIp } = require("../helpers/utils");

async function getStatus(req, res) {
	try {
		const status = await consentService.getConsentStatus(req.user.googleId);
		return res.json(status);
	} catch (err) {
		console.error("[consent] status", err.message);
		return res
			.status(500)
			.json({ success: false, message: "Failed to load consent status" });
	}
}

async function recordConsent(req, res) {
	try {
		const status = await consentService.recordConsent(
			req.user.googleId,
			req.body || {},
			{
				ip: extractIp(req),
				userAgent: req.headers["user-agent"] || null,
			}
		);
		return res.status(201).json({ success: true, ...status });
	} catch (err) {
		console.error("[consent] record", err.message);
		const known = err.message?.includes("Invalid");
		return res
			.status(known ? 400 : 500)
			.json({ success: false, message: err.message || "Failed to record consent" });
	}
}

async function getHistory(req, res) {
	try {
		const history = await consentService.getConsentHistory(
			req.user.googleId,
			req.query.limit
		);
		return res.json(history);
	} catch (err) {
		console.error("[consent] history", err.message);
		return res
			.status(500)
			.json({ success: false, message: "Failed to load consent history" });
	}
}

module.exports = { getStatus, recordConsent, getHistory };
