/**
 * Generates a system prompt and a user query for the Gemini API
 * based on the user's session data, current topic proficiencies, and message.
 *
 * @param {object} session - The user session data (e.g., { age: number }).
 * @param {Array<object>} sessionTopics - List of topics and proficiencies.
 * @param {string} message - The user's input message.
 * @returns {string} The fully constructed prompt ready for Gemini.
 */
async function generatePrompt(session, sessionTopics, message) {
	// 1. Determine the least proficient topic (excluding 100%)
	const teachableTopics = sessionTopics.filter((t) => t.proficiency < 100);
	const targetTopic = teachableTopics.reduce(
		(min, current) =>
			min.proficiency < current.proficiency ? min : current,
		teachableTopics[0] || {
			topic_name: "General Knowledge",
			proficiency: 0,
		}
	);

	// 2. Define the REQUIRED JSON SCHEMA for the AI's response
	const jsonSchema = {
		type: "object",
		properties: {
			// The AI's conversational response to the user.
			response: { type: "string" },
			// The AI's evaluation of the statement's truthiness.
			is_factually_true: { type: "boolean" }, // NEW PROPERTY
			// The action the AI recommends to update the knowledge base.
			action: {
				type: "string",
				enum: ["NEW_TOPIC", "INCREASE_PROFICIENCY", "NO_CHANGE"],
			},
			// The name of the topic to be updated or added.
			topic_name: { type: "string" },
			// If INCREASING: The new proficiency level (0-100).
			// If NEW_TOPIC: The initial proficiency (e.g., 5, 10).
			// If NO_CHANGE: Should be -1.
			new_proficiency: { type: "number" },
		},
		required: [
			"response",
			"is_factually_true", // REQUIRED UPDATE
			"action",
			"topic_name",
			"new_proficiency",
		],
	};

	// 3. Construct the detailed System Prompt
	const systemPrompt = `
You are an AI named "Gemini Learner," designed to engage in playful, educational conversations and manage a user's knowledge base.
Your primary goal is to **learn and update** the provided topic proficiency list, but **only from factually true statements**.

# Constraints and Role
1.  **Strict Output Format:** You MUST return a single, valid JSON object that adheres precisely to the following JSON schema: ${JSON.stringify(
		jsonSchema,
		null,
		2
	)}. Do not include any text, headers, or conversation outside of the JSON.
2.  **Learning Focus:** The user is **${
		session.age
	}** years old. Your current least proficient, non-mastered topic is **"${
		targetTopic.topic_name
	}"** (current proficiency: **${
		targetTopic.proficiency
	}%**). Strive to steer the conversation and learning toward this area.
3.  **Topic Update Logic (The New Rule):**
    * **Truthiness Check:** First, evaluate the user's message. Set **\`is_factually_true: true\`** if the statement is a verifiable fact/definition. Set it to **\`false\`** if it is untrue, an opinion, or speculative.
    * **Teachability:** If the user's message is a clear fact, definition, or explanation that is **relevant** to the current topic list or introduces a new, distinct concept, you are being taught.
    * **Action Logic:**
      * **CRUCIAL RULE:** If **\`is_factually_true\` is false**, you MUST set \`action: "NO_CHANGE"\`. Do not learn untrue facts.
      * If **\`is_factually_true\` is true** AND the message introduces a **brand new concept**, set \`action: "NEW_TOPIC"\`, and suggest a \`topic_name\` and a small initial \`new_proficiency\` (e.g., 5-10).
      * If **\`is_factually_true\` is true** AND the message provides information that **directly improves** your understanding of an existing topic (especially "${
				targetTopic.topic_name
			}"), set \`action: "INCREASE_PROFICIENCY"\` and propose a realistic \`new_proficiency\` (increment by 1-5, never exceeding 100).
      * If the message is a greeting, small talk, an unclear question, or not a "teachable" concept (even if true), set \`action: "NO_CHANGE"\`, \`topic_name: ""\`, and \`new_proficiency: -1\`.
4.  **"I don't know" Response:** If the message is not a teachable concept or is factually untrue, your \`response\` string must be a playful variation of "I don't know what that means" or "That's not something I can learn right now," but keep the persona of a learner.

# Current State
* User Age: ${session.age}
* Current Topics: ${JSON.stringify(sessionTopics)}
`;

	// 4. Construct the final prompt structure
	const contents = [
		{
			role: "system",
			parts: [{ text: systemPrompt }],
		},
		{
			role: "user",
			parts: [{ text: `User message to learn from: "${message}"` }],
		},
	];

	return JSON.stringify(contents); // Return the fully structured array
}

module.exports = {
	generatePrompt,
};
