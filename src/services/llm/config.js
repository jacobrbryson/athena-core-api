/**
 * Model-router configuration.
 *
 * Athena's models live in three tiers, tried in order of preference:
 *
 *   device   — runs on the user's phone / browser / car head unit. The server
 *              never calls it; it only publishes the manifest that tells
 *              devices which model to download (see manifest.js).
 *   orcwood  — Orcwood-owned (or local dev) servers speaking the OpenAI-
 *              compatible HTTP API: Ollama, vLLM, llama.cpp server, LM Studio.
 *   frontier — hosted frontier models (Gemini today). The last resort, and the
 *              only tier for capabilities local models lack (TTS, Gemini-format
 *              tool calling).
 *
 * Everything is env-driven so a new Orcwood box is a config change, not a
 * code deploy:
 *
 *   LLM_ORCWOOD_ENDPOINTS  JSON array of endpoints, e.g.
 *     [{"id":"orcwood-1","baseUrl":"http://10.0.0.5:11434/v1",
 *       "models":{"chat":"qwen3:8b","vision":"qwen2.5vl:7b","embed":"nomic-embed-text"}}]
 *   LLM_POLICY             local-first (default) | frontier-first | frontier-only
 *   LLM_CHILD_POLICY       policy for child-profile sessions (default frontier-first:
 *                          hosted models carry stronger safety tuning for kids)
 *   LLM_EMBED_MODEL        "<endpointId>:<model>" naming the ONE active embedding
 *                          space (default gemini:gemini-embedding-001)
 */

const GEMINI_CHAT_MODEL = "gemini-3.5-flash-lite";

const POLICIES = new Set(["local-first", "frontier-first", "frontier-only"]);

// Tasks the router understands. A `pinned` task never leaves that tier because
// the other tiers can't do it (yet).
const TASKS = {
	chat: { pinned: null }, // Athena's conversational reply (strict JSON)
	json: { pinned: null }, // generic structured generation (chore suggestions, etc.)
	extract: { pinned: null }, // background memory extraction
	vision: { pinned: null }, // image -> structured JSON scene description
	review: { pinned: null }, // nightly self-review / planning
	tools: { pinned: "frontier" }, // Gemini function-calling format
	tts: { pinned: "frontier" }, // Gemini neural voice
	// Embeddings never fall back across models: vectors from different models
	// are not comparable. See LLM_EMBED_MODEL and embed() in router.js.
	embed: { pinned: "embed" },
};

function parseJsonEnv(name, fallback) {
	const raw = process.env[name];
	if (!raw || !raw.trim()) return fallback;
	try {
		return JSON.parse(raw);
	} catch (err) {
		console.warn(`[llm] ${name} is not valid JSON — ignoring:`, err.message);
		return fallback;
	}
}

function normalizeEndpoint(e, index) {
	if (!e || typeof e !== "object" || typeof e.baseUrl !== "string") return null;
	const models = e.models && typeof e.models === "object" ? e.models : {};
	return {
		id: typeof e.id === "string" && e.id.trim() ? e.id.trim() : `orcwood-${index + 1}`,
		tier: "orcwood",
		kind: "openai",
		baseUrl: e.baseUrl.replace(/\/$/, ""),
		apiKey: typeof e.apiKey === "string" ? e.apiKey : "",
		// Per-task model names. `chat` doubles as the default for json/extract/review.
		models: {
			chat: models.chat || null,
			json: models.json || models.chat || null,
			extract: models.extract || models.chat || null,
			review: models.review || models.chat || null,
			vision: models.vision || null,
			embed: models.embed || null,
		},
		// Whether the server honors response_format json_schema (vLLM, LM Studio,
		// recent Ollama). Otherwise we ask for json_object and validate ourselves.
		supportsJsonSchema: e.supportsJsonSchema === true,
		timeoutMs: Number(e.timeoutMs) > 0 ? Number(e.timeoutMs) : 25000,
		priority: Number.isFinite(Number(e.priority)) ? Number(e.priority) : 100,
	};
}

function loadConfig() {
	const orcwood = parseJsonEnv("LLM_ORCWOOD_ENDPOINTS", [])
		.map(normalizeEndpoint)
		.filter(Boolean)
		.sort((a, b) => a.priority - b.priority);

	const frontier = [];
	if (process.env.GEMINI_API_KEY) {
		frontier.push({
			id: "gemini",
			tier: "frontier",
			kind: "gemini",
			models: {
				chat: GEMINI_CHAT_MODEL,
				json: GEMINI_CHAT_MODEL,
				extract: GEMINI_CHAT_MODEL,
				review: GEMINI_CHAT_MODEL,
				vision: GEMINI_CHAT_MODEL,
				tools: GEMINI_CHAT_MODEL,
				embed: process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001",
				tts: process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts",
			},
			timeoutMs: 60000,
			priority: 0,
		});
	}

	const policy = POLICIES.has(process.env.LLM_POLICY)
		? process.env.LLM_POLICY
		: "local-first";
	const childPolicy = POLICIES.has(process.env.LLM_CHILD_POLICY)
		? process.env.LLM_CHILD_POLICY
		: "frontier-first";

	const embedSpec = (process.env.LLM_EMBED_MODEL || "gemini:gemini-embedding-001").trim();
	const sep = embedSpec.indexOf(":");
	const embed = {
		endpointId: sep > 0 ? embedSpec.slice(0, sep) : "gemini",
		model: sep > 0 ? embedSpec.slice(sep + 1) : embedSpec,
	};

	return { orcwood, frontier, policy, childPolicy, embed };
}

module.exports = { loadConfig, TASKS, POLICIES, GEMINI_CHAT_MODEL };
