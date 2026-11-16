/**
 * Outage drills: make a model look down on purpose, to prove the fallback works.
 *
 * Two scopes, both owner-only (controllers/llmLab.js checks that):
 *
 *   request   runWithDrill(scenario, fn) — only the calls made inside fn (and
 *             everything it awaits) see the outage. The family's traffic is
 *             untouched. Callers also wrap it in telemetry.runAsSmoke so the
 *             calls are logged as tests, not health signals.
 *   server    startServerDrill(scenario, minutes) — every call on THIS server
 *             instance sees the outage until it expires or is stopped. That is
 *             the only way to see the real banner on the phone and in the
 *             Guardians app. It is held in memory: a deploy or a new instance
 *             starts without it, and it always ends by itself (MAX_MINUTES).
 *
 * A drilled endpoint is never called and never reported to health.js: the
 * drill must not trip a real circuit, and a real circuit must not be hidden
 * by one. The router asks blocked(endpointId) before each attempt and treats a
 * blocked endpoint as failed with the scenario's error.
 */
const { AsyncLocalStorage } = require("node:async_hooks");

const MAX_MINUTES = 30;

/** What each scenario takes down, and the error it fails with. */
const SCENARIOS = {
	"gemini-quota": {
		label: "Gemini out of quota",
		blocks: (e) => e.id === "gemini",
		error: "drill: Gemini 429 RESOURCE_EXHAUSTED (quota)",
		kind: "quota",
	},
	"openai-down": {
		label: "OpenAI down",
		blocks: (e) => e.id === "openai",
		error: "drill: OpenAI unavailable",
		kind: "error",
	},
	"local-offline": {
		label: "Desktop (Ollama) offline",
		blocks: (e) => e.tier === "orcwood",
		error: "drill: local endpoint unreachable",
		kind: "error",
	},
	"frontier-down": {
		label: "Every cloud model down",
		blocks: (e) => e.tier === "frontier",
		error: "drill: frontier unavailable",
		kind: "quota",
	},
};

const requestContext = new AsyncLocalStorage();
let serverDrill = null; // { scenario, startedAt, endsAt, startedBy }

function scenarioFor(id) {
	return Object.prototype.hasOwnProperty.call(SCENARIOS, id) ? SCENARIOS[id] : null;
}

/** Run fn with `scenarioId` in force for its calls only. */
function runWithDrill(scenarioId, fn) {
	if (!scenarioFor(scenarioId)) throw new Error(`Unknown drill scenario "${scenarioId}"`);
	return requestContext.run(scenarioId, fn);
}

function activeServerDrill(now = Date.now()) {
	if (serverDrill && serverDrill.endsAt <= now) serverDrill = null;
	return serverDrill;
}

function startServerDrill(scenarioId, minutes, { startedBy = null, now = Date.now() } = {}) {
	if (!scenarioFor(scenarioId)) throw new Error(`Unknown drill scenario "${scenarioId}"`);
	const m = Math.min(MAX_MINUTES, Math.max(1, Math.round(Number(minutes) || 10)));
	serverDrill = { scenario: scenarioId, startedAt: now, endsAt: now + m * 60_000, startedBy };
	return describeServerDrill(now);
}

function stopServerDrill() {
	const was = serverDrill;
	serverDrill = null;
	return !!was;
}

/** The scenarios in force for the current call, request scope first. */
function activeScenarios(now = Date.now()) {
	const out = [];
	const req = requestContext.getStore();
	if (req) out.push(req);
	const srv = activeServerDrill(now);
	if (srv && !out.includes(srv.scenario)) out.push(srv.scenario);
	return out;
}

/** Null, or { scenario, error, kind, scope } when this endpoint is drilled out. */
function blocked(endpoint, now = Date.now()) {
	const req = requestContext.getStore();
	for (const id of activeScenarios(now)) {
		const s = SCENARIOS[id];
		if (s.blocks(endpoint)) return { scenario: id, error: s.error, kind: s.kind, scope: id === req ? "request" : "server" };
	}
	return null;
}

function describeServerDrill(now = Date.now()) {
	const d = activeServerDrill(now);
	if (!d) return null;
	return {
		scenario: d.scenario,
		label: SCENARIOS[d.scenario].label,
		startedAt: d.startedAt,
		endsAt: d.endsAt,
		remainingMs: Math.max(0, d.endsAt - now),
	};
}

function listScenarios() {
	return Object.entries(SCENARIOS).map(([id, s]) => ({ id, label: s.label }));
}

function reset() {
	serverDrill = null;
}

module.exports = {
	SCENARIOS,
	MAX_MINUTES,
	runWithDrill,
	startServerDrill,
	stopServerDrill,
	describeServerDrill,
	activeScenarios,
	blocked,
	listScenarios,
	reset,
};
