/**
 * Turns tonight's metrics + evals into an improvement plan.
 *
 *   1. Deterministic rules produce findings with evidence — these exist even if
 *      every model is down, so a report is always written.
 *   2. The "review" task (local-first: Orcwood's GPU is idle at night) turns
 *      findings, metrics, evals and YESTERDAY'S plan into a prioritized plan,
 *      saying whether each prior item actually improved.
 *   3. Everything renders to Markdown for a human to read and act on.
 *
 * The plan proposes; it never changes code or config by itself.
 */
const llm = require("../llm");

const THRESHOLDS = {
	errorRate: 0.05,
	fallbackRate: 0.2,
	chatP95Ms: 8000,
	embeddingCoverage: 0.95,
	promoteLocalPassRate: 0.9,
	demoteLocalPassRate: 0.75,
};

/** Rule-based findings: [{ severity, area, title, evidence }]. */
function ruleFindings({ metrics, evals, config }) {
	const out = [];
	const add = (severity, area, title, evidence) => out.push({ severity, area, title, evidence });
	const m24 = metrics.models?.last24h;

	if (!m24?.available) {
		add("high", "ops", "Model telemetry is unavailable", m24?.reason || "llm_call_log not readable — apply migrations 0019-0022");
	} else {
		for (const [task, t] of Object.entries(m24.byTask)) {
			if (t.calls >= 10 && t.errorRate > THRESHOLDS.errorRate) {
				add("high", "models", `${task}: ${(t.errorRate * 100).toFixed(1)}% of calls errored`, `${t.errors}/${t.calls} calls in 24h`);
			}
			if (t.calls >= 10 && t.invalidRate > THRESHOLDS.errorRate) {
				add("medium", "models", `${task}: ${(t.invalidRate * 100).toFixed(1)}% of outputs failed validation`, `${t.invalid}/${t.calls} calls; the next tier had to answer`);
			}
			if (t.ok >= 10 && t.fallbackRate > THRESHOLDS.fallbackRate) {
				add("medium", "models", `${task}: ${(t.fallbackRate * 100).toFixed(0)}% of answers came from a fallback tier`, "the preferred tier is unreliable for this task");
			}
		}
		const chat = m24.byTask.chat;
		if (chat?.p95Ms > THRESHOLDS.chatP95Ms) {
			add("medium", "latency", `Chat p95 latency is ${(chat.p95Ms / 1000).toFixed(1)}s`, `p50 ${(chat.p50Ms / 1000).toFixed(1)}s over ${chat.ok} replies`);
		}
		for (const [id, e] of Object.entries(m24.byEndpoint)) {
			if (e.calls >= 5 && e.errorRate > 0.25) add("high", "infra", `Endpoint ${id} is failing`, `${(e.errorRate * 100).toFixed(0)}% errors over ${e.calls} calls`);
		}
	}

	if (metrics.chat?.available && metrics.chat.droppedReplies > 0) {
		add("high", "reliability", `${metrics.chat.droppedReplies} conversation(s) ended on an unanswered message`, "last message was the person's and no reply followed within 5 minutes");
	}

	const mem = metrics.memory;
	if (mem?.available) {
		if (mem.embeddingCoverage < THRESHOLDS.embeddingCoverage) {
			add("medium", "memory", `Only ${(mem.embeddingCoverage * 100).toFixed(0)}% of memories are searchable semantically`, `${mem.totalEvents} episodes; the backfill should close this gap`);
		}
		const human = metrics.chat?.humanMessages || 0;
		if (human >= 30 && mem.conversationMoments72h === 0) {
			add("high", "memory", "Conversations are happening but no new memories were formed in 72h", `${human} messages in the last 24h; extraction may be failing`);
		}
	} else if (mem) {
		add("medium", "memory", "Memory metrics unavailable", mem.reason);
	}

	// Abilities: is a local model good enough to take more traffic — or too weak?
	const localEndpoints = Object.entries(evals?.endpoints || {}).filter(([, r]) => r.tier === "orcwood");
	for (const [id, r] of localEndpoints) {
		if (r.passRate >= THRESHOLDS.promoteLocalPassRate) {
			add("opportunity", "localization", `${id} passed ${(r.passRate * 100).toFixed(0)}% of capability evals`, "candidate to serve more traffic locally (check chat local share)");
		} else if (r.passRate < THRESHOLDS.demoteLocalPassRate) {
			const worst = r.failures.slice(0, 3).map((f) => `${f.case}: ${f.problem}`).join("; ");
			add("high", "localization", `${id} passed only ${(r.passRate * 100).toFixed(0)}% of capability evals`, worst || "see eval failures");
		}
	}
	if (!config.orcwoodCount) {
		add("opportunity", "localization", "No Orcwood endpoints configured — everything runs on the frontier", "set LLM_ORCWOOD_ENDPOINTS to start localizing");
	}

	const order = { high: 0, medium: 1, opportunity: 2, low: 3 };
	return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

const PLAN_SCHEMA = {
	type: "object",
	properties: {
		summary: { type: "string" },
		wins: { type: "array", items: { type: "string" } },
		regressions: { type: "array", items: { type: "string" } },
		previousPlanStatus: {
			type: "array",
			items: {
				type: "object",
				properties: { title: { type: "string" }, status: { type: "string", enum: ["improved", "unchanged", "worse", "unknown"] }, note: { type: "string" } },
				required: ["title", "status"],
			},
		},
		plan: {
			type: "array",
			items: {
				type: "object",
				properties: {
					title: { type: "string" },
					area: { type: "string" },
					why: { type: "string" },
					evidence: { type: "string" },
					change: { type: "string" },
					measure: { type: "string" },
					effort: { type: "string", enum: ["S", "M", "L"] },
					impact: { type: "string", enum: ["low", "medium", "high"] },
				},
				required: ["title", "area", "why", "change", "measure", "effort", "impact"],
			},
		},
		questionsForOwner: { type: "array", items: { type: "string" } },
	},
	required: ["summary", "wins", "regressions", "plan", "previousPlanStatus", "questionsForOwner"],
};

async function writePlan({ metrics, evals, findings, previousPlan, date }) {
	const prompt = `${require("../../security/mission").CORE_MISSION}

You are Athena, reviewing your own performance and abilities for ${date}. Be an engineer, not a cheerleader: specific, evidence-based, candid.

You run as a companion app with long-term memory, a tiered model router (device -> Orcwood servers -> frontier), camera perception, and voice. Your goals, in order:
1. Never drop a reply; answer reliably and quickly.
2. Remember well: form accurate memories, recall them when asked, never invent one.
3. Run as much as possible locally (Orcwood/device) without losing quality; frontier is the last resort.
4. Protect children's privacy absolutely.

Write a plan of at most 5 concrete improvements for the next few days, highest value first. Each item: what to change (specific enough for an engineer to start — a module, prompt, threshold, model swap, or config), why, the evidence from the data below, and how tomorrow's review will measure it. Prefer small, testable changes. Don't propose anything the data doesn't support; if the data is thin, the plan can be short and questionsForOwner can ask for what's missing.
For previousPlanStatus, judge each of yesterday's items against tonight's numbers.

Rule-based findings:
${JSON.stringify(findings, null, 1)}

Metrics (last 24h, with a 7-day baseline for model calls):
${JSON.stringify(metrics, null, 1).slice(0, 12000)}

Capability evals per model:
${JSON.stringify(evals, null, 1).slice(0, 6000)}

Yesterday's plan:
${previousPlan ? JSON.stringify(previousPlan.plan || [], null, 1).slice(0, 4000) : "(none — first review)"}

Return ONLY JSON matching: ${JSON.stringify(PLAN_SCHEMA)}`;

	const { data, endpointId, tier } = await llm.generateJson({
		task: "review",
		audience: "adult",
		schema: PLAN_SCHEMA,
		temperature: 0.3,
		contents: prompt,
		check: (d) => (typeof d?.summary === "string" && Array.isArray(d?.plan) ? null : "missing summary/plan"),
	});
	return { ...data, servedBy: `${endpointId} (${tier})` };
}

/** Plan built from rules alone — used when no model is available. */
function fallbackPlan(findings) {
	return {
		summary: findings.length
			? `Rule-based review only (no model was available to write the plan). ${findings.length} finding(s).`
			: "Rule-based review only (no model was available). No issues detected by the rules.",
		wins: [],
		regressions: findings.filter((f) => f.severity === "high").map((f) => f.title),
		previousPlanStatus: [],
		plan: findings.slice(0, 5).map((f) => ({
			title: f.title,
			area: f.area,
			why: f.evidence,
			evidence: f.evidence,
			change: "Investigate — see the finding's evidence.",
			measure: "The finding no longer appears in tomorrow's review.",
			effort: "M",
			impact: f.severity === "high" ? "high" : "medium",
		})),
		questionsForOwner: [],
		servedBy: "rules",
	};
}

const pct = (n) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
const secs = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`);

function renderMarkdown({ date, metrics, evals, findings, plan, maintenance }) {
	const L = [];
	L.push(`# Athena self-review — ${date}`, "");
	L.push(`> ${plan.summary}`, "");
	L.push(`_Plan written by: ${plan.servedBy}_`, "");

	if (plan.plan?.length) {
		L.push("## Plan", "");
		plan.plan.forEach((p, i) => {
			L.push(`### ${i + 1}. ${p.title}  \`${p.area}\` · impact **${p.impact}** · effort **${p.effort}**`);
			L.push(`- **Why:** ${p.why}`);
			if (p.evidence) L.push(`- **Evidence:** ${p.evidence}`);
			L.push(`- **Change:** ${p.change}`);
			L.push(`- **Measure:** ${p.measure}`, "");
		});
	}

	if (plan.previousPlanStatus?.length) {
		L.push("## Yesterday's plan", "", "| Item | Status | Note |", "|---|---|---|");
		for (const s of plan.previousPlanStatus) L.push(`| ${s.title} | ${s.status} | ${s.note || ""} |`);
		L.push("");
	}
	if (plan.wins?.length) L.push("## Wins", "", ...plan.wins.map((w) => `- ${w}`), "");
	if (plan.regressions?.length) L.push("## Regressions", "", ...plan.regressions.map((r) => `- ${r}`), "");
	if (plan.questionsForOwner?.length) L.push("## Questions for you", "", ...plan.questionsForOwner.map((q) => `- ${q}`), "");

	L.push("## Findings (rules)", "");
	if (!findings.length) L.push("_None._");
	for (const f of findings) L.push(`- **${f.severity}** · ${f.area} — ${f.title} _(${f.evidence})_`);
	L.push("");

	const m = metrics.models?.last24h;
	L.push("## Models (24h)", "");
	if (m?.available) {
		L.push("| Task | Calls | Errors | Invalid | Fallback | Local share | p50 | p95 |", "|---|---:|---:|---:|---:|---:|---:|---:|");
		for (const [task, t] of Object.entries(m.byTask)) {
			L.push(`| ${task} | ${t.calls} | ${pct(t.errorRate)} | ${pct(t.invalidRate)} | ${pct(t.fallbackRate)} | ${pct(t.localShare)} | ${secs(t.p50Ms)} | ${secs(t.p95Ms)} |`);
		}
	} else L.push(`_Unavailable: ${m?.reason}_`);
	if (m?.smokeCalls) {
		L.push(
			"",
			`_${m.smokeCalls} smoke-test call${m.smokeCalls === 1 ? "" : "s"} excluded from the table above (deliberate post-deploy testing, labelled \`smoke:*\`)._`
		);
	}
	L.push("");

	L.push("## Abilities (capability evals)", "");
	const eps = Object.entries(evals?.endpoints || {});
	if (!eps.length) L.push("_Evals skipped or no endpoints._");
	else {
		L.push("| Model | Tier | Pass | Avg latency | Failures |", "|---|---|---:|---:|---|");
		for (const [id, r] of eps) {
			L.push(`| ${id} | ${r.tier} | ${r.passed}/${r.total} | ${secs(r.avgLatencyMs)} | ${r.failures.map((f) => `${f.case}: ${f.problem}`).join("; ") || "—"} |`);
		}
	}
	L.push("");

	if (metrics.chat?.available || metrics.memory?.available) {
		L.push("## Conversations & memory (24h)", "");
		if (metrics.chat?.available) {
			const c = metrics.chat;
			L.push(`- ${c.humanMessages} messages from people across ${c.sessions} sessions; **${c.droppedReplies} dropped replies**`);
		}
		if (metrics.memory?.available) {
			const mm = metrics.memory;
			L.push(`- New episodes: ${Object.entries(mm.newEventsByKind).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}; new AI facts: ${mm.newAiFacts}`);
			L.push(`- Semantic coverage: ${pct(mm.embeddingCoverage)} of ${mm.totalEvents} episodes; recalled in 24h: ${mm.eventsRecalled24h}`);
		}
		L.push("");
	}

	if (maintenance) {
		L.push("## Overnight maintenance", "", "```json", JSON.stringify(maintenance, null, 2), "```", "");
	}
	return L.join("\n");
}

module.exports = { ruleFindings, writePlan, fallbackPlan, renderMarkdown, THRESHOLDS, PLAN_SCHEMA };
