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
	// Don't call a quiet night "everything ran on the frontier".
	localMinCalls: 10,
	// Below this share of welcome interruptions, a trigger is costing more
	// attention than it returns.
	initiativeAcceptance: 0.5,
	// Don't judge a trigger on a handful of reactions.
	initiativeMinReactions: 5,
	// Nudges that expired before anyone could see them: budget spent on nothing.
	initiativeUnseen: 0.5,
	// Nudges people saw (or got pushed) and let expire without a word.
	initiativeIgnored: 0.8,
	// A rate over fewer calls than this is an anecdote. "50% invalid" once
	// meant 2 of 4 calls and still became the night's top plan item.
	minCallsToJudge: 20,
};

/**
 * Per-case eval record across tonight plus recent nights:
 * { "endpoint:case": { endpoint, case, ran, failed } }.
 *
 * One night's eval is a single sample of a sampled model. admits-gap failed
 * on 09-18, passed four nights, failed on 09-22 — and was graded "improved"
 * and then treated as a regression. The record lets a failure be read against
 * its own history.
 */
function evalRecord(evals, history = []) {
	const rec = {};
	for (const e of [evals, ...history.map((h) => h.evals)]) {
		if (!e?.endpoints) continue;
		for (const [endpoint, r] of Object.entries(e.endpoints)) {
			const failed = new Set((r.failures || []).map((f) => f.case));
			// Older rows may lack `cases`; then only the failures are known.
			const ran = e.cases?.length ? e.cases.map((c) => c.id) : [...failed];
			for (const c of ran) {
				const k = `${endpoint}:${c}`;
				const x = (rec[k] ||= { endpoint, case: c, ran: 0, failed: 0 });
				x.ran += 1;
				if (failed.has(c)) x.failed += 1;
			}
		}
	}
	return rec;
}

/** Cases that both passed and failed in the window — noise, not a trend. */
function flakyCases(record) {
	return Object.values(record).filter((x) => x.failed > 0 && x.failed < x.ran);
}

/** Tasks and endpoints with too few calls tonight for their rates to mean anything. */
function thinSamples(metrics) {
	const m24 = metrics.models?.last24h;
	if (!m24?.available) return [];
	const thin = [];
	for (const [task, t] of Object.entries(m24.byTask)) if (t.calls < THRESHOLDS.minCallsToJudge) thin.push(`task ${task} (${t.calls} calls)`);
	for (const [id, e] of Object.entries(m24.byEndpoint)) if (e.calls < THRESHOLDS.minCallsToJudge) thin.push(`endpoint ${id} (${e.calls} calls)`);
	return thin;
}

/**
 * Rule-based findings: [{ severity, area, title, evidence }].
 *
 * Severity "low" is context, not work: it explains the tables (why a row is
 * missing, why a failure is noise) and never becomes a plan item.
 */
function ruleFindings({ metrics, evals, config, evalHistory = [] }) {
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

	// Initiative: is she earning the right to interrupt?
	//
	// Reviewed per trigger, and only once a trigger has had enough reactions to
	// mean anything. The point of these findings is that an unwelcome rule gets
	// changed or retired rather than quietly training people to ignore her.
	const init = metrics.initiative;
	if (init?.available && init.enabledProfiles > 0) {
		for (const [id, t] of Object.entries(init.byTrigger)) {
			const answered = t.engaged + t.dismissed;
			if (answered >= THRESHOLDS.initiativeMinReactions && t.acceptance !== null && t.acceptance < THRESHOLDS.initiativeAcceptance) {
				add("high", "initiative", `${id}: only ${(t.acceptance * 100).toFixed(0)}% of interruptions were welcome`, `${t.engaged} engaged vs ${t.dismissed} dismissed over 7 days — tighten the rule or retire it`);
			}
			// Muting is a far stronger signal than dismissing: it is the person
			// saying "never again", and one of those is worth investigating.
			if (t.mutedBy > 0) {
				add("medium", "initiative", `${id} has been muted by ${t.mutedBy} person(s)`, "someone turned this trigger off entirely rather than just dismissing it");
			}
			// Athena went quiet on this by herself. Not a failure — the loop
			// working — but a human should know a trigger stopped firing for
			// real people without anyone changing code.
			if (t.learned?.suppressed > 0) {
				add("medium", "initiative", `${id}: Athena has stopped raising this for ${t.learned.suppressed} person(s)`, `learned from how it landed${t.learned.avgScore !== null ? `; average standing ${t.learned.avgScore}` : ""} — review the rule, or leave it suppressed`);
			}
			// Firing into the void. Usually a TTL shorter than the gap between
			// app opens, which means the interruption budget was spent on
			// something nobody could ever have seen.
			if (t.sent >= 5 && t.unseen / t.sent > THRESHOLDS.initiativeUnseen) {
				add("medium", "initiative", `${id}: ${((t.unseen / t.sent) * 100).toFixed(0)}% of these expired before anyone saw them`, `${t.unseen}/${t.sent} in 7 days — the TTL is shorter than people's habits`);
			}
		}
		// Reached people and got silence. Acceptance above only counts
		// engaged/dismissed, so a week where every nudge was seen and let expire
		// has acceptance null and produced no finding at all — the 09-22 report
		// had 6 appraised, 6 ignored, 0 engaged and called initiative "improved".
		let reached = 0;
		let ignored = 0;
		let engaged = 0;
		for (const t of Object.values(init.byTrigger)) {
			reached += (t.ignored || 0) + t.engaged + t.dismissed;
			ignored += t.ignored || 0;
			engaged += t.engaged;
		}
		if (reached >= THRESHOLDS.initiativeMinReactions && ignored / reached >= THRESHOLDS.initiativeIgnored) {
			const worst = Object.entries(init.byTrigger)
				.filter(([, t]) => t.ignored > 0)
				.sort(([, a], [, b]) => b.ignored - a.ignored)
				.slice(0, 3)
				.map(([id, t]) => `${id} ${t.ignored}`)
				.join(", ");
			add("high", "initiative", `${((ignored / reached) * 100).toFixed(0)}% of nudges people saw got no response`, `${ignored}/${reached} ignored, ${engaged} engaged over 7 days (${worst}) — she is speaking first but not being heard; fix what she says or when, before sending more`);
		}
		if (init.sent7d === 0) {
			add("opportunity", "initiative", "Initiative is switched on but Athena has not spoken first all week", "either nothing triggered, or the budget is too tight to ever fire");
		}
	} else if (init && !init.available) {
		add("medium", "initiative", "Initiative metrics unavailable", init.reason);
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
	// A failed case with passes in its recent history is sampling noise; say so
	// before the plan calls it a regression (or tomorrow's pass an improvement).
	if (evalHistory.length) {
		const record = evalRecord(evals, evalHistory);
		for (const [endpoint, r] of Object.entries(evals?.endpoints || {})) {
			for (const f of r.failures || []) {
				const x = record[`${endpoint}:${f.case}`];
				if (x && x.failed < x.ran) {
					add("low", "evals", `${endpoint} ${f.case} is intermittent, not a regression`, `failed ${x.failed} of the last ${x.ran} nights — judge it on the rate, not tonight`);
				}
			}
		}
	}
	// Is anything actually running locally? Answer from the call log, not from
	// this process's own config. The review runs as a Cloud Run job with no
	// LLM_ORCWOOD_ENDPOINTS — and a box on the house LAN would be unreachable
	// from there anyway — so `config.orcwoodCount` is 0 on a night when Orcwood
	// in fact served a third of the traffic. Reading that as "no endpoints" put
	// the same phantom item at the top of four consecutive plans, next to a
	// table showing 39.6% local share.
	let servedTotal = 0;
	let localTotal = 0;
	if (m24?.available) {
		for (const t of Object.values(m24.byTask)) {
			for (const [tier, n] of Object.entries(t.tiers)) {
				servedTotal += n;
				if (tier === "orcwood" || tier === "device") localTotal += n;
			}
		}
	}
	if (m24?.available) {
		if (servedTotal >= THRESHOLDS.localMinCalls && localTotal === 0) {
			// Not "set LLM_ORCWOOD_ENDPOINTS here": this job can't reach the house
			// LAN, so that advice fixes nothing. The question is why production
			// stopped routing locally.
			const why = config.orcwoodCount
				? `${config.orcwoodCount} endpoint(s) configured but none of them answered`
				: "check Orcwood's health and the API service's route to it";
			add("opportunity", "localization", "Everything ran on the frontier in the last 24h", `${servedTotal} calls served, none by Orcwood or the device; ${why}`);
		} else if (localTotal > 0 && !config.orcwoodCount) {
			// Orcwood is serving real traffic, just not from where the review
			// runs — which is also why the eval suite above only ever tested the
			// frontier. Worth saying plainly, so the missing rows in the
			// abilities table don't read as a local model that failed.
			add("low", "localization", `Orcwood served ${((localTotal / servedTotal) * 100).toFixed(0)}% of calls, but this job cannot reach those endpoints`, "the review runs in Cloud Run, off the house LAN, so capability evals only test the frontier — expected, nothing to fix");
		}
	} else if (!config.orcwoodCount) {
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

async function writePlan({ metrics, evals, findings, previousPlan, date, evalHistory = [] }) {
	// Split so the model can't mistake context for work: a "low" finding is
	// there to explain a table, and it topped seven straight plans anyway.
	const actionable = findings.filter((f) => f.severity !== "low");
	const context = findings.filter((f) => f.severity === "low");
	const thin = thinSamples(metrics);
	const flaky = flakyCases(evalRecord(evals, evalHistory)).map((x) => `${x.endpoint} ${x.case}: failed ${x.failed}/${x.ran} nights`);
	const prompt = `${require("../../security/mission").CORE_MISSION}

You are Athena, reviewing your own performance and abilities for ${date}. Be an engineer, not a cheerleader: specific, evidence-based, candid.

You run as a companion app with long-term memory, a tiered model router (device -> Orcwood servers -> frontier), camera perception, and voice. Your goals, in order:
1. Never drop a reply; answer reliably and quickly.
2. Remember well: form accurate memories, recall them when asked, never invent one.
3. Run as much as possible locally (Orcwood/device) without losing quality; frontier is the last resort.
4. Protect children's privacy absolutely.

Write a plan of at most 5 concrete improvements for the next few days, highest value first. Each item: what to change (specific enough for an engineer to start — a module, prompt, threshold, model swap, or config), why, the evidence from the data below, and how tomorrow's review will measure it. Prefer small, testable changes. Don't propose anything the data doesn't support; if the data is thin, the plan can be short and questionsForOwner can ask for what's missing. An empty plan is a valid answer on a quiet night.

Rules for the plan — these override your instincts:
- Plan items come only from "Actionable findings" or from a pattern in the metrics that clears the sample-size rule. "Context only" findings explain the tables; never turn one into a plan item or a question.
- Sample size: never cite or act on a rate from fewer than ${THRESHOLDS.minCallsToJudge} calls. The tasks/endpoints below that bar tonight are listed under "Too few calls to judge"; quote their raw counts if you mention them at all, never a percentage.
- Intermittent evals (listed below) pass some nights and fail others. Tonight's result for them is neither a regression nor an improvement; mention them only if the failure rate itself is the problem.
- Don't repeat an item from yesterday's plan unless tonight's data gives new evidence or a more specific change. If it needs something only the owner can provide, drop it from the plan and ask once in questionsForOwner.
- Every number you write must appear in the data below, with the same denominator. Don't restate or re-add counts.

For previousPlanStatus, judge each of yesterday's items against tonight's numbers: "improved" or "worse" only when the metric the item named moved beyond noise on at least ${THRESHOLDS.minCallsToJudge} calls; "unchanged" when nothing relevant moved (including when nobody acted on it); "unknown" when the sample is too small or the item was about an intermittent eval.

Actionable findings:
${JSON.stringify(actionable, null, 1)}

Context only (not plan items):
${JSON.stringify(context, null, 1)}

Too few calls to judge: ${thin.length ? thin.join("; ") : "(none)"}

Intermittent evals over recent nights: ${flaky.length ? flaky.join("; ") : "(none)"}

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
		plan: findings.filter((f) => f.severity !== "low").slice(0, 5).map((f) => ({
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

module.exports = { ruleFindings, writePlan, fallbackPlan, renderMarkdown, evalRecord, flakyCases, thinSamples, THRESHOLDS, PLAN_SCHEMA };
