const messageService = require("../services/message");
const sessionService = require("../services/session");
const { extractIp } = require("../helpers/utils");
const { processAiResponse } = require("./gemini");
const config = require("../config");

const trimStr = (v, max) =>
	typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/**
 * Extract the optional client-supplied prompt context from a message body.
 * `guardian` personalizes Athena (non-sensitive: a display name + adventure she
 * already knows). `onboarding` carries the scripted line she just said plus the
 * first/returning flag so the AI can drive the first-contact exchange.
 */
function parseMessageContext(body = {}) {
	const guardian = body.guardian
		? {
				displayName: trimStr(body.guardian.display_name, 80),
				adventureKey: trimStr(body.guardian.adventure_key, 64),
				city: trimStr(body.guardian.city, 120),
				linkedProfileId: Number.isFinite(Number(body.guardian.linked_profile_id))
					? Number(body.guardian.linked_profile_id)
					: null,
		  }
		: undefined;

	const onboarding =
		body.onboarding && typeof body.onboarding === "object"
			? {
					priorAthenaLine: trimStr(body.onboarding.priorAthenaLine, 600),
					firstContact: Boolean(body.onboarding.firstContact),
			  }
			: undefined;

	return {
		guardian: guardian && (guardian.displayName || guardian.adventureKey) ? guardian : undefined,
		onboarding,
	};
}

async function getMessage(req, res) {
	try {
		const ip = extractIp(req);
		const uuid = req.query.sessionId;

		if (typeof uuid !== "string" || !uuid.trim())
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
		const { sessionId, text: rawText } = req.body || {};
		const text = rawText?.trim();

		if (typeof sessionId !== "string" || !sessionId.trim() || !text)
			return res
				.status(400)
				.json({ success: false, message: "Missing UUID or message" });

		if (typeof text !== "string") {
			return res
				.status(400)
				.json({ success: false, message: "Message must be a string" });
		}

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

		const ctx = parseMessageContext(req.body);

		// The onboarding "communication check" invites very short replies
		// ("hi", "ok"), so relax the usual minimum for those turns only.
		const minLength = ctx.onboarding ? 1 : 3;
		if (text?.length < minLength) {
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

		await messageService.addMessage(session.id, true, text, session.mode);

		await sessionService.updateSession(session.id, { is_busy: true });

		const sessionClients = clients.get(session.uuid);
		if (sessionClients) {
			const payload = JSON.stringify({
				rpc: "sessionStatus",
				session: {
					is_busy: true,
				},
			});
			for (const ws of sessionClients) {
				if (ws.readyState === ws.OPEN) {
					ws.send(payload);
				}
			}
		}

		res.json({
			message: {
				text,
				is_human: true,
				created_at: Date.now(),
			},
			session: {
				sessionId: session.uuid,
				is_busy: true,
			},
		});

		processAiResponse(session, text, clients, ctx);
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
