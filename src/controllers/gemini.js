const sessionService = require("../services/session");
const messageService = require("../services/message");
const llm = require("../services/llm");
const memoryStore = require("../services/memoryStore");
const perception = require("../services/perception");
const sessionTopicService = require("../services/sessionTopic");
const integrationService = require("../services/integration");
const missionService = require("../services/mission");

const { generatePrompt } = require("./prompt");

// How many prior messages to feed back as conversation history.
const MAX_HISTORY = 20;

/** The shared reply schema every conversation mode emits (see prompt.js). */
function isValidReply(r) {
	return (
		!!r &&
		typeof r.response === "string" &&
		r.response.trim().length > 0 &&
		typeof r.action === "string" &&
		typeof r.new_proficiency === "number" &&
		typeof r.topic_name === "string"
	);
}

async function processAiResponse(session, message, clients, ctx = {}) {
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

		// Conversation history for continuity. getMessages returns the transcript
		// oldest→newest including the message just saved (the current turn), so we
		// drop that trailing entry and keep the most recent MAX_HISTORY before it.
		let history = [];
		try {
			const all = await messageService.getMessages(session.id);
			history = all.slice(0, -1).slice(-MAX_HISTORY);
		} catch (e) {
			console.warn("[gemini] history fetch failed:", e.message);
		}

		// Long-term memory for this turn (audience, recall block). Time-boxed and
		// never throws, so memory can't stall or break a reply.
		const memoryCtx = await memoryStore
			.buildMemoryContext(session, message, ctx)
			.catch(() => ({ audience: "child", memoryEnabled: false, promptBlock: null }));

		const prompt = await generatePrompt(session, topics || [], message, {
			integrationContext,
			guardian: ctx.guardian,
			onboarding: ctx.onboarding,
			mission: ctx.mission,
			decodes: ctx.decodes,
			game: ctx.game,
			companion: ctx.companion,
			audience: memoryCtx.audience,
			memoryBlock: memoryCtx.promptBlock,
			perceptionBlock:
				session.profile_id && memoryCtx.audience === "adult"
					? perception.getPromptBlock(session.profile_id)
					: null,
			history,
		});

		// Routed through the tiered model layer (Orcwood -> frontier by policy).
		// A tier whose output isn't valid reply JSON is skipped in favor of the
		// next one instead of silently dropping the reply.
		let parsedResponse;
		try {
			const result = await llm.generate({
				task: "chat",
				contents: prompt,
				audience: memoryCtx.audience,
				validate: (text) => {
					try {
						parsedResponse = JSON.parse(text);
					} catch {
						return "invalid JSON";
					}
					return isValidReply(parsedResponse) ? null : "reply failed schema validation";
				},
			});
			if (!result?.text) {
				console.warn(`Model returned no response for session ${session.id}`);
				return;
			}
		} catch (err) {
			console.error(`No model produced a valid reply for session ${session.id}:`, err.message);
			return;
		}

		const aiChatUuid = await messageService.addMessage(
			session.id,
			false,
			parsedResponse.response,
			session.mode
		);

		// Background memory extraction (throttled; never blocks the reply).
		if (session.mode !== "teach") {
			memoryStore.afterTurn(session, message, {
				audience: memoryCtx.audience,
				memoryEnabled: memoryCtx.memoryEnabled,
			});
		}

		// In-chat mission reporting: when Athena flags that the Guardian reported
		// their cooperative-mission piece, record it for their family (idempotent;
		// the stored fragment is backend-authored, so it can't be spoofed). The
		// Guardian + adventure come from the verified session token, the mission id
		// from the client steering context. Never blocks the reply.
		if (parsedResponse.mission_report === true && ctx.guardianAuth && ctx.mission?.id) {
			try {
				const familyKey = missionService.familyKeyFor({
					displayName: ctx.guardianAuth.display_name,
					guardianId: ctx.guardianAuth.guardian_id,
				});
				await missionService.recordContribution(
					ctx.mission.id,
					ctx.guardianAuth.adventure_key,
					familyKey,
					ctx.guardianAuth.guardian_id
				);
			} catch (e) {
				console.warn("[gemini] mission contribution failed:", e.message);
			}
		}

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
