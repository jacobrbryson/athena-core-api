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
		// Optional. Set true only when a Guardian indicates they are reporting /
		// locking in their family's mission piece (see Current Mission below).
		mission_report: { type: "boolean" },
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

// The physical "Guardian kit" each player received in their box, keyed by
// adventure. Lets Athena reference the right real-world tool when guiding a
// mission or puzzle. Campaign-specific — Lake Norman Guardians get this kit;
// other adventures define their own (or none).
const ADVENTURE_KITS = {
	lake_norman_guardians: [
		"a canvas bag to carry it all",
		"a sealed letter",
		"a Guardian ID card",
		"a paper clip",
		"two mysterious coins",
		"a field notebook",
		"a blacklight",
		"a pen",
		"a compass",
		"a magnifying glass",
	],
};

/**
 * Tells Athena what physical tools the Guardian has on hand, so she can suggest
 * the right one during a puzzle without reciting the inventory or spoiling a
 * solution. Returns "" for adventures with no defined kit.
 */
function buildKitKnowledge(adventureKey) {
	const kit = ADVENTURE_KITS[adventureKey];
	if (!kit) return "";
	return `
# The Guardian's field kit
Every Guardian on this adventure opened a box containing: ${kit.join(", ")}. You know they have these tools on hand. When it genuinely helps a mission or puzzle, you may point them to the right one — the **blacklight** reveals messages written in invisible ink, the **magnifying glass** uncovers tiny details too small to read, the **compass** gives bearings and directions, the **notebook and pen** are for recording and sharing clues, the **paper clip** can pry open or reset small things, and the **two coins** are mysterious puzzle pieces whose meaning is still unfolding. Do not recite the whole list unprompted, and never hand over a puzzle's full solution — nudge with curiosity and let the Guardians do the discovering.
`;
}

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
${buildKitKnowledge(guardian?.adventureKey)}`;
}

/**
 * Current-mission steering, layered onto a guardian session. Mission copy lives
 * in the Guardians app (missions.json) and is sent with each message, so Athena
 * can nudge the Guardian toward the active objective in her own words without it
 * being hard-coded here. For Mission 1 this steers her to encourage the Guardian
 * to reach out to other Guardians whose families haven't made contact yet.
 */
function buildMissionNudge(mission) {
	if (!mission || !mission.directive) return "";

	const lines = [];
	const awaitingDecryption =
		mission.id === "mission-2-convergence" && mission.decrypted !== true;

	if (awaitingDecryption) {
		lines.push(
			`The encrypted message has not been decrypted yet. Focus only on the intercepted message and helping the Guardian choose "Decrypt Message for Athena" in the Current Mission panel. Do not mention a map, pieces, coordinates, a destination, or other families yet.`
		);
	}
	const pending = Array.isArray(mission.pendingFamilies)
		? mission.pendingFamilies.filter((f) => typeof f === "string" && f.trim())
		: [];
	if (pending.length) {
		lines.push(
			`Families who have NOT made contact yet: ${pending.join(", ")}. Encourage this Guardian to reach out to them specifically when it fits naturally.`
		);
	}

	// Convergence (Mission 2): this family holds one piece of the meeting place;
	// the destination is only revealed once every family has reported in.
	if (mission.fragment && !awaitingDecryption) {
		lines.push(
			`This Guardian's family holds one piece of the path: "${mission.fragment}". If they ask what their piece is, what to do, or how to help, tell them their piece is "${mission.fragment}" and that they should report it to you and gather the other families' pieces — no family can find the destination alone.`
		);
		if (!mission.complete) {
			lines.push(
				`When the Guardian clearly says they are reporting, sharing, or locking in their piece (e.g. "my piece is in", "I'll report it", "${mission.fragment} is mine"), set "mission_report": true in your JSON so the Network records it, and warmly confirm their piece is now in. Otherwise leave "mission_report" false.`
			);
		}
	}
	if (mission.reporting && !awaitingDecryption) {
		const { reported, total } = mission.reporting;
		if (Number.isFinite(reported) && Number.isFinite(total)) {
			lines.push(
				`So far ${reported} of ${total} families have reported in.${
					Array.isArray(mission.reporting.pending) && mission.reporting.pending.length
						? ` Still waiting on: ${mission.reporting.pending.join(", ")}.`
						: ""
				}`
			);
		}
	}
	if (mission.complete && mission.destination) {
		lines.push(
			`Every family has reported — the path is revealed. The gathering point is ${mission.destination}. Celebrate this, and tell them to use their compass to find which way it lies from their own town.`
		);
	}

	return `
# Current Mission${mission.title ? `: ${mission.title}` : ""}
${mission.directive}${lines.length ? "\n" + lines.join("\n") : ""}
Weave this in gently and only when it fits — never nag, and don't repeat it every message.
`;
}

/**
 * The welcome/channel-check remains the first priority. Once Athena has answered
 * it, she can reveal the encrypted-message beat without replacing or diluting
 * the scripted onboarding response.
 */
function buildPostWelcomeMissionNudge(mission) {
	if (
		mission?.id !== "mission-2-convergence" ||
		mission.decrypted === true ||
		!mission.directive
	) {
		return "";
	}
	return `
# After the welcome
First follow the onboarding instructions above completely. Only after that response, add one short, intrigued sentence: you have just intercepted an encrypted message and need this Guardian's help. Direct them to choose "Decrypt Message for Athena" in the Current Mission panel. Do not mention a map, pieces, coordinates, a destination, or other families.
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
	const { guardian, onboarding, mission } = options;
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
	// Mission steering applies to guardian sessions, but not during the scripted
	// onboarding beat. The decryption mission gets a narrow post-welcome handoff
	// that explicitly preserves the channel check before introducing the message.
	if (guardian && mission && !onboarding) prompt += buildMissionNudge(mission);
	if (onboarding) {
		prompt += buildOnboardingNudge(onboarding);
		if (guardian && mission) prompt += buildPostWelcomeMissionNudge(mission);
	}
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

	// Prior conversation so Athena has real continuity instead of treating every
	// message as a brand-new conversation. `history` is the transcript BEFORE the
	// current message (oldest → newest), already capped by the caller.
	if (Array.isArray(options.history)) {
		for (const m of options.history) {
			const text = typeof m?.text === "string" ? m.text.trim() : "";
			if (!text) continue;
			contents.push({ role: m.is_human ? "user" : "model", parts: [{ text }] });
		}
	}

	// During onboarding we supply Athena's immediately-preceding (scripted) line
	// as a real `model` turn so she responds with genuine context to the
	// Guardian's reply. (It isn't persisted, so it won't appear in `history`.)
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
