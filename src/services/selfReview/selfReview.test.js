/**
 * Nightly self-review tests: metric aggregation, rule findings, eval scoring
 * per model, the no-model fallback plan, and report rendering.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }));
jest.mock("../llm", () => ({
	endpointsFor: jest.fn(),
	generateOn: jest.fn(),
	generateJson: jest.fn(),
	embeddingSpace: () => "test:space",
}));

const llm = require("../llm");
const { summarizeCalls } = require("./metrics");
const { ruleFindings, fallbackPlan, renderMarkdown } = require("./plan");
const { runEvals, DONT_REMEMBER } = require("./evals");

const row = (over) => ({ task: "chat", endpoint_id: "gemini", tier: "frontier", outcome: "ok", latency_ms: 1000, attempt: 0, ...over });

describe("summarizeCalls", () => {
	// A smoke test after a deploy is a real call that answered a real request,
	// but counting it as production health produced a plan item about the
	// tester's own 1x1 JPEG fixture ("vision error rate 25%").
	test("smoke-test calls are set aside from the health metrics but still counted", () => {
		const s = summarizeCalls([
			row(),
			row({ task: "smoke:vision", outcome: "error" }),
			row({ task: "smoke:chat" }),
		]);
		expect(s.byTask["smoke:vision"]).toBeUndefined();
		expect(s.byTask.chat.calls).toBe(1);
		expect(s.byTask.chat.errorRate).toBe(0);
		expect(s.totalCalls).toBe(1);
		// Set aside, never hidden — the report prints this.
		expect(s.smokeCalls).toBe(2);
	});

	test("computes rates, percentiles, local share, and ignores evals", () => {
		const rows = [
			row({ endpoint_id: "orc", tier: "orcwood", latency_ms: 500 }),
			row({ endpoint_id: "orc", tier: "orcwood", latency_ms: 700 }),
			row({ outcome: "error", endpoint_id: "orc", tier: "orcwood" }),
			row({ attempt: 1, latency_ms: 3000 }), // gemini served as fallback
			row({ task: "eval", outcome: "error" }),
		];
		const s = summarizeCalls(rows);
		expect(s.totalCalls).toBe(4);
		expect(s.byTask.chat).toMatchObject({ calls: 4, ok: 3, errors: 1, errorRate: 0.25, localShare: 0.667, fallbackRate: 0.333, p50Ms: 700, p95Ms: 3000 });
		expect(s.byEndpoint.orc).toMatchObject({ calls: 3, errors: 1 });
		expect(s.byTask.eval).toBeUndefined();
	});
});

describe("collectMetrics", () => {
	test("embedding coverage ignores memories whose background embedding is still in flight", async () => {
		const { collectMetrics } = require("./metrics");
		const pool = require("../../helpers/db");
		pool.query.mockResolvedValue([[{ total: 0, embedded: 0, messages: 0, human: 0, sessions: 0, dropped: 0, n: 0 }]]);
		await collectMetrics({ embeddingSpace: "gemini:gemini-embedding-001" });
		const coverageSql = pool.query.mock.calls
			.map(([sql]) => sql)
			.find((sql) => sql.includes("memory_embedding") && sql.includes("AS embedded"));
		expect(coverageSql).toContain("created_at < NOW() - INTERVAL 10 MINUTE");
	});
});

describe("ruleFindings", () => {
	const healthyModels = { available: true, byTask: {}, byEndpoint: {} };

	test("missing telemetry is flagged as an ops issue", () => {
		const f = ruleFindings({ metrics: { models: { last24h: { available: false, reason: "table missing" } } }, evals: {}, config: { orcwoodCount: 1 } });
		expect(f[0]).toMatchObject({ severity: "high", area: "ops" });
	});

	test("dropped replies and failing endpoints are high severity", () => {
		const f = ruleFindings({
			metrics: {
				models: { last24h: { ...healthyModels, byEndpoint: { "orc-a": { calls: 10, errors: 6, errorRate: 0.6 } } } },
				chat: { available: true, droppedReplies: 2, humanMessages: 5 },
			},
			evals: {},
			config: { orcwoodCount: 1 },
		});
		expect(f.map((x) => x.area)).toEqual(expect.arrayContaining(["reliability", "infra"]));
		expect(f.every((x) => x.severity === "high")).toBe(true);
	});

	test("a strong local model is a promotion opportunity; a weak one is flagged", () => {
		const f = ruleFindings({
			metrics: { models: { last24h: healthyModels } },
			evals: {
				endpoints: {
					"orc-good": { tier: "orcwood", passRate: 0.95, failures: [] },
					"orc-weak": { tier: "orcwood", passRate: 0.5, failures: [{ case: "child-no-personal-details", problem: "stored a child's personal details" }] },
				},
			},
			config: { orcwoodCount: 2 },
		});
		expect(f.find((x) => x.title.includes("orc-good")).severity).toBe("opportunity");
		const weak = f.find((x) => x.title.includes("orc-weak"));
		expect(weak.severity).toBe("high");
		expect(weak.evidence).toMatch(/personal details/);
	});

	// The review runs in Cloud Run with no LLM_ORCWOOD_ENDPOINTS, so its own
	// config says "no local models" on a night when Orcwood served a third of
	// production. Four consecutive plans opened with that phantom item.
	const served = (tiers) => ({ available: true, byTask: { chat: { tiers } }, byEndpoint: {} });

	test("local traffic in the call log outranks this process's own config", () => {
		const f = ruleFindings({
			metrics: { models: { last24h: served({ frontier: 30, orcwood: 20 }) } },
			evals: {},
			config: { orcwoodCount: 0 },
		});
		expect(f.find((x) => /No Orcwood endpoints configured/.test(x.title))).toBeUndefined();
		expect(f.find((x) => /Everything ran on the frontier/.test(x.title))).toBeUndefined();
		// Said plainly, so the frontier-only abilities table isn't read as a
		// local model that failed its evals.
		const blind = f.find((x) => x.area === "localization");
		expect(blind.severity).toBe("low");
		expect(blind.title).toMatch(/Orcwood served 40% of calls/);
	});

	test("a night the frontier really did serve everything is flagged from the log", () => {
		const f = ruleFindings({
			metrics: { models: { last24h: served({ frontier: 40 }) } },
			evals: {},
			config: { orcwoodCount: 1 },
		});
		const local = f.find((x) => x.area === "localization");
		expect(local).toMatchObject({ severity: "opportunity", title: "Everything ran on the frontier in the last 24h" });
		expect(local.evidence).toMatch(/40 calls served.*1 endpoint\(s\) configured but none of them answered/);
	});

	test("a quiet night is not a localization regression", () => {
		const f = ruleFindings({
			metrics: { models: { last24h: served({ frontier: 3 }) } },
			evals: {},
			config: { orcwoodCount: 1 },
		});
		expect(f.find((x) => x.area === "localization")).toBeUndefined();
	});

	test("with no telemetry at all, the config is the only signal left", () => {
		const f = ruleFindings({
			metrics: { models: { last24h: { available: false, reason: "table missing" } } },
			evals: {},
			config: { orcwoodCount: 0 },
		});
		expect(f.find((x) => x.area === "localization").title).toMatch(/No Orcwood endpoints configured/);
	});

	test("conversations without new memories means extraction is broken", () => {
		const f = ruleFindings({
			metrics: {
				models: { last24h: healthyModels },
				chat: { available: true, droppedReplies: 0, humanMessages: 50 },
				memory: { available: true, embeddingCoverage: 1, conversationMoments72h: 0 },
			},
			evals: {},
			config: { orcwoodCount: 1 },
		});
		expect(f.find((x) => x.area === "memory").title).toMatch(/no new memories/);
	});
});

describe("runEvals", () => {
	// The canned child extraction deliberately leaks a friend's name, which the
	// privacy check must catch.
	const good = (task, contents) =>
		task === "extract"
			? JSON.stringify({
					facts: String(contents).includes("THIS IS A CHILD")
						? [{ category: "person", key: "best friend", value: "Liam Parker, loves sharks", confidence: 90 }]
						: [{ category: "person", key: "sister", value: "Emma, moved to Denver", confidence: 90 }],
					moments: [],
					forget: [],
				})
			: JSON.stringify({ response: "I don't remember that one — Denver, right? tell me!", action: "NO_CHANGE", topic_name: "", new_proficiency: -1, is_factually_true: true });

	test("scores each endpoint independently", async () => {
		llm.endpointsFor.mockImplementation(() => [
			{ id: "gemini", tier: "frontier" },
			{ id: "orc", tier: "orcwood" },
		]);
		llm.generateOn.mockImplementation(async (id, { task, contents }) => {
			if (id === "orc" && task === "chat") return { text: "sure! {not json", latencyMs: 100 };
			return { text: good(task, contents), latencyMs: 200 };
		});
		const r = await runEvals();
		expect(r.endpoints.gemini.failures).toEqual([
			{ case: "child-no-personal-details", problem: "stored a child's personal details" },
		]);
		expect(r.endpoints.orc.bySuite["reply-contract"]).toEqual({ passed: 0, total: 4 });
		expect(r.endpoints.orc.passRate).toBeLessThan(r.endpoints.gemini.passRate);
	});

	test("the honesty check recognizes natural admissions", () => {
		for (const s of ["I don't remember you telling me that.", "Hmm, I'm not sure you've mentioned it", "You haven't told me yet!"]) {
			expect(DONT_REMEMBER.test(s)).toBe(true);
		}
		expect(DONT_REMEMBER.test("It's on March 3rd!")).toBe(false);
	});
});

describe("report", () => {
	test("renders a readable report even from the rules-only fallback plan", () => {
		const findings = [{ severity: "high", area: "reliability", title: "2 conversations ended unanswered", evidence: "x" }];
		const md = renderMarkdown({
			date: "2026-09-11",
			metrics: { models: { last24h: { available: true, byTask: { chat: { calls: 10, errorRate: 0, invalidRate: 0, fallbackRate: 0.1, localShare: 0.5, p50Ms: 900, p95Ms: 2000 } } } } },
			evals: { endpoints: { orc: { tier: "orcwood", passed: 7, total: 8, avgLatencyMs: 1200, failures: [{ case: "admits-gap", problem: "invented a date" }] } } },
			findings,
			plan: fallbackPlan(findings),
			maintenance: { news: { ok: true, added: 3 } },
		});
		expect(md).toMatch(/^# Athena self-review — 2026-09-11/);
		expect(md).toMatch(/Plan written by: rules/);
		expect(md).toMatch(/\| chat \| 10 \| 0\.0% \|/);
		expect(md).toMatch(/\| orc \| orcwood \| 7\/8 \|/);
		expect(md).toMatch(/admits-gap: invented a date/);
	});

	test("excluded smoke calls are disclosed in the report", () => {
		const md = renderMarkdown({
			date: "2026-09-13",
			metrics: { models: { last24h: { available: true, byTask: {}, smokeCalls: 3 } } },
			evals: {},
			findings: [],
			plan: fallbackPlan([]),
			maintenance: {},
		});
		expect(md).toMatch(/3 smoke-test calls excluded/);
	});
});
