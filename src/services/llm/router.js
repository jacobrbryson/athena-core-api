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
const autotune = require("./autotune");
const preference = require("./preference");
const drill = require("./drill");
const geminiAdapter = require("./adapters/gemini");
const openaiAdapter = require("./adapters/openaiCompat");
const jevAdapter = require("./adapters/jev");

let config = loadConfig();
const probedModels = new Map(); // endpointId -> model ids the server reported
const lastDecisions = new Map(); // task -> the latest routing decision (status / Models tab)

/** A drilled endpoint fails like this — and is never reported to health.js. */
function drillError(endpoint) {
	const d = drill.blocked(endpoint);
	if (!d) return null;
	const err = new Error(d.error);
	err.drill = d;
	return err;
}

function adapterFor(endpoint) {
	return endpoint.kind === "gemini" ? geminiAdapter : openaiAdapter;
}

function allEndpoints() {
	return [...config.orcwood, ...config.frontier];
}

/** Ordered candidate endpoints for a task (before health filtering). */
function candidatesFor(task, { audience, prefer } = {}) {
	const spec = TASKS[task];
	if (!spec) throw new Error(`Unknown LLM task "${task}"`);
	const canDo = (e) => !!e.models?.[task];
	const orc = config.orcwood.filter(canDo);
	const front = config.frontier.filter(canDo);
	if (spec.pinned === "frontier") return front;

	const policy = audience === "child" ? config.childPolicy : config.policy;
	if (policy === "frontier-only") return front;
	// A caller can ask for the frontier first on one call (a reply resting on
	// web results, where a small local model is likeliest to embellish). It
	// can only move the frontier up; the local tier stays as the fallback.
	// "smart" starts from the same order; preference.js then lets a local
	// endpoint lead when it has earned it.
	if (policy === "frontier-first" || policy === "smart" || prefer === "frontier") return [...front, ...orc];
	return [...orc, ...front];
}

function orderByHealth(candidates) {
	const up = candidates.filter((e) => health.isAvailable(e.id));
	return up.length ? up : candidates;
}

/** The ordered chain for one call, and the reasoning behind its first choice. */
function plan(task, opts = {}) {
	const policy = opts.audience === "child" ? config.childPolicy : config.policy;
	const calls = telemetry.recent(200);
	const tuned = autotune.tune(orderByHealth(candidatesFor(task, opts)), task, calls, opts).ordered;
	let { ordered, decision } = TASKS[task]?.pinned
		? { ordered: tuned, decision: { task, policy, lead: { endpointId: tuned[0]?.id || null, why: "only a cloud model can do this" }, local: [] } }
		: preference.decide(tuned, task, { ...opts, policy, calls });
	// `avoid` moves one endpoint to the back: a critic should not be the model
	// that wrote the draft. It is a preference, not an exclusion — with a
	// single endpoint configured, that endpoint still answers.
	if (opts.avoid) ordered = [...ordered.filter((e) => e.id !== opts.avoid), ...ordered.filter((e) => e.id === opts.avoid)];
	return { ordered, decision };
}

function managedCandidates(task, opts = {}) {
	return plan(task, opts).ordered;
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
async function generate({ task = "chat", contents, json = true, schema = null, audience, validate, temperature, prefer, avoid, urgency }) {
	const { ordered: chain, decision } = plan(task, { audience, prefer, avoid, urgency, contents });
	lastDecisions.set(task, { ...decision, at: Date.now() });
	const attempts = [];

	for (let i = 0; i < chain.length; i++) {
		const endpoint = chain[i];
		const drilled = drillError(endpoint);
		if (drilled) {
			attempts.push({ id: endpoint.id, error: drilled.message, drill: true });
			continue;
		}
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
			// Why this endpoint answered: its own lead, or a fallback after the
			// ones before it failed (attempts says which and how).
			const why = i === 0 && endpoint.id === decision.lead?.endpointId
				? decision.lead.why
				: `fallback after ${attempts.map((a) => a.id).join(", ") || "reordering"}`;
			return {
				text: out.text, endpointId: endpoint.id, tier: endpoint.tier, model: out.model,
				fallback: attempts.length > 0, why, urgency: decision.urgency || null,
				attempts,
			};
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
	const drilled = drillError(endpoint);
	if (drilled) throw drilled;
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
	const drilled = drillError(endpoint);
	if (drilled) throw drilled;
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
 * Search the web (Gemini + Google Search grounding). Frontier-only, first
 * endpoint that declares a search model, no fallback: a failed search means
 * no web context, never a guess. `urls` are pages the person named, which the
 * model opens itself. Returns { text, sources, queries, model }.
 */
async function search(query, { audience, urls } = {}) {
	const endpoint = config.frontier.find((e) => e.models?.search && adapterFor(e).search);
	if (!endpoint) throw new NoModelAvailableError("search", []);
	const drilled = drillError(endpoint);
	if (drilled) throw drilled;
	const started = Date.now();
	try {
		const out = await adapterFor(endpoint).search(endpoint, query, { urls });
		health.reportSuccess(endpoint.id, Date.now() - started);
		telemetry.recordCall({ task: "search", endpointId: endpoint.id, tier: endpoint.tier, model: out.model, outcome: "ok", latencyMs: Date.now() - started, audience, inputChars: query.length, outputChars: out.text.length });
		return out;
	} catch (err) {
		health.reportFailure(endpoint.id, err);
		telemetry.recordCall({ task: "search", endpointId: endpoint.id, tier: endpoint.tier, model: endpoint.models.search, outcome: "error", latencyMs: Date.now() - started, audience, error: err.message });
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
	const drilled = drillError(endpoint);
	if (drilled) throw drilled;
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

/**
 * Generate an image. Frontier-only and binary, so it has its own path rather
 * than going through generate(); it still falls down the chain of frontier
 * endpoints that declare an image model, the way text does.
 *
 * Returns { images, endpointId, model }.
 */
async function image(prompt, opts = {}) {
	if (typeof prompt !== "string" || !prompt.trim()) {
		throw new Error("Image generation requires a prompt");
	}
	const chain = orderByHealth(config.frontier.filter((e) => !!e.models?.image));
	const attempts = [];

	for (const endpoint of chain) {
		const drilled = drillError(endpoint);
		if (drilled) {
			attempts.push({ id: endpoint.id, error: drilled.message, drill: true });
			continue;
		}
		const started = Date.now();
		try {
			const out = await adapterFor(endpoint).image(endpoint, prompt, opts);
			const latencyMs = Date.now() - started;
			health.reportSuccess(endpoint.id, latencyMs);
			telemetry.recordCall({
				task: "image", endpointId: endpoint.id, tier: endpoint.tier, model: out.model,
				outcome: "ok", latencyMs, inputChars: prompt.length,
			});
			return { images: out.images, endpointId: endpoint.id, model: out.model };
		} catch (err) {
			const latencyMs = Date.now() - started;
			health.reportFailure(endpoint.id, err);
			telemetry.recordCall({
				task: "image", endpointId: endpoint.id, tier: endpoint.tier,
				model: endpoint.models?.image, outcome: "error", latencyMs, error: err.message,
			});
			attempts.push({ id: endpoint.id, error: err.message });
		}
	}
	throw new NoModelAvailableError("image", attempts);
}

/** Spoken audio; `{ sing: true }` sings the text instead, on the `sing` model. */
async function speech(text, { sing = false } = {}) {
	const task = sing ? "sing" : "tts";
	const endpoint = config.frontier.find((e) => e.models?.[task]);
	if (!endpoint) throw new NoModelAvailableError(task, []);
	const drilled = drillError(endpoint);
	if (drilled) throw drilled;
	const started = Date.now();
	try {
		const out = await geminiAdapter.speech(endpoint, text, { sing });
		health.reportSuccess(endpoint.id, Date.now() - started);
		telemetry.recordCall({ task, endpointId: endpoint.id, tier: endpoint.tier, model: endpoint.models[task], outcome: "ok", latencyMs: Date.now() - started, inputChars: text.length });
		return out;
	} catch (err) {
		health.reportFailure(endpoint.id, err);
		telemetry.recordCall({ task, endpointId: endpoint.id, tier: endpoint.tier, model: endpoint.models[task], outcome: "error", latencyMs: Date.now() - started, error: err.message });
		throw err;
	}
}

/**
 * Typed decisions from Jev (TypeSafe's System One model): probabilities, not
 * text. One hosted endpoint, no fallback — a caller treats a throw as "no
 * guess" and carries on without one, which is always safe.
 */
async function decide({ state, questions, timeoutMs, task = "decide" }) {
	const started = Date.now();
	try {
		const out = await jevAdapter.decide({ state, questions, timeoutMs });
		const latencyMs = Date.now() - started;
		health.reportSuccess("jev", latencyMs);
		telemetry.recordCall({ task, endpointId: "jev", tier: "frontier", model: out.model, outcome: "ok", latencyMs, inputChars: inputSize(state) });
		return { ...out, latencyMs };
	} catch (err) {
		health.reportFailure("jev", err);
		telemetry.recordCall({ task, endpointId: "jev", tier: "frontier", model: jevAdapter.MODEL, outcome: "error", latencyMs: Date.now() - started, error: err.message });
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
				// A probe proves listening, not generating — see health.js.
				health.reportProbeOk(endpoint.id, Date.now() - started);
			} catch (err) {
				health.reportFailure(endpoint.id, err);
			}
		})
	);
}

/**
 * The Models tab's "ping the desktop": is each local endpoint reachable, what
 * has it loaded, and does its token gate refuse a request without the token?
 * Reads /models only — no generation, no tokens spent.
 */
async function pingLocal() {
	return Promise.all(
		config.orcwood.map(async (endpoint) => {
			const out = { endpointId: endpoint.id, baseUrl: endpoint.baseUrl, viaTailnet: !!endpoint.tailnet, reachable: false, latencyMs: null, models: [], missing: [], gate: "unknown", error: null };
			const started = Date.now();
			try {
				out.models = await openaiAdapter.probe(endpoint);
				out.latencyMs = Date.now() - started;
				out.reachable = true;
				const wanted = [...new Set(Object.values(endpoint.models || {}).filter(Boolean))];
				out.missing = wanted.filter((m) => !out.models.some((have) => have === m || have.startsWith(`${m}:`)));
			} catch (err) {
				out.error = String(err.message || err).slice(0, 160);
			}
			try {
				await openaiAdapter.probe({ ...endpoint, apiKey: "", apiKeySecret: null });
				out.gate = "open"; // answered without a token
			} catch (err) {
				out.gate = /HTTP 40[13]/.test(String(err.message)) ? "enforced" : out.reachable ? "unknown" : "unreachable";
			}
			return out;
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
	const chain = managedCandidates(task, opts).filter((e) => !drill.blocked(e));
	return chain[0] ? { endpointId: chain[0].id, tier: chain[0].tier, model: chain[0].models[task] } : null;
}

/** The routing decision a call would get right now, without calling a model. */
function preview(task, opts = {}) {
	if (!TASKS[task]) throw new Error(`Unknown LLM task "${task}"`);
	const { ordered, decision } = plan(task, opts);
	const chain = ordered.map((e) => {
		const h = health.snapshot().find((s) => s.id === e.id);
		const d = drill.blocked(e);
		return { endpointId: e.id, tier: e.tier, model: e.models?.[task] || null, available: !d && (h ? h.available : true), drilled: d ? d.scenario : null, openReason: h?.openReason || null };
	});
	const serving = chain.find((c) => c.available) || null;
	return { task, decision, chain, serving };
}

// What a person loses while every endpoint able to do these is down.
const CAPABILITIES = [
	{ task: "tts", label: "her voice" },
	{ task: "search", label: "web search" },
	{ task: "tools", label: "some connected-service lookups" },
	{ task: "image", label: "making pictures" },
	{ task: "embed", label: "memory search by meaning (keyword search still works)" },
];

const NAMES = { gemini: "Gemini", openai: "OpenAI" };
const nameOf = (e) => NAMES[e.id] || (e.tier === "orcwood" ? "the desktop model" : e.id);

/**
 * Is anything down, and what does it mean for a person? Drives the outage
 * banner and the Models tab. level: ok | degraded | down.
 */
function outage(now = Date.now()) {
	const snap = new Map(health.snapshot(now).map((h) => [h.id, h]));
	const down = [];
	for (const e of allEndpoints()) {
		const d = drill.blocked(e, now);
		const h = snap.get(e.id);
		if (d && d.scope === "server") down.push({ endpointId: e.id, name: nameOf(e), tier: e.tier, reason: d.kind, drill: d.scenario, reopensInMs: null });
		else if (h && !h.available) down.push({ endpointId: e.id, name: nameOf(e), tier: e.tier, reason: h.openReason || "errors", drill: null, reopensInMs: h.reopensInMs, since: h.openedAt });
	}
	const downIds = new Set(down.map((d) => d.endpointId));
	const chatChain = managedCandidates("chat");
	const chat = chatChain.find((e) => !downIds.has(e.id)) || null;
	const lost = CAPABILITIES.filter(({ task }) => {
		const able = task === "embed" ? allEndpoints().filter((e) => e.id === config.embed.endpointId) : endpointsFor(task);
		return able.length > 0 && able.every((e) => downIds.has(e.id));
	}).map((c) => c.label);

	// A backup being down (the desktop asleep, OpenAI out) changes nothing a
	// person notices, so it is reported but doesn't raise the banner. Losing
	// the main cloud model, a capability, or chat altogether does.
	const primary = config.frontier.find((e) => e.models?.chat) || null;
	const primaryDown = !!primary && downIds.has(primary.id);
	const level = !chat ? "down" : primaryDown || lost.length ? "degraded" : "ok";
	const backupDown = level === "ok" ? down : [];
	let message = null;
	if (level !== "ok") {
		const why = (d) => (d.reason === "quota" ? "is out of quota" : d.reason === "timeout" ? "isn't responding" : d.reason === "rate_limit" ? "is rate-limiting" : "is failing");
		const first = down.map((d) => `${d.name} ${why(d)}`).join("; ");
		const answering = chat ? `Athena is answering with ${nameOf(chat)}${chat.tier === "orcwood" ? " (slower)" : ""}.` : "Athena can't answer right now.";
		message = `${first.charAt(0).toUpperCase()}${first.slice(1)}. ${answering}${lost.length ? ` Unavailable: ${lost.join(", ")}.` : ""}`;
	}
	return {
		level,
		message,
		down,
		backupDown,
		answering: chat ? { endpointId: chat.id, tier: chat.tier, model: chat.models.chat, name: nameOf(chat) } : null,
		lost,
		drill: drill.describeServerDrill(now),
	};
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
		automaticManagement: {
			mode: "same-tier-routing",
			windowMs: autotune.WINDOW_MS,
			minimumSamples: autotune.MIN_SAMPLES,
			slowResponseMs: autotune.SLOW_MS,
			tasks: Object.fromEntries(["chat", "json", "vision", "extract", "review"].map((task) => [task,
				autotune.tune(candidatesFor(task), task, telemetry.recent(200)).diagnostics,
			])),
		},
		childPolicy: config.childPolicy,
		embeddingSpace: embeddingSpace(),
		serving: {
			chat: servingTier("chat"),
			vision: servingTier("vision"),
			extract: servingTier("extract"),
		},
		outage: outage(),
		decisions: Object.fromEntries([...lastDecisions.entries()].map(([task, d]) => [task, { at: d.at, urgency: d.urgency || null, lead: d.lead }])),
		orcwood: config.orcwood.map(describe),
		frontier: config.frontier.map(describe),
		recentCalls: telemetry.recent(20),
	};
}

/** Test hook: re-read env and clear health. */
function reload() {
	config = loadConfig();
	health.reset();
	drill.reset();
	lastDecisions.clear();
	probedModels.clear();
}

module.exports = {
	generate,
	generateOn,
	endpointsFor,
	raw,
	search,
	embed,
	embeddingSpace,
	image,
	speech,
	decide,
	status,
	servingTier,
	preview,
	outage,
	pingLocal,
	candidatesFor,
	startHealthLoop,
	probeAll,
	reload,
	NoModelAvailableError,
};
