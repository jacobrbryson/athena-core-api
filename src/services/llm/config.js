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
 *
 * A second frontier provider (OpenAI) joins the chain when OPENAI_API_KEY is
 * set. Its per-task models are declared explicitly rather than defaulted,
 * because model availability differs per account — an invented id 404s at the
 * provider. Only the image model has a default, since image generation is the
 * reason the provider is here:
 *
 *   OPENAI_API_KEY         enables the endpoint
 *   OPENAI_CHAT_MODEL      opt in to OpenAI for chat/json/extract/review
 *   OPENAI_VISION_MODEL    opt in for image understanding
 *   OPENAI_DREAM_MODEL     the model Athena dreams with (services/dreams)
 *   OPENAI_IMAGE_MODEL     image generation (default gpt-image-1)
 *   OPENAI_PRIORITY        chain position; default 10, behind Gemini's 0
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
	// Dreaming (services/dreams): schema design + the dream retelling. Served
	// only by endpoints that declare a `dream` model — today OpenAI, via
	// OPENAI_DREAM_MODEL — and dream.js falls back to "review" when none can.
	dream: { pinned: null },
	tools: { pinned: "frontier" }, // Gemini function-calling format
	tts: { pinned: "frontier" }, // Gemini neural voice
	// Image generation. Frontier-only: no local tier does it, and the output is
	// binary, so it never goes through generate() — see image() in router.js.
	image: { pinned: "frontier" },
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

/**
 * The OpenAI frontier endpoint, or null when no key is configured.
 *
 * Speaks the OpenAI dialect, so the existing openaiCompat adapter serves it —
 * the same adapter the Orcwood tier uses, which already runs the
 * assertModelAccess guard on every dispatch.
 *
 * `apiKeySecret` (rather than a baked-in key) lets the adapter resolve the
 * value at call time through services/secrets, so a rotated key is picked up
 * without a redeploy.
 */
function buildOpenAi() {
	const enabled =
		!!process.env.OPENAI_API_KEY || process.env.OPENAI_ENABLED === "true";
	if (!enabled) return null;

	const chat = process.env.OPENAI_CHAT_MODEL || null;
	const models = {
		chat,
		json: process.env.OPENAI_JSON_MODEL || chat,
		extract: process.env.OPENAI_EXTRACT_MODEL || chat,
		review: process.env.OPENAI_REVIEW_MODEL || chat,
		vision: process.env.OPENAI_VISION_MODEL || null,
		// Explicit only: dreaming is the one task the owner chose ChatGPT for.
		dream: process.env.OPENAI_DREAM_MODEL || null,
		// gpt-image-1 is the long-standing id; newer gpt-image-2.5-* models
		// exist but are not on every account, so they are opt-in by env.
		image: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
	};

	return {
		id: "openai",
		tier: "frontier",
		kind: "openai",
		baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
		apiKey: process.env.OPENAI_API_KEY || "",
		apiKeySecret: "OPENAI_API_KEY",
		models,
		// OpenAI honors response_format json_schema with strict validation.
		supportsJsonSchema: true,
		timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS) || 60000,
		// Behind Gemini by default: adding the provider must not silently
		// re-route every existing conversation onto a new bill.
		priority: Number.isFinite(Number(process.env.OPENAI_PRIORITY))
			? Number(process.env.OPENAI_PRIORITY)
			: 10,
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

	const openai = buildOpenAi();
	if (openai) frontier.push(openai);
	frontier.sort((a, b) => a.priority - b.priority);

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

module.exports = { loadConfig, TASKS, POLICIES, GEMINI_CHAT_MODEL, buildOpenAi };
