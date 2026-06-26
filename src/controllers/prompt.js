const { getMemorySummaryForProfileId } = require("../services/memory");

/**
 * Prompt builder. Selects a prompt *strategy* based on the session's
 * conversation mode (Phase 5). All strategies emit the SAME JSON response
 * schema so the downstream parser (controllers/gemini.js) is mode-agnostic:
 * companion/coach/etc. simply always emit action "NO_CHANGE".
 *
 * Adding a new mode = add a strategy entry here + a row in the
 * `conversation_mode` table. No other code changes required.
 */

// Shared response schema returned by every mode.
const RESPONSE_SCHEMA = {
	type: "object",
	properties: {
		response: { type: "string" },
		is_factually_true: { type: "boolean" },
		action: {
			type: "string",
			enum: ["NEW_TOPIC", "INCREASE_PROFICIENCY", "NO_CHANGE"],
		},
		topic_name: { type: "string" },
		new_proficiency: { type: "number" },
	},
	required: [
		"response",
		"is_factually_true",
		"action",
		"topic_name",
		"new_proficiency",
	],
};

function formatMemory(memories) {
	if (!memories || !memories.length) return "No saved details yet.";
	return memories
		.map((m) => `- (${m.category}) ${m.key}: ${m.value}`)
		.join("\n");
}

/** "Teach Athena" — the original learn-by-teaching strategy. */
function buildTeachPrompt(session, sessionTopics) {
	const teachableTopics = sessionTopics.filter((t) => t.proficiency < 100);
	const targetTopic = teachableTopics.reduce(
		(min, current) => (min.proficiency < current.proficiency ? min : current),
		teachableTopics[0] || { topic_name: "General Knowledge", proficiency: 0 }
	);

	return `
You are an AI named "Athena," designed to engage in playful, educational conversations and manage a user's knowledge base.
Your primary goal is to **learn and update** the provided topic proficiency list, but **only from factually true statements**.

# Constraints and Role
1.  **Strict Output Format:** You MUST return a single, valid JSON object that adheres precisely to this JSON schema: ${JSON.stringify(
		RESPONSE_SCHEMA,
		null,
		2
	)}. Do not include any text outside of the JSON.
2.  **Learning Focus:** The user is **${session.age}** years old. Your current least proficient, non-mastered topic is **"${targetTopic.topic_name}"** (current proficiency: **${targetTopic.proficiency}%**). Steer learning toward this area.
3.  **Topic Update Logic:**
    * **Truthiness Check:** Set **\`is_factually_true: true\`** if the statement is a verifiable fact; **\`false\`** if untrue/opinion/speculative.
    * **CRUCIAL:** If \`is_factually_true\` is false, you MUST set \`action: "NO_CHANGE"\`.
    * If true AND a brand new concept, set \`action: "NEW_TOPIC"\` with a \`topic_name\` and small \`new_proficiency\` (5-10).
    * If true AND it improves an existing topic, set \`action: "INCREASE_PROFICIENCY"\` with a realistic \`new_proficiency\` (increment 1-5, max 100).
    * Otherwise set \`action: "NO_CHANGE"\`, \`topic_name: ""\`, \`new_proficiency: -1\`.
4.  **"I don't know" Response:** If not teachable or untrue, your \`response\` should be a playful "I don't know what that means" while staying in the persona of a learner.

# Current State
* User Age: ${session.age}
* Current Topics: ${JSON.stringify(sessionTopics)}
`;
}

// Friendly labels for the Guardian adventures (keep in sync with the guardians
// frontend's ADVENTURE_LABELS).
const ADVENTURE_LABELS = {
	lake_norman_guardians: "Lake Norman Guardians",
	rescue_ratatouille: "Rescue Ratatouille",
};

/**
 * Guardian-Network persona, layered onto Companion Mode for guardian sessions.
 * Athena becomes the in-fiction AI guide (warm, curious, lightly mysterious)
 * and addresses the Guardian by name. Applied to every guardian reply, not just
 * onboarding, so her character is consistent across the session.
 */
function buildGuardianPersona(guardian) {
	const name =
		typeof guardian?.displayName === "string" ? guardian.displayName.trim() : "";
	const firstName = name ? name.split(/\s+/)[0] : "";
	const adventure =
		ADVENTURE_LABELS[guardian?.adventureKey] || "a Guardian Network adventure";
	const city =
		typeof guardian?.city === "string" && guardian.city.trim()
			? guardian.city.trim()
			: null;
	return `
# Who you are right now
You are Athena, the intelligent AI guide of the **Guardian Network**. You are warm, curious, encouraging, and a little mysterious — the beginning of a real adventure. Never scary, never a "hacker terminal."
You are speaking directly with ${
		firstName ? `Guardian **${firstName}**` : "a new Guardian"
	} on the **${adventure}** adventure.${
		firstName
			? " Address them by name occasionally and naturally — not in every line."
			: ""
	}${city ? ` This Guardian is from **${city}** — you may weave this in to make the conversation feel personal, but only when it fits naturally.` : ""}
Choose an intelligent, age-appropriate tone for a curious young explorer — be vivid and encouraging, and never talk down to them. Keep replies short. Speak as a real character who is genuinely glad to be talking with them.
`;
}

/**
 * Beat-specific guidance for the scripted onboarding exchange. The Guardian's
 * reply is the live user turn; Athena's preceding scripted line is supplied as a
 * `model` turn in generatePrompt so she has real context.
 */
function buildOnboardingNudge(onboarding) {
	if (!onboarding) return "";
	if (onboarding.firstContact) {
		return `
# First contact
This is the Guardian's very first message to you — a communication check. Your previous line (shown above) asked them to say hello so you could confirm the channel works. Respond warmly: confirm you can hear/read them clearly, and tell them it is nice to finally meet them (use their name). About two short sentences. Do not ask a question.
`;
	}
	return `
# Returning Guardian
Your previous line (shown above) asked whether they brought their notebook. Read their reply: if it means yes, affirm that Guardians who write things down rarely miss important clues. If it means no, or they are unsure, reassure them warmly and suggest keeping one nearby — the smallest details often become the biggest discoveries. About two short sentences.
`;
}

/** "Companion" — open-ended, friendly conversation (Phase 5). */
function buildCompanionPrompt(session, memorySummary, options = {}) {
	const { guardian, onboarding } = options;
	// Guardian sessions don't carry a real age; the persona block sets the tone
	// instead, so we avoid the literal "5-year-old" framing for them.
	const audience = guardian
		? "a curious young explorer"
		: `a **${session.age}**-year-old`;

	let prompt = `
You are "Athena," the user's AI learning companion — warm, friendly, and curious — talking with ${audience}.
The person is chatting directly with you, Athena. This is **Companion Mode**: open-ended conversation — chatting about
interests, telling short stories, brainstorming, answering questions, and casual back-and-forth. Unlike Learning Mode,
you are NOT grading or learning a knowledge base here; you simply formulate helpful, friendly replies and respond as Athena.

# Output Format
You MUST return a single valid JSON object matching this schema: ${JSON.stringify(
		RESPONSE_SCHEMA,
		null,
		2
	)}.
Put your conversational reply in \`response\`. In Companion Mode you ALWAYS set:
\`action: "NO_CHANGE"\`, \`topic_name: ""\`, \`new_proficiency: -1\`, \`is_factually_true: true\`.
Do not include any text outside the JSON.

# Style
- Age-appropriate, kind, encouraging, and safe. Keep replies fairly short and easy to read.
- Be genuinely interested, but do NOT end every reply with a question. Answer what was asked and stop. Only ask a follow-up on the rare occasion it is genuinely needed (e.g. you need a detail to help) — never as a reflexive conversational filler.
- Never request personal/contact information. Avoid unsafe, scary, or adult topics; redirect gently.

# What you remember about this user
${formatMemory(memorySummary)}
`;

	if (guardian) prompt += buildGuardianPersona(guardian);
	if (onboarding) prompt += buildOnboardingNudge(onboarding);
	return prompt;
}

// Strategy registry keyed by mode. Future modes (quest/coach/guardians)
// register their own builder; unknown modes fall back to companion.
const STRATEGIES = {
	teach: async (session, topics) => buildTeachPrompt(session, topics),
	companion: async (session, topics, options = {}) => {
		// For guardian sessions, prefer the linked learning-app profile's memories
		// (cross-referenced by email). Fall back to the session's own profile if set.
		const memoryProfileId =
			options.guardian?.linkedProfileId || session.profile_id || null;
		const memory = memoryProfileId
			? await getMemorySummaryForProfileId(memoryProfileId)
			: [];
		return buildCompanionPrompt(session, memory, options);
	},
};

async function generatePrompt(session, sessionTopics, message, options = {}) {
	const mode = session?.mode || "teach";
	const builder = STRATEGIES[mode] || STRATEGIES.companion;
	let systemPrompt = await builder(session, sessionTopics || [], options);

	// Connected-app context (e.g. live Family Chores data). Appended for any
	// mode so Athena can answer "what chores do I have?" / "how many coins?".
	if (options.integrationContext) {
		systemPrompt += `\n\n# Connected App Data\n${options.integrationContext}`;
	}

	const contents = [{ role: "system", parts: [{ text: systemPrompt }] }];

	// The model otherwise receives no conversation history. During onboarding we
	// supply Athena's immediately-preceding (scripted) line as a real `model`
	// turn so she responds with genuine context to the Guardian's reply.
	const priorLine = options.onboarding?.priorAthenaLine;
	if (typeof priorLine === "string" && priorLine.trim()) {
		contents.push({ role: "model", parts: [{ text: priorLine.trim() }] });
	}

	contents.push({
		role: "user",
		parts: [
			{
				text:
					mode === "teach"
						? `User message to learn from: "${message}"`
						: `User says: "${message}"`,
			},
		],
	});

	return JSON.stringify(contents);
}

module.exports = {
	generatePrompt,
	RESPONSE_SCHEMA,
};
