/**
 * OpenAI-compatible adapter (Orcwood tier).
 *
 * Speaks the /v1/chat/completions + /v1/embeddings dialect that Ollama, vLLM,
 * llama.cpp server and LM Studio all implement, so any of them can back an
 * Orcwood endpoint with no code change.
 */

/**
 * Gemini-style contents -> OpenAI messages.
 *
 * The chat prompt builder hands the router a JSON *string* of Gemini contents.
 * Gemini receives that string verbatim (legacy behavior, preserved in the
 * Gemini adapter); local models do much better with real roles, so here we
 * unpack it back into a proper message list when it parses.
 */
function toMessages(contents) {
	let list = contents;
	if (typeof contents === "string") {
		try {
			const parsed = JSON.parse(contents);
			list = Array.isArray(parsed) && parsed.every((c) => c && c.role) ? parsed : null;
		} catch {
			list = null;
		}
		if (!list) return [{ role: "user", content: contents }];
	}
	if (!Array.isArray(list)) throw new Error("Invalid contents format.");

	return list.map((c) => {
		const role = c.role === "model" ? "assistant" : c.role === "system" ? "system" : "user";
		const parts = Array.isArray(c.parts) ? c.parts : [];
		const hasImage = parts.some((p) => p?.inlineData?.data);
		if (!hasImage) {
			return { role, content: parts.map((p) => p?.text || "").join("\n") };
		}
		return {
			role,
			content: parts
				.map((p) => {
					if (p?.inlineData?.data) {
						const mime = p.inlineData.mimeType || "image/jpeg";
						return {
							type: "image_url",
							image_url: { url: `data:${mime};base64,${p.inlineData.data}` },
						};
					}
					return p?.text ? { type: "text", text: p.text } : null;
				})
				.filter(Boolean),
		};
	});
}

/**
 * Reasoning models (Qwen3, DeepSeek-R1 distills) emit <think>…</think> before
 * the answer, and small models like to fence JSON in ```json blocks. Strip
 * both so callers get the bare payload.
 */
function cleanOutput(text, json) {
	let out = String(text || "")
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.trim();
	if (json) {
		const fenced = out.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
		if (fenced) out = fenced[1].trim();
	}
	return out;
}

/**
 * The endpoint's API key. An Orcwood box carries it inline; a hosted provider
 * names a secret instead, so a rotated key is picked up at call time (through
 * the cached resolver) rather than at deploy time.
 */
async function resolveKey(endpoint) {
	if (endpoint.apiKey) return endpoint.apiKey;
	if (!endpoint.apiKeySecret) return "";
	return (await require("../../secrets").getSecret(endpoint.apiKeySecret)) || "";
}

async function post(endpoint, path, body, timeoutMs) {
	await require("../../../security/access").assertModelAccess();
	const apiKey = await resolveKey(endpoint);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs || endpoint.timeoutMs);
	try {
		const res = await fetch(`${endpoint.baseUrl}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`${endpoint.id} ${path} -> HTTP ${res.status} ${detail.slice(0, 200)}`);
		}
		return await res.json();
	} catch (err) {
		if (err.name === "AbortError") throw new Error(`${endpoint.id} ${path} timed out`);
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

async function generate(endpoint, { task, contents, json = true, schema = null, temperature }) {
	const model = endpoint.models[task] || endpoint.models.chat;
	if (!model) throw new Error(`${endpoint.id} has no model for task "${task}"`);

	const body = { model, messages: [{ role: "system", content: require("../../../security/mission").CORE_MISSION }, ...toMessages(contents)], stream: false };
	if (Number.isFinite(temperature)) body.temperature = temperature;
	if (json) {
		body.response_format =
			schema && endpoint.supportsJsonSchema
				? { type: "json_schema", json_schema: { name: "athena", schema, strict: true } }
				: { type: "json_object" };
	}

	const data = await post(endpoint, "/chat/completions", body);
	const text = cleanOutput(data?.choices?.[0]?.message?.content, json);
	if (!text) throw new Error(`${endpoint.id} returned an empty completion`);
	return { text, model, usage: data?.usage || null };
}

async function embed(endpoint, texts, { model } = {}) {
	const name = model || endpoint.models.embed;
	if (!name) throw new Error(`${endpoint.id} has no embedding model`);
	const data = await post(endpoint, "/embeddings", { model: name, input: texts });
	const rows = Array.isArray(data?.data) ? [...data.data] : [];
	rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
	return rows.map((r) => r.embedding);
}

const IMAGE_MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

/**
 * Image generation (POST /images/generations).
 *
 * Goes through post(), so the access guard runs here exactly as it does for
 * text — this is a token-consuming path like any other.
 *
 * `response_format` is deliberately NOT sent: the GPT image models reject it
 * and always return base64, and sending it is an error rather than a no-op.
 * Older DALL-E models accept it but default to a URL, so reading b64_json with
 * a url fallback covers both without branching on the model name.
 */
async function image(endpoint, prompt, { size, quality, n = 1, outputFormat } = {}) {
	const model = endpoint.models.image;
	if (!model) throw new Error(`${endpoint.id} has no image model`);

	const body = { model, prompt, n: Math.min(Math.max(Number(n) || 1, 1), 4) };
	if (size) body.size = size;
	if (quality) body.quality = quality;
	if (outputFormat) body.output_format = outputFormat;

	const data = await post(endpoint, "/images/generations", body);
	const rows = Array.isArray(data?.data) ? data.data : [];
	const images = rows
		.map((row) => {
			if (row.b64_json) {
				return {
					b64: row.b64_json,
					mimeType: IMAGE_MIME[outputFormat] || "image/png",
					revisedPrompt: row.revised_prompt || null,
				};
			}
			// DALL-E without response_format=b64_json returns a short-lived URL.
			return row.url ? { url: row.url, revisedPrompt: row.revised_prompt || null } : null;
		})
		.filter(Boolean);

	if (!images.length) throw new Error(`${endpoint.id} returned no image data`);
	return { images, model, usage: data?.usage || null };
}

/** Cheap liveness probe used by the router's background health loop. */
async function probe(endpoint) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 4000);
	try {
		const apiKey = await resolveKey(endpoint);
		const res = await fetch(`${endpoint.baseUrl}/models`, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json().catch(() => ({}));
		return (data?.data || []).map((m) => m.id).filter(Boolean);
	} finally {
		clearTimeout(timer);
	}
}

module.exports = { generate, embed, image, probe, toMessages, cleanOutput };
