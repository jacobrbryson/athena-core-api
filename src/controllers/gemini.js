const sessionService = require("../services/session");
const messageService = require("../services/message");
const llm = require("../services/llm");
const memoryStore = require("../services/memoryStore");
const perception = require("../services/perception");
const sessionTopicService = require("../services/sessionTopic");
const integrationService = require("../services/integration");
const connectorContext = require("../services/connectors/context");
const missionService = require("../services/mission");
const selfKnowledge = require("../services/selfKnowledge");
const { audienceForSession } = require("../services/audience");

const { generatePrompt, RESPONSE_SCHEMA } = require("./prompt");
const { parseModelJson } = require("../services/llm/parse");

// How many prior messages to feed back as conversation history.
const MAX_HISTORY = 20;
// Chat generation attempts before Athena falls back to saying something honest.
// Models are stochastic, so a second try on the same tier often succeeds.
const CHAT_ATTEMPTS = 2;
// Said only when no model produced a usable reply. A conversation must never
// dead-end on the person's own message (the nightly review counts those as
// dropped replies) — and it must not pretend to have answered.
const FALLBACK_REPLY =
	"Sorry — something glitched on my end and I lost that reply. Can you say it again?";

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

		// If the user has linked an external app and is asking about it, fetch a
		// live snapshot to ground the reply. Family Chores is partner-linked;
		// Calendar/Strava/Whoop are OAuth connectors. Both are keyword-gated so
		// an unrelated message costs nothing, and failures here must never block
		// the conversation.
		//
		// A Guardians session is never bound to a profile — that app has no
		// profile_uuid to send — so fall back to the profile resolved from the
		// guardian's verified session token (message.js), the same identity
		// prompt.js already uses to recall their memories.
		const groundingProfileId = ctx.guardian?.linkedProfileId || session.profile_id;

		// Whether a failing integration may show this person the provider's own
		// error text. Adults get the real reason so they can fix it; children
		// get "I can't see it right now" and nothing more. Resolved here rather
		// than reused from memoryCtx below because the grounding runs first;
		// audienceForSession is cached per profile, so the second call is free.
		// A Guardian session is a child audience even though it grounds on the
		// parent's profile — the account is theirs, the conversation is not.
		const groundingAudience = await audienceForSession(session, ctx).catch(
			() => "child"
		);

		let integrationContext = null;
		if (groundingProfileId) {
			const blocks = await Promise.all([
				integrationService.messageNeedsFamilyChores(message)
					? integrationService
							.buildFamilyChoresContext(groundingProfileId, { message })
							.catch((e) => {
								console.warn("[gemini] Family Chores context failed:", e.message);
								return null;
							})
					: null,
				connectorContext.messageNeedsConnectors(message)
					? connectorContext
							.buildContext(groundingProfileId, {
								message,
								audience: groundingAudience,
							})
							.catch((e) => {
								console.warn("[gemini] connector context failed:", e.message);
								return null;
							})
					: null,
			]);
			integrationContext = blocks.filter(Boolean).join("\n\n") || null;
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

		// What Athena can actually do, scoped to this app and this person, read
		// from docs/capabilities. Cheap (parsed files, cached) and never throws —
		// a missing or malformed doc costs her knowledge of one feature, never
		// the reply.
		const surface = ctx.guardian
			? "guardians"
			: ctx.companion || memoryCtx.audience === "adult"
				? "companion"
				: "learning";
		let capabilityBlock = null;
		try {
			capabilityBlock = selfKnowledge.buildCapabilityBlock(message, {
				surface,
				audience: memoryCtx.audience,
			});
		} catch (e) {
			console.warn("[gemini] capability block failed:", e.message);
		}

		const prompt = await generatePrompt(session, topics || [], message, {
			integrationContext,
			capabilityBlock,
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
		let fellBack = false;
		for (let attempt = 1; attempt <= CHAT_ATTEMPTS && !parsedResponse; attempt++) {
			try {
				const result = await llm.generate({
					task: "chat",
					contents: prompt,
					audience: memoryCtx.audience,
					// Constrain the model to the reply schema (Gemini structured
					// output) rather than only asking for JSON in the prompt.
					schema: RESPONSE_SCHEMA,
					validate: (text) => {
						const candidate = parseModelJson(text);
						if (!candidate) return "invalid JSON";
						if (!isValidReply(candidate)) return "reply failed schema validation";
						parsedResponse = candidate;
						return null;
					},
				});
				if (!result?.text) parsedResponse = null;
			} catch (err) {
				console.warn(
					`Chat attempt ${attempt}/${CHAT_ATTEMPTS} produced no valid reply for session ${session.id}: ${err.message}`
				);
			}
		}

		if (!parsedResponse) {
			// Answer honestly rather than leaving the person hanging.
			console.error(`Falling back to an apology for session ${session.id}`);
			fellBack = true;
			parsedResponse = {
				response: FALLBACK_REPLY,
				action: "NO_CHANGE",
				topic_name: "",
				new_proficiency: -1,
				is_factually_true: true,
			};
		}

		const aiChatUuid = await messageService.addMessage(
			session.id,
			false,
			parsedResponse.response,
			session.mode
		);

		// Background memory extraction (throttled; never blocks the reply).
		// Skipped for fallback apologies — there is nothing to remember.
		if (session.mode !== "teach" && !fellBack) {
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
