require("dotenv").config();
const { GoogleGenAI } = require("@google/genai");

// The GoogleGenAI client will automatically look for the GEMINI_API_KEY
// environment variable (set in your .env file, loaded by dotenv) for authentication.
const ai = new GoogleGenAI({
	apiKey: process.env.GEMINI_API_KEY,
});

const MODEL = "gemini-2.5-flash";
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
const TTS_VOICE = process.env.GEMINI_TTS_VOICE || "Aoede";
const TTS_SAMPLE_RATE = 24000;

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

/**
 * Low-level generateContent passthrough used for the tool-calling phase.
 * Unlike generateResponse (which forces JSON output), this returns the raw
 * SDK response so callers can inspect functionCalls / candidate content and
 * drive a manual function-calling loop. `config` is passed straight through
 * (e.g. `{ tools: [{ functionDeclarations }] }`).
 */
async function generateContentRaw(contents, config = {}) {
	if (!Array.isArray(contents)) {
		throw new Error("generateContentRaw requires a contents array.");
	}
	return ai.models.generateContent({ model: MODEL, contents, config });
}

/**
 * Generate Athena's spoken reply as 24 kHz, mono, signed 16-bit PCM.
 * The direction is deliberately stable so every turn sounds like the same
 * character while the model can still perform punctuation and emotion
 * naturally instead of reading with the browser's OS voice.
 */
async function generateSpeech(text) {
	if (typeof text !== "string" || !text.trim()) {
		throw new Error("Speech text is required.");
	}

	const prompt = [
		"Perform the transcript exactly as Athena, a warm, intelligent, human-sounding guide.",
		"Use a natural conversational pace, fluid phrasing, subtle emotion, and brief realistic pauses.",
		"Never announce these directions and do not add or remove words.",
		"Transcript:",
		text.trim(),
	].join("\n");

	try {
		const response = await ai.models.generateContent({
			model: TTS_MODEL,
			contents: [{ role: "user", parts: [{ text: prompt }] }],
			config: {
				responseModalities: ["AUDIO"],
				speechConfig: {
					voiceConfig: {
						prebuiltVoiceConfig: { voiceName: TTS_VOICE },
					},
				},
			},
		});

		const part = response.candidates?.[0]?.content?.parts?.find(
			(candidate) => candidate.inlineData?.data
		);
		if (!part?.inlineData?.data) {
			throw new Error("Gemini returned no speech audio.");
		}

		return {
			audioBase64: part.inlineData.data,
			mimeType: part.inlineData.mimeType || `audio/L16;rate=${TTS_SAMPLE_RATE}`,
			sampleRate: TTS_SAMPLE_RATE,
			channels: 1,
		};
	} catch (error) {
		console.error("Error generating speech from Gemini API:", error);
		throw new Error("Failed to generate Athena speech.");
	}
}

module.exports = {
	generateResponse,
	generateContentRaw,
	generateSpeech,
};
