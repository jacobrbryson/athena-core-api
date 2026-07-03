const geminiService = require("../services/gemini");
const { decodeGuardianFromRequest } = require("../helpers/guardianToken");

const MAX_SPEECH_TEXT_LENGTH = 800;

async function generateSpeech(req, res) {
	if (!decodeGuardianFromRequest(req)) {
		return res.status(401).json({ success: false, message: "Unauthorized" });
	}

	const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
	if (!text) {
		return res
			.status(400)
			.json({ success: false, message: "Speech text is required" });
	}
	if (text.length > MAX_SPEECH_TEXT_LENGTH) {
		return res.status(400).json({
			success: false,
			message: `Speech text must be ${MAX_SPEECH_TEXT_LENGTH} characters or fewer`,
		});
	}

	try {
		const audio = await geminiService.generateSpeech(text);
		res.set("Cache-Control", "no-store");
		return res.json(audio);
	} catch (error) {
		console.error("[speech] generation failed:", error.message);
		return res
			.status(502)
			.json({ success: false, message: "Athena's voice is temporarily unavailable" });
	}
}

module.exports = { generateSpeech, MAX_SPEECH_TEXT_LENGTH };
