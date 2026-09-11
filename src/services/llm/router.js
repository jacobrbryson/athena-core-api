/**
 * The model router: picks which endpoint serves each call and falls back down
 * the chain when one fails.
 *
 * Ordering comes from the policy (local-first by default: Orcwood, then
 * frontier). Endpoints with an open circuit are skipped — unless every
 * candidate is open, in which case we try them anyway (half-open) rather than
 * refuse to answer. An optional `validate(text)` lets callers reject malformed
 * output (e.g. a local model's broken JSON) and move on to the next tier;
 * validation failures are logged but don't trip the circuit, since the
 * endpoint itself is healthy.
 */
const { loadConfig, TASKS } = require("./config");
const health = require("./health");
const telemetry = require("./telemetry");
const geminiAdapter = require("./adapters/gemini");
const openaiAdapter = require("./adapters/openaiCompat");

let config = loadConfig();
const probedModels = new Map(); // endpointId -> model ids the server reported

function adapterFor(endpoint) {
	return endpoint.kind === "gemini" ? geminiAdapter : openaiAdapter;
}

function allEndpoints() {
	return [...config.orcwood, ...config.frontier];
}

/** Ordered candidate endpoints for a task (before health filtering). */
function candidatesFor(task, { audience } = {}) {
	const spec = TASKS[task];
	if (!spec) throw new Error(`Unknown LLM task "${task}"`);
	const canDo = (e) => !!e.models?.[task];
	const orc = config.orcwood.filter(canDo);
	const front = config.frontier.filter(canDo);
	if (spec.pinned === "frontier") return front;

	const policy = audience === "child" ? config.childPolicy : config.policy;
	if (policy === "frontier-only") return front;
	if (policy === "frontier-first") return [...front, ...orc];
	return [...orc, ...front];
}

function orderByHealth(candidates) {
	const up = candidates.filter((e) => health.isAvailable(e.id));
	return up.length ? up : candidates;
}

function inputSize(contents) {
	return typeof contents === "string" ? contents.length : JSON.stringify(contents || "").length;
}

class NoModelAvailableError extends Error {
	constructor(task, attempts) {
		super(`No model could serve "${task}" (${attempts.map((a) => `${a.id}: ${a.error}`).join("; ") || "none configured"})`);
		this.name = "NoModelAvailableError";
		this.attempts = attempts;
	}
}

/**
 * Generate text/JSON for a task. Returns { text, endpointId, tier, model }.
 * Throws NoModelAvailableError only after every candidate has failed.
 */
async function generate({ task = "chat", contents, json = true, schema = null, audience, validate, temperature }) {
	const chain = orderByHealth(candidatesFor(task, { audience }));
	const attempts = [];

	for (let i = 0; i < chain.length; i++) {
		const endpoint = chain[i];
		const started = Date.now();
		try {
			const out = await adapterFor(endpoint).generate(endpoint, {
				task,
				contents,
				json,
				schema,
				temperature,
			});
			const latencyMs = Date.now() - started;
			health.reportSuccess(endpoint.id, latencyMs);

			if (validate) {
				const problem = safeValidate(validate, out.text);
				if (problem) {
					telemetry.recordCall({
						task, endpointId: endpoint.id, tier: endpoint.tier, model: out.model,
						outcome: "invalid", latencyMs, attempt: i, audience,
						inputChars: inputSize(contents), outputChars: out.text?.length, error: problem,
					});
					attempts.push({ id: endpoint.id, error: `invalid output: ${problem}` });
					continue;
				}
			}

			telemetry.recordCall({
				task, endpointId: endpoint.id, tier: endpoint.tier, model: out.model,
				outcome: "ok", latencyMs, attempt: i, audience,
				inputChars: inputSize(contents), outputChars: out.text?.length,
			});
			return { text: out.text, endpointId: endpoint.id, tier: endpoint.tier, model: out.model };
		} catch (err) {
			const latencyMs = Date.now() - started;
			health.reportFailure(endpoint.id, err);
			telemetry.recordCall({
				task, endpointId: endpoint.id, tier: endpoint.tier, model: endpoint.models?.[task],
				outcome: "error", latencyMs, attempt: i, audience,
				inputChars: inputSize(contents), error: err.message,
			});
			attempts.push({ id: endpoint.id, error: err.message });
		}
	}
	throw new NoModelAvailableError(task, attempts);
}

/**
 * Call ONE specific endpoint, no fallback — used by the nightly capability
 * evals to score each model on its own. Still logged, but as task "eval" so
 * it never skews production metrics.
 */
async function generateOn(endpointId, { task = "chat", contents, json = true, schema = null, temperature }) {
	const endpoint = allEndpoints().find((e) => e.id === endpointId);
	if (!endpoint) throw new Error(`Unknown endpoint "${endpointId}"`);
	if (!endpoint.models?.[task]) throw new Error(`${endpointId} has no model for "${task}"`);
	const started = Date.now();
	try {
		const out = await adapterFor(endpoint).generate(endpoint, { task, contents, json, schema, temperature });
		telemetry.recordCall({ task: "eval", endpointId, tier: endpoint.tier, model: out.model, outcome: "ok", latencyMs: Date.now() - started });
		return { text: out.text, latencyMs: Date.now() - started, model: out.model, tier: endpoint.tier };
	} catch (err) {
		telemetry.recordCall({ task: "eval", endpointId, tier: endpoint.tier, model: endpoint.models[task], outcome: "error", latencyMs: Date.now() - started, error: err.message });
		throw err;
	}
}

/** Endpoints able to run a task (for evals and status). */
function endpointsFor(task) {
	return allEndpoints().filter((e) => !!e.models?.[task]);
}

function safeValidate(validate, text) {
	try {
		const result = validate(text);
		return result === true || result == null ? null : String(result || "rejected");
	} catch (err) {
		return err.message || "rejected";
	}
}

/** Gemini-format function-calling (frontier only). Returns the raw SDK response. */
async function raw(contents, cfg = {}) {
	const endpoint = config.frontier.find((e) => e.models?.tools);
	if (!endpoint) throw new NoModelAvailableError("tools", []);
	const started = Date.now();
	try {
		const res = await geminiAdapter.raw(endpoint, contents, cfg);
		health.reportSuccess(endpoint.id, Date.now() - started);
		telemetry.recordCall({ task: "tools", endpointId: endpoint.id, tier: endpoint.tier, model: endpoint.models.tools, outcome: "ok", latencyMs: Date.now() - started });
		return res;
	} catch (err) {
		health.reportFailure(endpoint.id, err);
		telemetry.recordCall({ task: "tools", endpointId: endpoint.id, tier: endpoint.tier, model: endpoint.models.tools, outcome: "error", latencyMs: Date.now() - started, error: err.message });
		throw err;
	}
}

/**
 * Embed texts in the ONE active embedding space. Deliberately no cross-model
 * fallback: a vector from a different model would silently corrupt recall.
 * Callers treat a throw as "semantic recall unavailable" and degrade to
 * keyword search. Returns { vectors, space, dims }.
 */
async function embed(texts, { purpose = "document" } = {}) {
	const { endpointId, model } = config.embed;
	const endpoint = allEndpoints().find((e) => e.id === endpointId);
	if (!endpoint) throw new Error(`Embedding endpoint "${endpointId}" is not configured`);
	const list = Array.isArray(texts) ? texts : [texts];
	const started = Date.now();
	try {
		const vectors = await adapterFor(endpoint).embed(endpoint, list, { model, purpose });
		health.reportSuccess(endpoint.id, Date.now() - started);
		telemetry.recordCall({ task: "embed", endpointId: endpoint.id, tier: endpoint.tier, model, outcome: "ok", latencyMs: Date.now() - started, inputChars: list.join("").length });
		return { vectors, space: `${endpointId}:${model}`, dims: vectors[0]?.length || 0 };
	} catch (err) {
		health.reportFailure(endpoint.id, err);
		telemetry.recordCall({ task: "embed", endpointId: endpoint.id, tier: endpoint.tier, model, outcome: "error", latencyMs: Date.now() - started, error: err.message });
		throw err;
	}
}

function embeddingSpace() {
	return `${config.embed.endpointId}:${config.embed.model}`;
}

async function speech(text) {
	const endpoint = config.frontier.find((e) => e.models?.tts);
	if (!endpoint) throw new NoModelAvailableError("tts", []);
	const started = Date.now();
	try {
		const out = await geminiAdapter.speech(endpoint, text);
		health.reportSuccess(endpoint.id, Date.now() - started);
		telemetry.recordCall({ task: "tts", endpointId: endpoint.id, tier: endpoint.tier, model: endpoint.models.tts, outcome: "ok", latencyMs: Date.now() - started, inputChars: text.length });
		return out;
	} catch (err) {
		health.reportFailure(endpoint.id, err);
		telemetry.recordCall({ task: "tts", endpointId: endpoint.id, tier: endpoint.tier, model: endpoint.models.tts, outcome: "error", latencyMs: Date.now() - started, error: err.message });
		throw err;
	}
}

/** Active health: probe Orcwood endpoints so recovery is noticed without traffic. */
async function probeAll() {
	await Promise.all(
		config.orcwood.map(async (endpoint) => {
			const started = Date.now();
			try {
				const models = await openaiAdapter.probe(endpoint);
				probedModels.set(endpoint.id, models);
				health.reportSuccess(endpoint.id, Date.now() - started);
			} catch (err) {
				health.reportFailure(endpoint.id, err);
			}
		})
	);
}

let loop = null;
function startHealthLoop(intervalMs = 60_000) {
	if (loop || !config.orcwood.length) return;
	probeAll().catch(() => undefined);
	loop = setInterval(() => probeAll().catch(() => undefined), intervalMs);
	loop.unref?.();
}

/** Which tier would serve a task right now (first healthy candidate). */
function servingTier(task, opts) {
	const chain = orderByHealth(candidatesFor(task, opts));
	return chain[0] ? { endpointId: chain[0].id, tier: chain[0].tier, model: chain[0].models[task] } : null;
}

function status() {
	const byId = new Map(health.snapshot().map((h) => [h.id, h]));
	const describe = (e) => ({
		id: e.id,
		tier: e.tier,
		models: e.models,
		reportedModels: probedModels.get(e.id) || null,
		health: byId.get(e.id) || { id: e.id, available: true, circuit: "closed", calls: 0 },
	});
	return {
		policy: config.policy,
		childPolicy: config.childPolicy,
		embeddingSpace: embeddingSpace(),
		serving: {
			chat: servingTier("chat"),
			vision: servingTier("vision"),
			extract: servingTier("extract"),
		},
		orcwood: config.orcwood.map(describe),
		frontier: config.frontier.map(describe),
		recentCalls: telemetry.recent(20),
	};
}

/** Test hook: re-read env and clear health. */
function reload() {
	config = loadConfig();
	health.reset();
	probedModels.clear();
}

module.exports = {
	generate,
	generateOn,
	endpointsFor,
	raw,
	embed,
	embeddingSpace,
	speech,
	status,
	servingTier,
	candidatesFor,
	startHealthLoop,
	probeAll,
	reload,
	NoModelAvailableError,
};
