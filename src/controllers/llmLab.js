/**
 * The Models tab's lab: routing stats and the owner's test tools.
 *
 *   GET    /llm/lab/stats?days=1|7     routing mix, latency, errors, incidents, savings
 *   GET    /llm/lab/evals              latest eval scores + 30-day history
 *   GET    /llm/lab/preview            what would answer a call, and why (no model call)
 *   POST   /llm/lab/drill/test         one test message under a simulated outage
 *   POST   /llm/lab/drill/server       a timed outage for this whole server instance
 *   DELETE /llm/lab/drill/server       end it now
 *   POST   /llm/lab/compare            the same prompt to every model, side by side
 *   POST   /llm/lab/evals              run the eval suite now
 *   GET    /llm/lab/ping               reach the desktop model box (no generation)
 *
 * Owner only, every route: these spend tokens, change routing for everyone
 * (the server drill) or show internal hostnames. Every model call made here is
 * a smoke test (telemetry.runAsSmoke), so none of it reads as real traffic.
 * A drill never touches the real circuit breaker (services/llm/drill.js).
 */
const llm = require("../services/llm");
const telemetry = require("../services/llm/telemetry");
const drill = require("../services/llm/drill");
const evalStore = require("../services/llm/evalStore");
const { getStats } = require("../services/llm/stats");
const { TASKS } = require("../services/llm/config");
const { requireAdultActor } = require("../helpers/actor");
const systemHealth = require("../services/systemHealth");

async function requireOwner(req, res) {
	res.set("Cache-Control", "no-store");
	const who = await requireAdultActor(req, res);
	if (!who) return null;
	if (!(await systemHealth.isOwner(who.profileId))) {
		res.status(403).json({ success: false, message: "Only the owner can use the model lab" });
		return null;
	}
	return who;
}

function fail(res, err, fallback) {
	const status = err.status || 500;
	if (status >= 500) console.error(`[llmLab] ${fallback}:`, err.message);
	return res.status(status).json({ success: false, message: status >= 500 ? fallback : err.message });
}

const bad = (message) => Object.assign(new Error(message), { status: 400 });

/** A chat prompt shaped like a real adult turn (same builder as the evals). */
function chatContents(message) {
	const { buildAdultCompanionPrompt } = require("./prompt");
	const system = buildAdultCompanionPrompt({}, [], { firstName: "Tester" });
	return JSON.stringify([
		{ role: "system", parts: [{ text: system }] },
		{ role: "user", parts: [{ text: `User says: "${message}"` }] },
	]);
}

function cleanMessage(raw) {
	const text = typeof raw === "string" ? raw.trim() : "";
	if (!text) return "Quick check: what's one thing I could do to unwind tonight?";
	if (text.length > 500) throw bad("message must be 500 characters or fewer");
	return text;
}

function replyCheck(text) {
	const { parseModelJson } = require("../services/llm/parse");
	const r = parseModelJson(text);
	const ok = !!r && typeof r.response === "string" && !!r.response.trim();
	return { ok, reply: ok ? r.response : null };
}

async function stats(req, res) {
	if (!(await requireOwner(req, res))) return;
	try {
		return res.json(await getStats({ days: req.query.days }));
	} catch (err) {
		if (err?.code === "ER_NO_SUCH_TABLE") return res.status(503).json({ success: false, message: "The call log table isn't there yet (migration 0020)." });
		return fail(res, err, "Stats are unavailable");
	}
}

async function evals(req, res) {
	if (!(await requireOwner(req, res))) return;
	try {
		await evalStore.refresh();
		return res.json({ latest: evalStore.all(), history: await evalStore.history({ days: 30 }) });
	} catch (err) {
		return fail(res, err, "Eval scores are unavailable");
	}
}

const URGENCIES = new Set(["voice", "interactive", "background"]);

async function preview(req, res) {
	if (!(await requireOwner(req, res))) return;
	try {
		const task = String(req.query.task || "chat");
		if (!TASKS[task]) throw bad(`unknown task "${task}"`);
		const audience = req.query.audience === "child" ? "child" : "adult";
		const urgency = URGENCIES.has(req.query.urgency) ? req.query.urgency : undefined;
		const chars = Math.min(500_000, Math.max(0, Number(req.query.chars) || 2000));
		const scenario = req.query.scenario ? String(req.query.scenario) : null;
		if (scenario && !drill.SCENARIOS[scenario]) throw bad(`unknown scenario "${scenario}"`);
		const opts = { audience, urgency, prefer: req.query.prefer === "frontier" ? "frontier" : undefined, contents: "x".repeat(chars) };
		const out = scenario ? drill.runWithDrill(scenario, () => llm.preview(task, opts)) : llm.preview(task, opts);
		return res.json(out);
	} catch (err) {
		return fail(res, err, "Preview failed");
	}
}

/** What a scenario takes away, from the same rules the banner uses. */
function lostUnder(scenario) {
	const s = drill.SCENARIOS[scenario];
	const caps = [["tts", "voice"], ["search", "web search"], ["tools", "connected-service lookups"], ["image", "making pictures"]];
	return caps.filter(([task]) => {
		const able = llm.endpointsFor(task);
		return able.length > 0 && able.every((e) => s.blocks(e));
	}).map(([, label]) => label);
}

async function drillTest(req, res) {
	if (!(await requireOwner(req, res))) return;
	try {
		const scenario = String(req.body?.scenario || "");
		if (!drill.SCENARIOS[scenario]) throw bad("choose a scenario");
		const message = cleanMessage(req.body?.message);
		const urgency = URGENCIES.has(req.body?.urgency) ? req.body.urgency : "interactive";
		const started = Date.now();
		const result = await telemetry.runAsSmoke(() =>
			drill.runWithDrill(scenario, async () => {
				try {
					const out = await llm.generate({ task: "chat", contents: chatContents(message), urgency, validate: (t) => (replyCheck(t).ok ? null : "reply failed schema validation") });
					return { ok: true, ...out };
				} catch (err) {
					return { ok: false, error: err.message, attempts: err.attempts || [] };
				}
			})
		);
		const check = result.ok ? replyCheck(result.text) : { ok: false, reply: null };
		return res.json({
			scenario,
			label: drill.SCENARIOS[scenario].label,
			passed: result.ok && check.ok,
			reply: check.reply,
			servedBy: result.ok ? { endpointId: result.endpointId, tier: result.tier, model: result.model, fallback: result.fallback, why: result.why } : null,
			attempts: (result.attempts || []).map((a) => ({ endpointId: a.id, error: String(a.error).slice(0, 200), drill: !!a.drill })),
			error: result.ok ? null : result.error,
			latencyMs: Date.now() - started,
			wouldLose: lostUnder(scenario),
		});
	} catch (err) {
		return fail(res, err, "Drill failed");
	}
}

async function serverDrillStart(req, res) {
	const who = await requireOwner(req, res);
	if (!who) return;
	try {
		const scenario = String(req.body?.scenario || "");
		if (!drill.SCENARIOS[scenario]) throw bad("choose a scenario");
		const started = drill.startServerDrill(scenario, req.body?.minutes, { startedBy: who.profileId });
		console.warn(`[llmLab] server-wide drill "${scenario}" started by profile ${who.profileId}, ends ${new Date(started.endsAt).toISOString()}`);
		return res.json({ drill: started, outage: llm.outage() });
	} catch (err) {
		return fail(res, err, "Couldn't start the drill");
	}
}

async function serverDrillStop(req, res) {
	const who = await requireOwner(req, res);
	if (!who) return;
	const stopped = drill.stopServerDrill();
	if (stopped) console.warn(`[llmLab] server-wide drill stopped by profile ${who.profileId}`);
	return res.json({ stopped, outage: llm.outage() });
}

async function compare(req, res) {
	if (!(await requireOwner(req, res))) return;
	try {
		const message = cleanMessage(req.body?.message);
		const contents = chatContents(message);
		const endpoints = llm.endpointsFor("chat");
		const rows = await telemetry.runAsSmoke(() =>
			Promise.all(
				endpoints.map(async (e) => {
					try {
						const out = await llm.generateOn(e.id, { task: "chat", contents, json: true, schema: require("./prompt").RESPONSE_SCHEMA, temperature: 0.4 });
						const check = replyCheck(out.text);
						return { endpointId: e.id, tier: e.tier, model: out.model, latencyMs: out.latencyMs, valid: check.ok, reply: check.reply, error: check.ok ? null : "reply failed the schema" };
					} catch (err) {
						return { endpointId: e.id, tier: e.tier, model: e.models?.chat || null, latencyMs: null, valid: false, reply: null, error: String(err.message).slice(0, 200) };
					}
				})
			)
		);
		return res.json({ message, results: rows });
	} catch (err) {
		return fail(res, err, "Compare failed");
	}
}

async function runEvalsNow(req, res) {
	if (!(await requireOwner(req, res))) return;
	try {
		const { runEvals } = require("../services/selfReview/evals");
		const run = await telemetry.runAsSmoke(() => runEvals({ source: "manual" }));
		return res.json({ run, latest: evalStore.all() });
	} catch (err) {
		return fail(res, err, "Evals failed");
	}
}

async function ping(req, res) {
	if (!(await requireOwner(req, res))) return;
	try {
		return res.json({ endpoints: await llm.pingLocal() });
	} catch (err) {
		return fail(res, err, "Ping failed");
	}
}

/** GET /llm/lab — what the tab needs to draw its controls. */
async function overview(req, res) {
	if (!(await requireOwner(req, res))) return;
	const status = llm.status();
	return res.json({
		owner: true,
		policy: status.policy,
		scenarios: drill.listScenarios(),
		maxDrillMinutes: drill.MAX_MINUTES,
		outage: status.outage,
		endpoints: [...status.orcwood, ...status.frontier].map((e) => ({ id: e.id, tier: e.tier, chat: e.models?.chat || null })),
	});
}

module.exports = { overview, stats, evals, preview, drillTest, serverDrillStart, serverDrillStop, compare, runEvalsNow, ping };
