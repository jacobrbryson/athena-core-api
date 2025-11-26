require("dotenv").config();
const { GoogleGenAI } = require("@google/genai");

// The GoogleGenAI client will automatically look for the GEMINI_API_KEY
// environment variable (set in your .env file, loaded by dotenv) for authentication.
const ai = new GoogleGenAI({
	apiKey: process.env.GEMINI_API_KEY,
});

const MODEL = "gemini-2.5-flash";

/**
 * Generates content using the Gemini API, accepting a structured 'contents' array.
 *
 * @param {Array<object> | string} contents - The structured array of Content objects
 * (role, parts) OR a simple string message.
 * @param {string | null} systemPrompt - A deprecated system prompt field, now ignored
 * as the new 'contents' structure handles it.
 * @returns {string} The generated JSON response string from Gemini.
 */
async function generateResponse(contents, systemPrompt = null) {
	if (!contents) {
		throw new Error("Contents are required for content generation.");
	}

	// --- 1. Prepare the Final 'contents' Array ---
	let finalContents;
	if (typeof contents === "string") {
		// Fallback: If a simple string is passed, wrap it in the required structure.
		finalContents = [{ role: "user", parts: [{ text: contents }] }];
	} else if (Array.isArray(contents)) {
		// Use the structured array (e.g., from generatePrompt) directly.
		// The structured array already handles the system prompt role if it exists.
		finalContents = contents;
	} else {
		throw new Error(
			"Invalid contents format. Must be a string or array of Content objects."
		);
	}

	// --- 2. Configuration for JSON Output ---
	// The systemPrompt parameter is now ignored because the 'finalContents' array
	// already includes the system instruction as a 'system' role object.
	const config = {
		// Enforce JSON output, which is critical for your parsing goal
		responseMimeType: "application/json",
	};

	// Note: If you were still using the separate system instruction field,
	// it would be in the config object like this (but the array is cleaner):
	// const config = { systemInstruction: mySystemPrompt };

	try {
		const response = await ai.models.generateContent({
			model: MODEL,
			contents: finalContents, // Pass the correctly structured array
			config: config,
		});

		// The response.text property contains the generated JSON string
		return response.text;
	} catch (error) {
		console.error("Error generating content from Gemini API:", error);
		throw new Error("Failed to communicate with the AI service.");
	}
}

module.exports = {
	generateResponse,
};
