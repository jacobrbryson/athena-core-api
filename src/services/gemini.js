require("dotenv").config();
const llm = require("./llm");
const { GEMINI_CHAT_MODEL } = require("./llm/config");

/**
 * Compatibility shim. All model calls now go through the tiered router in
 * ./llm (device -> Orcwood -> frontier with fallback); these wrappers keep the
 * original Gemini-service signatures so existing callers are unchanged.
 * New code should require("./llm") directly.
 */

const MODEL = GEMINI_CHAT_MODEL;

/**
 * Generate a JSON response string. `contents` may be a string or an array of
 * Gemini Content objects. Routed as the generic "json" task.
 */
async function generateResponse(contents) {
	if (!contents) {
		throw new Error("Contents are required for content generation.");
	}
	try {
		const { text } = await llm.generate({ task: "json", contents, json: true });
		return text;
	} catch (error) {
		console.error("Error generating content from the model router:", error.message);
		throw new Error("Failed to communicate with the AI service.");
	}
}

/** Raw Gemini generateContent for the function-calling loop (frontier only). */
async function generateContentRaw(contents, config = {}) {
	return llm.raw(contents, config);
}

/** Athena's neural voice as 24 kHz mono 16-bit PCM (frontier only). */
async function generateSpeech(text) {
	if (typeof text !== "string" || !text.trim()) {
		throw new Error("Speech text is required.");
	}
	try {
		return await llm.speech(text);
	} catch (error) {
		console.error("Error generating speech:", error.message);
		throw new Error("Failed to generate Athena speech.");
	}
}

module.exports = {
	MODEL,
	generateResponse,
	generateContentRaw,
	generateSpeech,
};
