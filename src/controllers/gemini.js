const sessionService = require("../services/session");
const messageService = require("../services/message");
const geminiService = require("../services/gemini");
const sessionTopicService = require("../services/sessionTopic");

const { generatePrompt } = require("./prompt");

async function processAiResponse(session, message, clients) {
	try {
		const topics = await sessionTopicService.getSessionTopics(session.id);
		const prompt = await generatePrompt(session, topics || [], message);
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
			parsedResponse.response
		);

		const ws = clients.get(session.uuid);

		if (parsedResponse.action == "NEW_TOPIC") {
			await sessionTopicService.addSessionTopic(
				session.id,
				parsedResponse.topic_name,
				parsedResponse.new_proficiency
			);
			if (ws && ws.readyState === ws.OPEN) {
				ws.send(
					JSON.stringify({
						rpc: "addSessionTopic",
						topic: {
							topic_name: parsedResponse.topic_name,
							proficiency: parsedResponse.new_proficiency,
						},
					})
				);
			}
		} else if (parsedResponse.action == "INCREASE_PROFICIENCY") {
			sessionTopicService.updateSessionTopic(
				session.id,
				parsedResponse.topic_name,
				parsedResponse.new_proficiency
			);
			if (ws && ws.readyState === ws.OPEN) {
				ws.send(
					JSON.stringify({
						rpc: "updateSessionTopic",
						topic: {
							topic_name: parsedResponse.topic_name,
							proficiency: parsedResponse.new_proficiency,
						},
					})
				);
			}
		}

		if (ws && ws.readyState === ws.OPEN) {
			ws.send(
				JSON.stringify({
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
				})
			);
		}
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
