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
const { ruleFindings, fallbackPlan, renderMarkdown, writePlan, evalRecord, flakyCases, thinSamples } = require("./plan");
const { runEvals, DONT_REMEMBER } = require("./evals");

const row = (over) => ({ task: "chat", endpoint_id: "gemini", tier: "frontier", outcome: "ok", latency_ms: 1000, attempt: 0, ...over });
// One night's evals for gemini, failing the named cases.
const night = (failed) => ({
	cases: [{ id: "admits-gap" }, { id: "uses-memory" }],
	endpoints: { gemini: { tier: "frontier", passRate: 1, failures: failed.map((c) => ({ case: c, problem: "x" })) } },
});

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

	describe("news and maintenance", () => {
		const run = ({ news, maintenance = null }) =>
			ruleFindings({ metrics: { models: { last24h: healthyModels }, news }, evals: {}, config: { orcwoodCount: 1 }, maintenance });
		const newsMetrics = (overdue, worldSources = 2) => ({ available: true, worldSources, overdue, items24h: 0 });

		// 09-21 to 09-27: NPR and BBC never polled, nightly step "ok", no finding.
		test("every world source overdue means the watcher is down", () => {
			const [f] = run({ news: newsMetrics([{ host: "feeds.npr.org", lastCheckedAt: null }, { host: "feeds.bbci.co.uk", lastCheckedAt: null }]) });
			expect(f).toMatchObject({ severity: "high", area: "news" });
			expect(f.title).toMatch(/News watcher has stopped/);
			expect(f.evidence).toMatch(/feeds.npr.org \(last polled never\).*athena-news/);
		});

		test("some overdue sources are a medium finding", () => {
			const [f] = run({ news: newsMetrics([{ host: "feeds.npr.org", lastCheckedAt: "2026-09-20T00:00:00Z" }]) });
			expect(f).toMatchObject({ severity: "medium", title: "1 of 2 world news source(s) overdue" });
			expect(f.evidence).toMatch(/last polled 2026-09-20/);
		});

		test("sources polled on schedule produce nothing", () => {
			expect(run({ news: newsMetrics([]) })).toEqual([]);
		});

		test("a failed maintenance step becomes a finding", () => {
			const f = run({ news: newsMetrics([]), maintenance: { consolidation: { ok: false, error: "lock wait timeout" }, reflections: { ok: true } } });
			expect(f).toEqual([expect.objectContaining({ severity: "high", area: "maintenance", title: 'Nightly step "consolidation" failed', evidence: "lock wait timeout" })]);
		});

		test("a failed news step isn't reported twice when the watcher rule already fired", () => {
			const f = run({
				news: newsMetrics([{ host: "a", lastCheckedAt: null }], 1),
				maintenance: { news: { ok: false, error: "news watcher isn't polling" } },
			});
			expect(f.map((x) => x.area)).toEqual(["news"]);
		});

		test("sessions that failed extraction are flagged", () => {
			const f = run({ news: newsMetrics([]), maintenance: { extraction: { ok: true, failed: 2 } } });
			expect(f[0]).toMatchObject({ severity: "medium", area: "memory" });
		});
	});

	// From 09-20 writes were zero for a week and no rule fired: the old rule
	// needed 30+ messages a day. Extraction is judged on proposals instead.
	describe("extraction", () => {
		const ex = (over) => ({
			available: true, runs: 0, days: 0, humanLines: 0, proposedFacts: 0, proposedMoments: 0, writtenFacts: 0, writtenMoments: 0,
			duplicate: 0, lowConfidence: 0, locked: 0, malformed: 0, overCap: 0, ...over,
		});
		const findingsFor = (extraction72h, humanMessages = 2) =>
			ruleFindings({
				metrics: {
					models: { last24h: healthyModels },
					chat: { available: true, droppedReplies: 0, humanMessages },
					memory: { available: true, embeddingCoverage: 1, conversationMoments72h: 0, extraction72h },
				},
				evals: {},
				config: { orcwoodCount: 1 },
			}).filter((x) => x.area === "memory");

		test("nothing proposed across three days is broken, however quiet the chat", () => {
			const [f] = findingsFor(ex({ runs: 4, days: 3, humanLines: 9 }));
			expect(f).toMatchObject({ severity: "high" });
			expect(f.title).toMatch(/proposed nothing in 4 runs over 3 days/);
		});

		test("one quiet day is not a failure", () => {
			expect(findingsFor(ex({ runs: 4, days: 1, humanLines: 9 }))).toEqual([]);
		});

		test("proposals that all get dropped say why", () => {
			const [f] = findingsFor(ex({ runs: 5, days: 2, proposedFacts: 12, duplicate: 11, lowConfidence: 1 }));
			expect(f).toMatchObject({ severity: "medium", title: "12 memory proposals in 72h, none written" });
			expect(f.evidence).toMatch(/11 already known, 1 low confidence/);
		});

		test("mostly re-stated facts is context, not work", () => {
			const [f] = findingsFor(ex({ runs: 5, days: 2, proposedFacts: 10, duplicate: 9, writtenFacts: 1 }));
			expect(f.severity).toBe("low");
		});

		test("with the log in place, the old volume rule stands down", () => {
			expect(findingsFor(ex({ runs: 2, days: 1, proposedFacts: 1, writtenFacts: 1 }), 50)).toEqual([]);
		});

		test("without the log, the old volume rule still covers it", () => {
			const f = findingsFor({ available: false, reason: "table missing — apply migrations" }, 50);
			expect(f[0].title).toMatch(/no new memories/);
		});
	});

	// 09-22: 6 nudges appraised, 6 ignored, 0 engaged — acceptance was null
	// (nobody engaged or dismissed), so no rule fired and the plan called
	// initiative "improved".
	const nudges = (byTrigger) => ({
		models: { last24h: healthyModels },
		initiative: { available: true, enabledProfiles: 1, sent7d: 6, byTrigger },
	});
	const trig = (over) => ({ sent: 0, engaged: 0, dismissed: 0, unseen: 0, ignored: 0, mutedBy: 0, learned: null, acceptance: null, ...over });

	test("nudges that reached people and got silence are flagged", () => {
		const f = ruleFindings({
			metrics: nudges({ "calendar-soon": trig({ sent: 4, ignored: 4 }), "news-pick": trig({ sent: 2, ignored: 2 }) }),
			evals: {},
			config: { orcwoodCount: 1 },
		});
		const silent = f.find((x) => x.area === "initiative");
		expect(silent).toMatchObject({ severity: "high", title: "100% of nudges people saw got no response" });
		expect(silent.evidence).toMatch(/6\/6 ignored, 0 engaged.*calendar-soon 4, news-pick 2/);
	});

	test("a few ignored nudges among engaged ones are not flagged", () => {
		const f = ruleFindings({
			metrics: nudges({ a: trig({ sent: 6, ignored: 2, engaged: 4, acceptance: 1 }) }),
			evals: {},
			config: { orcwoodCount: 1 },
		});
		expect(f.find((x) => x.area === "initiative")).toBeUndefined();
	});

	// admits-gap failed 09-18, passed four nights, failed 09-22 — graded
	// "improved" in between and treated as a regression after.

	test("a failure with passes in its history is marked intermittent context", () => {
		const f = ruleFindings({
			metrics: { models: { last24h: healthyModels } },
			evals: night(["admits-gap"]),
			evalHistory: [[], [], [], ["admits-gap"]].map((x) => ({ evals: night(x) })),
			config: { orcwoodCount: 1 },
		});
		expect(f.find((x) => x.area === "evals")).toMatchObject({
			severity: "low",
			title: "gemini admits-gap is intermittent, not a regression",
			evidence: expect.stringMatching(/failed 2 of the last 5 nights/),
		});
	});

	test("a case that fails every night is not called intermittent", () => {
		const f = ruleFindings({
			metrics: { models: { last24h: healthyModels } },
			evals: night(["admits-gap"]),
			evalHistory: [{ evals: night(["admits-gap"]) }, { evals: night(["admits-gap"]) }],
			config: { orcwoodCount: 1 },
		});
		expect(f.find((x) => x.area === "evals")).toBeUndefined();
	});
});

describe("evalRecord / thinSamples", () => {
	test("counts runs and failures per endpoint and case", () => {
		const rec = evalRecord(
			{ cases: [{ id: "a" }, { id: "b" }], endpoints: { g: { failures: [{ case: "a" }] } } },
			[{ evals: { cases: [{ id: "a" }, { id: "b" }], endpoints: { g: { failures: [] } } } }, { evals: { skipped: true, endpoints: {} } }]
		);
		expect(rec["g:a"]).toEqual({ endpoint: "g", case: "a", ran: 2, failed: 1 });
		expect(rec["g:b"]).toEqual({ endpoint: "g", case: "b", ran: 2, failed: 0 });
		expect(flakyCases(rec).map((x) => x.case)).toEqual(["a"]);
	});

	test("lists tasks and endpoints below the sample-size bar", () => {
		const thin = thinSamples({
			models: { last24h: { available: true, byTask: { json: { calls: 31 }, chat: { calls: 1 } }, byEndpoint: { "orcwood-dev": { calls: 4 }, gemini: { calls: 28 } } } },
		});
		expect(thin).toEqual(["task chat (1 calls)", "endpoint orcwood-dev (4 calls)"]);
	});
});

describe("writePlan", () => {
	test("gives the model context findings, thin samples and intermittent evals separately", async () => {
		llm.generateJson.mockResolvedValue({ data: { summary: "s", plan: [] }, endpointId: "gemini", tier: "frontier" });
		await writePlan({
			date: "2026-09-22",
			metrics: { models: { last24h: { available: true, byTask: { json: { calls: 31 } }, byEndpoint: { "orcwood-dev": { calls: 4 } } } } },
			evals: night(["admits-gap"]),
			evalHistory: [{ evals: night([]) }],
			findings: [
				{ severity: "medium", area: "models", title: "json invalid", evidence: "2/31" },
				{ severity: "low", area: "localization", title: "Orcwood served 6% of calls, but this job cannot reach those endpoints", evidence: "x" },
			],
			previousPlan: null,
		});
		const prompt = llm.generateJson.mock.calls.at(-1)[0].contents;
		const [actionable, rest] = prompt.split("Context only (not plan items):");
		expect(actionable).toMatch(/json invalid/);
		expect(actionable).not.toMatch(/Orcwood served 6%/);
		expect(rest).toMatch(/Orcwood served 6%/);
		expect(prompt).toMatch(/Too few calls to judge: endpoint orcwood-dev \(4 calls\)/);
		expect(prompt).toMatch(/Intermittent evals over recent nights: gemini admits-gap: failed 1\/2 nights/);
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

	test("extraction proposals and drop reasons are in the memory section", () => {
		const md = renderMarkdown({
			date: "2026-09-27",
			metrics: {
				models: { last24h: { available: true, byTask: {} } },
				memory: {
					available: true, newEventsByKind: {}, newAiFacts: 0, embeddingCoverage: 1, totalEvents: 296, eventsRecalled24h: 0,
					extraction72h: { available: true, runs: 5, humanLines: 20, proposedFacts: 12, proposedMoments: 1, writtenFacts: 0, writtenMoments: 1, duplicate: 11, lowConfidence: 1, locked: 0, malformed: 0, overCap: 0 },
				},
			},
			evals: {},
			findings: [],
			plan: fallbackPlan([]),
			maintenance: {},
		});
		expect(md).toMatch(/Extraction \(72h\): 5 runs .* proposed 12 facts \/ 1 moments, wrote 0 \/ 1; dropped 11 already known, 1 low confidence/);
	});

	test("the rules-only plan never turns a context finding into work", () => {
		const plan = fallbackPlan([
			{ severity: "medium", area: "models", title: "json invalid", evidence: "x" },
			{ severity: "low", area: "localization", title: "Orcwood served 6% of calls", evidence: "x" },
		]);
		expect(plan.plan.map((p) => p.title)).toEqual(["json invalid"]);
	});
});
