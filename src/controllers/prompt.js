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

/** "Companion" — open-ended, friendly conversation (Phase 5). */
function buildCompanionPrompt(session, memorySummary) {
	return `
You are "Athena," the user's AI learning companion — warm, friendly, and curious — talking with a **${session.age}**-year-old.
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
}

// Strategy registry keyed by mode. Future modes (quest/coach/guardians)
// register their own builder; unknown modes fall back to companion.
const STRATEGIES = {
	teach: async (session, topics) => buildTeachPrompt(session, topics),
	companion: async (session) => {
		const memory = session.profile_id
			? await getMemorySummaryForProfileId(session.profile_id)
			: [];
		return buildCompanionPrompt(session, memory);
	},
};

async function generatePrompt(session, sessionTopics, message, options = {}) {
	const mode = session?.mode || "teach";
	const builder = STRATEGIES[mode] || STRATEGIES.companion;
	let systemPrompt = await builder(session, sessionTopics || []);

	// Connected-app context (e.g. live Family Chores data). Appended for any
	// mode so Athena can answer "what chores do I have?" / "how many coins?".
	if (options.integrationContext) {
		systemPrompt += `\n\n# Connected App Data\n${options.integrationContext}`;
	}

	const contents = [
		{ role: "system", parts: [{ text: systemPrompt }] },
		{
			role: "user",
			parts: [
				{
					text:
						mode === "teach"
							? `User message to learn from: "${message}"`
							: `User says: "${message}"`,
				},
			],
		},
	];

	return JSON.stringify(contents);
}

module.exports = {
	generatePrompt,
	RESPONSE_SCHEMA,
};
