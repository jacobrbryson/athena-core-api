const messageService = require("../services/message");
const sessionService = require("../services/session");
const { extractIp } = require("../helpers/utils");
const { processAiResponse } = require("./gemini");
const config = require("../config");

async function getMessage(req, res) {
	try {
		const ip = extractIp(req);
		const uuid = req.query.sessionId;

		if (!uuid)
			return res
				.status(400)
				.json({ success: false, message: "Missing session UUID" });

		const session = await sessionService.getSessionByUuidAndIp(uuid, ip);
		if (!session)
			return res
				.status(404)
				.json({ success: false, message: "Session not found" });

		const chats = await messageService.getMessages(session.id);

		res.json(chats);
	} catch (err) {
		console.error("Error fetching chat:", err);
		res.status(500).json({ success: false, message: "DB error" });
	}
}

async function addMessage(req, res, clients) {
	try {
		const ip = extractIp(req);
		const { sessionId, text: rawText } = req.body;
		const text = rawText?.trim();

		if (!sessionId || !text)
			return res
				.status(400)
				.json({ success: false, message: "Missing UUID or message" });

		const session = await sessionService.getSessionByUuidAndIp(
			sessionId,
			ip
		);
		if (!session)
			return res
				.status(404)
				.json({ success: false, message: "Session not found" });

		if (
			session.session_message_count_24h >=
			config.PUBLIC_SESSION_MESSAGE_DAILY_LIMIT
		) {
			return res.status(429).json({
				success: false,
				message: `Session daily limit reached (${config.PUBLIC_SESSION_MESSAGE_DAILY_LIMIT})`,
			});
		}

		if (
			session.ip_message_count_24h >= config.PUBLIC_IP_MESSAGE_DAILY_LIMIT
		) {
			return res.status(429).json({
				success: false,
				message: `IP daily limit reached (${config.PUBLIC_IP_MESSAGE_DAILY_LIMIT})`,
			});
		}

		if (text?.length < 3) {
			return res.status(400).json({
				success: false,
				message: "Text length short",
			});
		}

		if (text?.length > 256) {
			return res.status(400).json({
				success: false,
				message: "Text length too long",
			});
		}

		await messageService.addMessage(session.id, true, text);

		await sessionService.updateSession(session.id, { is_busy: true });

		res.json({
			message: {
				text,
				is_human: true,
				created_at: Date.now(),
			},
			session: {
				sessionId: session.id,
				is_busy: true,
			},
		});

		processAiResponse(session, text, clients);
	} catch (err) {
		console.error("Error in addMessage (Pre-AI):", err);
		if (!res.headersSent) {
			res
				.status(500)
				.json({ success: false, message: "Failed to process message" });
		}
	}
}

module.exports = {
	getMessage,
	addMessage,
};
