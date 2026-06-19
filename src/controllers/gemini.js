const sessionService = require("../services/session");
const messageService = require("../services/message");
const geminiService = require("../services/gemini");
const sessionTopicService = require("../services/sessionTopic");
const integrationService = require("../services/integration");

const { generatePrompt } = require("./prompt");

async function processAiResponse(session, message, clients) {
	try {
		const topics = await sessionTopicService.getSessionTopics(session.id);

		// If the user has linked an external app (e.g. Family Chores) and is
		// asking about it, fetch a live snapshot to ground the reply. Failures
		// here must never block the conversation.
		let integrationContext = null;
		if (
			session.profile_id &&
			integrationService.messageNeedsFamilyChores(message)
		) {
			try {
				integrationContext =
					await integrationService.buildFamilyChoresContext(
						session.profile_id,
						{ message }
					);
			} catch (e) {
				console.warn("[gemini] Family Chores context failed:", e.message);
			}
		}

		const prompt = await generatePrompt(session, topics || [], message, {
			integrationContext,
		});
		const response = await geminiService.generateResponse(prompt);

		if (!response) {
			console.warn(
				`Gemini returned no response for session ${session.id}`
			);
			return;
		}

		let parsedResponse;
		try {
			parsedResponse = JSON.parse(response);
		} catch (parseErr) {
			console.error("Gemini returned invalid JSON", parseErr);
			return;
		}

		const validResponse =
			parsedResponse &&
			typeof parsedResponse.response === "string" &&
			typeof parsedResponse.action === "string" &&
			typeof parsedResponse.new_proficiency === "number" &&
			typeof parsedResponse.topic_name === "string";

		if (!validResponse) {
			console.error("Gemini response failed validation", parsedResponse);
			return;
		}

		const aiChatUuid = await messageService.addMessage(
			session.id,
			false,
			parsedResponse.response,
			session.mode
		);

		const sessionClients = clients.get(session.uuid);
		const broadcast = (payload) => {
			if (!sessionClients) return;
			const serialized = JSON.stringify(payload);
			for (const ws of sessionClients) {
				if (ws.readyState === ws.OPEN) {
					ws.send(serialized);
				}
			}
		};

		if (parsedResponse.action == "NEW_TOPIC") {
			await sessionTopicService.addSessionTopic(
				session.id,
				parsedResponse.topic_name,
				parsedResponse.new_proficiency
			);
			broadcast({
				rpc: "addSessionTopic",
				topic: {
					topic_name: parsedResponse.topic_name,
					proficiency: parsedResponse.new_proficiency,
				},
			});
		} else if (parsedResponse.action == "INCREASE_PROFICIENCY") {
			sessionTopicService.updateSessionTopic(
				session.id,
				parsedResponse.topic_name,
				parsedResponse.new_proficiency
			);
			broadcast({
				rpc: "updateSessionTopic",
				topic: {
					topic_name: parsedResponse.topic_name,
					proficiency: parsedResponse.new_proficiency,
				},
			});
		}

		broadcast({
			rpc: "addMessage",
			session: {
				is_busy: false,
			},
			message: {
				uuid: aiChatUuid,
				is_human: false,
				text: parsedResponse.response,
				created_at: Date.now(),
			},
		});
	} catch (err) {
		console.error("Error during AI response processing:", err);
		// IMPORTANT: Send an error status back to the client via WS if possible
	} finally {
		// ALWAYS ensure the session is marked not busy, regardless of success/failure
		await sessionService
			.updateSession(session.id, { is_busy: false })
			.catch((e) => console.error("Failed to reset is_busy flag:", e));
	}
}

module.exports = {
	processAiResponse,
};
