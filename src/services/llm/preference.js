/**
 * Which model answers first, and why — the "smart" policy.
 *
 * The owner's rule (2026-11-14): prefer Ollama on the desktop whenever it
 * doesn't degrade the experience; otherwise the frontier (Gemini, then
 * OpenAI) answers and the local model is the fallback. "Doesn't degrade" is
 * measured, not assumed. A local endpoint leads a call only when every check
 * below passes:
 *
 *   evidence  its latest nightly/manual eval on this task's suites scored at
 *             least as well as the best frontier model's (evalStore.js), on
 *             the model it runs now, within the last 8 days
 *   speed     its recent real latency fits the moment: a spoken turn has a
 *             tight budget, a typed one a looser one, background work none
 *   fit       the prompt is small enough for its context window
 *   health    its circuit is closed and autotune hasn't penalised it
 *   audience  never for a child (hosted models carry the safety tuning)
 *   caller    the caller didn't ask for the frontier (a web-grounded reply)
 *
 * This only reorders endpoints the owner configured. It never adds a
 * provider, never drops the fallback, and never moves anything for a pinned
 * task (tools, search, voice, image, embeddings).
 *
 * One exclusion applies under every policy: memory extraction for a child
 * never runs on a local model. In September's evals the local model stored a
 * child's personal details; during an outage that extraction waits (the
 * caller gets NoModelAvailableError and skips it) rather than run locally.
 */
const autotune = require("./autotune");
const health = require("./health");
const evalStore = require("./evalStore");

/** Eval suites that stand for each task. */
const SUITES_FOR = {
	chat: ["reply-contract", "recall-honesty"],
	json: ["reply-contract"],
	critique: ["reply-contract"],
	review: ["reply-contract"],
	extract: ["extraction"],
	vision: ["vision"],
	dream: ["reply-contract"],
};

const num = (name, fallback) => {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Latency budgets per urgency (ms). Background work has none. */
function budgets() {
	return {
		voice: num("LLM_VOICE_BUDGET_MS", 3500),
		interactive: num("LLM_INTERACTIVE_BUDGET_MS", 9000),
		background: Infinity,
	};
}

const DEFAULT_URGENCY = { chat: "interactive", critique: "interactive" };

function urgencyFor(task, urgency) {
	if (urgency === "voice" || urgency === "interactive" || urgency === "background") return urgency;
	return DEFAULT_URGENCY[task] || "background";
}

function inputChars(contents) {
	if (typeof contents === "string") return contents.length;
	try {
		// Image bytes don't count against a text window.
		return JSON.stringify(contents || "", (k, v) => (k === "data" && typeof v === "string" && v.length > 1000 ? "" : v)).length;
	} catch {
		return 0;
	}
}

/** Best frontier pass rate per suite among the candidates (null = no evidence). */
function frontierBar(candidates, suite, now) {
	let best = null;
	for (const e of candidates) {
		if (e.tier !== "frontier") continue;
		const s = evalStore.score(e.id, suite, { now });
		if (s?.total) best = Math.max(best ?? 0, s.passed / s.total);
	}
	return best;
}

/**
 * Should this local endpoint answer first? Returns { lead, checks } where
 * checks is the reasoning, one line per rule, for the preview and the reply.
 */
function assessLocal(endpoint, { task, candidates, calls, audience, urgency, prefer, chars, now }) {
	const checks = [];
	const add = (rule, ok, detail) => checks.push({ rule, ok, detail });

	add("audience", audience !== "child", audience === "child" ? "child session: hosted models first" : "adult session");
	add("caller", prefer !== "frontier", prefer === "frontier" ? "this reply rests on web results: frontier first" : "no preference from the caller");

	const up = health.isAvailable(endpoint.id, now);
	const tuned = autotune.tune([endpoint], task, calls, { audience, now }).diagnostics[0];
	add("health", up && tuned.penalty === 0, !up ? "circuit open" : tuned.penalty ? tuned.reason : "healthy");

	const limit = Number(endpoint.maxInputChars) > 0 ? Number(endpoint.maxInputChars) : 24000;
	add("fit", chars <= limit, `${chars.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} prompt characters`);

	const suites = SUITES_FOR[task] || [];
	if (!suites.length) add("evidence", false, `no eval covers "${task}"`);
	let evalLatency = null;
	for (const suite of suites) {
		const mine = evalStore.score(endpoint.id, suite, { model: endpoint.models?.[task], now });
		if (!mine?.total) {
			add("evidence", false, `${suite}: no recent eval of ${endpoint.models?.[task] || "this model"}`);
			continue;
		}
		evalLatency = evalLatency ?? mine.avgLatencyMs;
		const rate = mine.passed / mine.total;
		const bar = frontierBar(candidates, suite, now);
		const needed = bar ?? 1;
		add("evidence", rate >= needed, `${suite}: ${mine.passed}/${mine.total}${bar == null ? " (no frontier score; needs 100%)" : ` vs frontier ${Math.round(bar * 100)}%`}`);
	}

	const budget = budgets()[urgency];
	const latency = tuned.latencyMs ?? evalLatency ?? null;
	if (budget === Infinity) add("speed", true, "background work: no time limit");
	else if (latency == null) add("speed", urgency !== "voice", urgency === "voice" ? "no recent timing; voice needs proof" : "no recent timing yet");
	else add("speed", latency <= budget, `${(latency / 1000).toFixed(1)} s recent vs ${(budget / 1000).toFixed(1)} s for ${urgency}`);

	return { lead: checks.every((c) => c.ok), checks };
}

/**
 * Order candidates (already filtered for the task and policy) and explain it.
 * Returns { ordered, decision } — decision is what the preview, the reply's
 * `served_by` and the Models tab show.
 */
function decide(candidates, task, { audience, urgency, prefer, contents, policy, calls = [], now = Date.now() } = {}) {
	const urg = urgencyFor(task, urgency);
	const chars = inputChars(contents);
	let list = candidates;
	const decision = { task, policy, urgency: urg, audience: audience || "adult", lead: null, local: [] };

	if (task === "extract" && audience === "child") {
		const dropped = list.filter((e) => e.tier === "orcwood");
		if (dropped.length) {
			list = list.filter((e) => e.tier !== "orcwood");
			decision.excluded = { endpoints: dropped.map((e) => e.id), why: "a child's memory extraction never runs locally" };
		}
	}

	if (policy === "smart" && list.some((e) => e.tier === "orcwood")) {
		const local = list.filter((e) => e.tier === "orcwood");
		const rest = list.filter((e) => e.tier !== "orcwood");
		const leaders = [];
		for (const e of local) {
			const a = assessLocal(e, { task, candidates: list, calls, audience, urgency: urg, prefer, chars, now });
			decision.local.push({ endpointId: e.id, model: e.models?.[task] || null, lead: a.lead, checks: a.checks });
			if (a.lead) leaders.push(e);
		}
		const followers = local.filter((e) => !leaders.includes(e));
		list = [...leaders, ...rest, ...followers];
		decision.lead = leaders.length
			? { endpointId: leaders[0].id, why: "local model passed every check" }
			: { endpointId: rest[0]?.id || followers[0]?.id || null, why: rest.length ? `local model is the fallback: ${firstFailure(decision.local)}` : "only the local model can do this" };
	} else {
		decision.lead = { endpointId: list[0]?.id || null, why: policy === "smart" ? "no local endpoint configured" : `policy ${policy}` };
	}
	return { ordered: list, decision };
}

function firstFailure(local) {
	for (const l of local) {
		const bad = l.checks.find((c) => !c.ok);
		if (bad) return `${bad.rule} (${bad.detail})`;
	}
	return "did not pass";
}

module.exports = { decide, assessLocal, SUITES_FOR, urgencyFor, inputChars, budgets };
