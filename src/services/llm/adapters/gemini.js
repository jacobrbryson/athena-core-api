/**
 * Gemini (frontier tier) adapter.
 *
 * The text path deliberately reproduces the pre-router request byte-for-byte
 * (a string prompt is wrapped as one user turn; arrays pass through; JSON mode
 * via responseMimeType) so routing to Gemini changes nothing in production.
 */
const { GoogleGenAI } = require("@google/genai");

const TTS_VOICE = process.env.GEMINI_TTS_VOICE || "Aoede";
const TTS_SAMPLE_RATE = 24000;
// Stored vector width. gemini-embedding-001 supports 768/1536/3072 via
// Matryoshka truncation; 768 keeps per-memory storage small with little loss.
const EMBED_DIMS = Number(process.env.GEMINI_EMBED_DIMS) || 768;

let client = null;
function ai() {
	if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
	return client;
}

function toContents(contents) {
	if (typeof contents === "string") {
		return [{ role: "user", parts: [{ text: contents }] }];
	}
	if (Array.isArray(contents)) return contents;
	throw new Error("Invalid contents format. Must be a string or array of Content objects.");
}

/**
 * The answer text, without thought parts. (Reading `response.text` directly
 * works too, but the SDK logs a warning on every call whose response carries
 * a thoughtSignature part.)
 */
function answerText(response) {
	const parts = response?.candidates?.[0]?.content?.parts;
	if (!Array.isArray(parts)) return response?.text;
	return parts
		.filter((p) => typeof p.text === "string" && !p.thought)
		.map((p) => p.text)
		.join("");
}

async function generate(endpoint, { task, contents, json = true }) {
	const model = endpoint.models[task] || endpoint.models.chat;
	const config = json ? { responseMimeType: "application/json" } : {};
	const response = await ai().models.generateContent({
		model,
		contents: toContents(contents),
		config,
	});
	return { text: answerText(response), model, usage: response.usageMetadata || null };
}

/** Raw SDK passthrough for the Gemini function-calling loop (integration.js). */
async function raw(endpoint, contents, config = {}) {
	if (!Array.isArray(contents)) {
		throw new Error("generateContentRaw requires a contents array.");
	}
	return ai().models.generateContent({ model: endpoint.models.tools, contents, config });
}

async function embed(endpoint, texts, { model, purpose = "document" } = {}) {
	const response = await ai().models.embedContent({
		model: model || endpoint.models.embed,
		contents: texts,
		config: {
			taskType: purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
			outputDimensionality: EMBED_DIMS,
		},
	});
	return (response.embeddings || []).map((e) => e.values);
}

/**
 * Athena's spoken reply as 24 kHz mono signed 16-bit PCM. The direction is
 * deliberately stable so every turn sounds like the same character.
 */
async function speech(endpoint, text) {
	const prompt = [
		"Perform the transcript exactly as Athena, a warm, intelligent, human-sounding guide.",
		"Use a natural conversational pace, fluid phrasing, subtle emotion, and brief realistic pauses.",
		"Never announce these directions and do not add or remove words.",
		"Transcript:",
		text.trim(),
	].join("\n");

	const response = await ai().models.generateContent({
		model: endpoint.models.tts,
		contents: [{ role: "user", parts: [{ text: prompt }] }],
		config: {
			responseModalities: ["AUDIO"],
			speechConfig: {
				voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } },
			},
		},
	});

	const part = response.candidates?.[0]?.content?.parts?.find(
		(candidate) => candidate.inlineData?.data
	);
	if (!part?.inlineData?.data) throw new Error("Gemini returned no speech audio.");

	return {
		audioBase64: part.inlineData.data,
		mimeType: part.inlineData.mimeType || `audio/L16;rate=${TTS_SAMPLE_RATE}`,
		sampleRate: TTS_SAMPLE_RATE,
		channels: 1,
	};
}

module.exports = { generate, raw, embed, speech, EMBED_DIMS, _setClient: (c) => (client = c) };
