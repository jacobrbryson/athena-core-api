/**
 * Gemini (frontier tier) adapter.
 *
 * The text path deliberately reproduces the pre-router request byte-for-byte
 * (a string prompt is wrapped as one user turn; arrays pass through; JSON mode
 * via responseMimeType) so routing to Gemini changes nothing in production.
 */
const { GoogleGenAI } = require("@google/genai");
const { assertModelAccess } = require("../../../security/access");
const { CORE_MISSION } = require("../../../security/mission");

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

/**
 * Split a Content array into Gemini's shape: the `system` entries become a
 * system instruction (Gemini only accepts user/model roles in contents), and
 * the conversation turns stay as contents.
 *
 * This is what keeps replies parseable: previously the whole array was
 * JSON-stringified into one user message, and the model echoed that escaping
 * back (`{\"response\": ...}`) on roughly a tenth of chat turns.
 */
function toRequest(contents) {
	if (typeof contents === "string") {
		return { contents: [{ role: "user", parts: [{ text: contents }] }], system: null };
	}
	if (!Array.isArray(contents)) {
		throw new Error("Invalid contents format. Must be a string or array of Content objects.");
	}
	const system = contents
		.filter((c) => c?.role === "system")
		.flatMap((c) => (Array.isArray(c.parts) ? c.parts : []))
		.map((p) => p?.text || "")
		.filter(Boolean)
		.join("\n\n");
	return {
		contents: contents.filter((c) => c?.role !== "system"),
		system: system || null,
	};
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

async function generate(endpoint, { task, contents, json = true, schema = null }) {
	await assertModelAccess();
	const model = endpoint.models[task] || endpoint.models.chat;
	const request = toRequest(contents);
	const config = json ? { responseMimeType: "application/json" } : {};
	// CORE_MISSION always leads the system instruction (owner policy, security/mission.js);
	// the mode's prompt follows it.
	config.systemInstruction = request.system ? `${CORE_MISSION}\n\n${request.system}` : CORE_MISSION;
	// Structured output: the model is constrained to the caller's schema instead
	// of being asked politely for JSON in the prompt.
	if (json && schema) config.responseSchema = schema;
	const response = await ai().models.generateContent({
		model,
		contents: request.contents,
		config,
	});
	return {
		text: answerText(response),
		model,
		usage: response.usageMetadata || null,
		finishReason: response?.candidates?.[0]?.finishReason || null,
	};
}

/** Raw SDK passthrough for the Gemini function-calling loop (integration.js). */
async function raw(endpoint, contents, config = {}) {
	await assertModelAccess();
	config = { ...config, systemInstruction: CORE_MISSION };
	if (!Array.isArray(contents)) {
		throw new Error("generateContentRaw requires a contents array.");
	}
	return ai().models.generateContent({ model: endpoint.models.tools, contents, config });
}

/**
 * A web search, answered by Gemini with Google Search grounding. Returns a
 * short factual summary plus the pages it was grounded on. Kept apart from
 * generate() because grounding and a strict response schema don't mix: the
 * chat reply stays one schema-constrained call, and this result reaches it as
 * prompt context like any connector read.
 *
 *   { text, sources: [{ title, url }], queries: [...], model }
 */
async function search(endpoint, query) {
	await assertModelAccess();
	const model = endpoint.models.search;
	const response = await ai().models.generateContent({
		model,
		contents: [{ role: "user", parts: [{ text: query }] }],
		config: {
			tools: [{ googleSearch: {} }],
			systemInstruction: [
				CORE_MISSION,
				"Search the web and report what you find about the request below: the facts, figures, dates and names that answer it, most recent first.",
				"Plain prose, under 200 words. Say plainly when sources disagree or when nothing current turns up. Do not answer from memory alone.",
			].join("\n\n"),
		},
	});
	const metadata = response?.candidates?.[0]?.groundingMetadata || {};
	// One source per site. Every chunk carries its own Google redirect URL,
	// even two pages of the same site (or the same page cited twice), and the
	// title is only the domain — so deduplicating by URL showed "costco.com"
	// two or three times under one reply.
	const seen = new Set();
	const sources = [];
	for (const chunk of metadata.groundingChunks || []) {
		const url = chunk?.web?.uri;
		if (!url) continue;
		const title = chunk.web.title || url;
		const site = title.trim().toLowerCase();
		if (seen.has(site)) continue;
		seen.add(site);
		sources.push({ title, url });
	}
	return {
		text: (answerText(response) || "").trim(),
		sources,
		queries: Array.isArray(metadata.webSearchQueries) ? metadata.webSearchQueries : [],
		model,
	};
}

async function embed(endpoint, texts, { model, purpose = "document" } = {}) {
	await assertModelAccess();
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
 *
 * `sing` swaps in a singing direction on the `sing` model. The wording is the
 * one that won the 2026-09-26 listening test: asking it to "sing" alone
 * mostly produced rhythmic reading; naming sustained vowels and pitch changes,
 * and forbidding speech, produced held notes (~48% of voiced time vs ~13% for
 * the same lyrics spoken).
 */
async function speech(endpoint, text, { sing = false } = {}) {
	await assertModelAccess();
	const prompt = sing
		? [
				"You are Athena, singing. SING the lyrics below with a real melody: sustained vowels, clear pitch changes, steady rhythm.",
				"Do not speak or read them. Do not add any words.",
				"Lyrics:",
				text.trim(),
			].join("\n")
		: [
				"Perform the transcript exactly as Athena, a warm, intelligent, human-sounding guide.",
				"Use a natural conversational pace, fluid phrasing, subtle emotion, and brief realistic pauses.",
				"Never announce these directions and do not add or remove words.",
				"Transcript:",
				text.trim(),
			].join("\n");

	const response = await ai().models.generateContent({
		model: sing ? endpoint.models.sing : endpoint.models.tts,
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

module.exports = { generate, raw, search, embed, speech, EMBED_DIMS, _setClient: (c) => (client = c) };
