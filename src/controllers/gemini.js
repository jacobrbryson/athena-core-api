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
const actions = require("../services/actions");
const initiative = require("../services/initiative");
const nearbyIncidents = require("../services/pulsepoint/watch");
const familyHealth = require("../services/familyHealth");
const dreams = require("../services/dreams");
const { audienceForSession } = require("../services/audience");
const sessionParticipants = require("../services/sessionParticipant");

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
    const groundingProfileId =
      ctx.guardian?.linkedProfileId || session.profile_id;

    // Whether a failing integration may show this person the provider's own
    // error text. Adults get the real reason so they can fix it; children
    // get "I can't see it right now" and nothing more. Resolved here rather
    // than reused from memoryCtx below because the grounding runs first;
    // audienceForSession is cached per profile, so the second call is free.
    // A Guardian session is a child audience even though it grounds on the
    // parent's profile — the account is theirs, the conversation is not.
    const groundingAudience = await audienceForSession(session, ctx).catch(
      () => "child",
    );

    let integrationContext = null;
    if (groundingProfileId) {
      const blocks = await Promise.all([
        integrationService.messageNeedsFamilyChores(message)
          ? integrationService
              .buildFamilyChoresContext(groundingProfileId, { message })
              .catch((e) => {
                console.warn(
                  "[gemini] Family Chores context failed:",
                  e.message,
                );
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
      const all = await messageService.getMessages(
        session.id,
        session.profile_id != null
          ? (ctx.speakerProfileId ?? session.profile_id)
          : null,
      );
      history = all.slice(0, -1).slice(-MAX_HISTORY);
    } catch (e) {
      console.warn("[gemini] history fetch failed:", e.message);
    }

    // Who is in the room. Read from the participant rows rather than inferred
    // from the transcript, because the turn that matters most is the FIRST one
    // after a guardian switches accounts — they have no earlier turns to take
    // a name from, and that is exactly when Athena needs to know the person in
    // front of her has changed.
    const participants =
      session.profile_id != null
        ? await sessionParticipants
            .presentParticipants(session.id)
            .catch((e) => {
              console.warn("[gemini] participants unavailable:", e.message);
              return [];
            })
        : [];

    // Long-term memory for this turn (audience, recall block). Time-boxed and
    // never throws, so memory can't stall or break a reply.
    const memoryCtx = await memoryStore
      .buildMemoryContext(session, message, ctx)
      .catch(() => ({
        audience: "child",
        memoryEnabled: false,
        promptBlock: null,
      }));

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

    // What Athena can DO this turn, as opposed to describe. Scoped to the
    // providers this person has linked and the consent their family gave, and
    // null for everyone else — a null block is how she stays read-only
    // instead of offering to change things she cannot touch.
    //
    // Adult sessions only. A child or Guardian session never proposes
    // actions: the account is the parent’s and the conversation is not.
    let actionBlock = null;
    const mayPropose =
      !!session.profile_id && memoryCtx.audience === "adult" && !ctx.guardian;
    if (mayPropose) {
      try {
        actionBlock = actions.promptBlock(
          await actions.availableFor(session.profile_id),
        );
      } catch (e) {
        console.warn("[gemini] action block failed:", e.message);
      }
    }

    // Anything she raised unprompted in the last few hours, so a reply to one
    // of them is a continuation rather than a non sequitur. Adult sessions
    // only, same as the actions block, and never fatal.
    let initiativeBlock = null;
    if (mayPropose) {
      try {
        initiativeBlock = await initiative.promptBlock(session.profile_id);
      } catch (e) {
        console.warn("[gemini] initiative block failed:", e.message);
      }
    }

    // Emergencies near their saved places, as the stored situation the
    // athena-incidents job assessed (one DB read, no fetch). When it is urgent
    // the block instructs her to lead with it — the owner asked for exactly
    // that. Never fatal.
    if (mayPropose) {
      try {
        const nearbyBlock = await nearbyIncidents.promptBlock(session.profile_id);
        if (nearbyBlock)
          initiativeBlock = initiativeBlock
            ? [initiativeBlock, nearbyBlock].join("\n\n")
            : nearbyBlock;
      } catch (e) {
        console.warn("[gemini] nearby incidents block failed:", e.message);
      }
    }

    // Anyone in the family currently reported under the weather. Same rule as
    // the blocks above: adult, non-guardian sessions only — the account this
    // is reported against is the parent's, not a child's or a guest world.
    if (mayPropose) {
      try {
        const healthBlock = await familyHealth.promptBlock(session.profile_id);
        if (healthBlock)
          initiativeBlock = initiativeBlock
            ? [initiativeBlock, healthBlock].join("\n\n")
            : healthBlock;
      } catch (e) {
        console.warn("[gemini] family health block failed:", e.message);
      }
    }

    // What she organized while dreaming (her own tables, this person's rows
    // only) and any question she wants to ask them. Adult sessions only: a
    // child's memories never reach athena_mind. Time-boxed and never fatal.
    if (mayPropose) {
      try {
        const mindBlock = await dreams.promptBlock(session.profile_id, message, {
          sessionId: session.id,
        });
        if (mindBlock)
          initiativeBlock = initiativeBlock
            ? [initiativeBlock, mindBlock].join("\n\n")
            : mindBlock;
      } catch (e) {
        console.warn("[gemini] dreams block failed:", e.message);
      }
    }

    const prompt = await generatePrompt(session, topics || [], message, {
      integrationContext,
      capabilityBlock,
      actionBlock,
      initiativeBlock,
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
      // Who is speaking this turn. prompt.js only uses these when the
      // transcript shows more than one person, so a solo conversation is
      // unaffected.
      speakerProfileId: ctx.speakerProfileId ?? null,
      participants,
    });

    // Routed through the tiered model layer (Orcwood -> frontier by policy).
    // A tier whose output isn't valid reply JSON is skipped in favor of the
    // next one instead of silently dropping the reply.
    let parsedResponse;
    let fellBack = false;
    for (
      let attempt = 1;
      attempt <= CHAT_ATTEMPTS && !parsedResponse;
      attempt++
    ) {
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
            if (!isValidReply(candidate))
              return "reply failed schema validation";
            parsedResponse = candidate;
            return null;
          },
        });
        if (!result?.text) parsedResponse = null;
      } catch (err) {
        console.warn(
          `Chat attempt ${attempt}/${CHAT_ATTEMPTS} produced no valid reply for session ${session.id}: ${err.message}`,
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
      session.mode,
    );

    // Background memory extraction (throttled; never blocks the reply).
    // Skipped for fallback apologies — there is nothing to remember.
    if (session.mode !== "teach" && !fellBack) {
      memoryStore.afterTurn(session, message, {
        audience: memoryCtx.audience,
        memoryEnabled: memoryCtx.memoryEnabled,
      });
    }

    // Did that message answer something Athena raised herself? If so, read
    // what it signalled and move that trigger's standing accordingly.
    //
    // Background and non-blocking, like memory extraction: it costs a small
    // local model call and must never delay or break a reply. It runs on
    // the fast path rather than waiting for the nightly sweep because
    // "stop sending me this" has to take effect immediately — the second
    // unwanted nudge after you asked her to stop is the one that loses the
    // person.
    if (mayPropose && !fellBack) {
      initiative
        .openNudgeFor(session.profile_id)
        .then((open) =>
          open
            ? initiative.appraiseReply(session.profile_id, open, message)
            : null,
        )
        .catch((e) =>
          console.warn("[gemini] nudge appraisal failed:", e.message),
        );
    }

    // In-chat mission reporting: when Athena flags that the Guardian reported
    // their cooperative-mission piece, record it for their family (idempotent;
    // the stored fragment is backend-authored, so it can't be spoofed). The
    // Guardian + adventure come from the verified session token, the mission id
    // from the client steering context. Never blocks the reply.
    if (
      parsedResponse.mission_report === true &&
      ctx.guardianAuth &&
      ctx.mission?.id
    ) {
      try {
        const familyKey = missionService.familyKeyFor({
          displayName: ctx.guardianAuth.display_name,
          guardianId: ctx.guardianAuth.guardian_id,
        });
        await missionService.recordContribution(
          ctx.mission.id,
          ctx.guardianAuth.adventure_key,
          familyKey,
          ctx.guardianAuth.guardian_id,
        );
      } catch (e) {
        console.warn("[gemini] mission contribution failed:", e.message);
      }
    }

    // Turn a `proposed_action` into a real pending proposal, if it survives
    // the registry. Everything about it is untrusted model output, so
    // actions.propose() re-derives what is available rather than believing
    // the prompt only offered legal things, and returns null for every
    // "she should not have proposed that" case. Never blocks the reply: the
    // reply is already saved and the proposal is an extra.
    //
    // A standing authority makes propose() execute inline, so `proposal`
    // here may already be done or failed rather than pending. The client
    // renders from `status`, which is why both go down the same rpc.
    let proposal = null;
    if (mayPropose && parsedResponse.proposed_action && !fellBack) {
      try {
        proposal = await actions.propose(
          session.profile_id,
          session.id,
          parsedResponse.proposed_action,
        );
      } catch (e) {
        // A standing-authority execution that failed at the provider lands
        // here. The athena_action row is already terminal with the error on
        // it, so the person can still see what happened in their history.
        console.warn("[gemini] action proposal failed:", e.message);
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
        parsedResponse.new_proficiency,
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
        parsedResponse.new_proficiency,
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

    // After the message on purpose: the card is the follow-up to what she
    // just said, and a card that arrives first reads as Athena acting
    // before she explained herself.
    if (proposal) {
      broadcast({ rpc: "actionProposed", action: proposal });
      // The dashboard's Notifications card is this list. It has no refresh
      // button, so the count only moves if we say so.
      try {
        require("../services/dashboardPriority").invalidate(session.profile_id);
      } catch (e) {
        console.warn("[gemini] priority invalidation failed:", e.message);
      }
      broadcast({ rpc: "dashboardUpdated", reason: "action_proposed" });
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
