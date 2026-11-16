/**
 * Contingency: what happens when a model runs out, and how we prove it.
 *
 *   - a quota error takes Gemini out for an hour on the first try, and chat
 *     falls to the desktop model with an honest outage summary
 *   - drills simulate an outage for one request (or one server, timed)
 *     without touching the real circuit breaker
 *   - the "smart" policy lets a local model answer first only when it has
 *     eval evidence, speed and room for the prompt — and never for a child
 *   - the tailnet route only ever goes to a fixed https *.ts.net address
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn().mockResolvedValue([[]]) }));
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn().mockResolvedValue() }));

const mockGenerateContent = jest.fn();
jest.mock("@google/genai", () => ({
	GoogleGenAI: jest.fn().mockImplementation(() => ({ models: { generateContent: mockGenerateContent, embedContent: jest.fn() } })),
}));

const LOCAL = { id: "desk", baseUrl: "http://desk:11434/v1", models: { chat: "qwen2.5:7b-instruct", extract: "qwen2.5:7b-instruct" } };

function setEnv(over = {}) {
	process.env.GEMINI_API_KEY = "test-key";
	process.env.LLM_ORCWOOD_ENDPOINTS = JSON.stringify([LOCAL]);
	delete process.env.OPENAI_API_KEY;
	delete process.env.LLM_CHILD_POLICY;
	delete process.env.LLM_QUOTA_COOLDOWN_MS;
	delete process.env.LLM_TAILSCALE_HTTP_PROXY;
	process.env.LLM_POLICY = "smart";
	Object.assign(process.env, over);
}

const okCompletion = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }], usage: {} }) });
const quotaError = () => Object.assign(new Error("got status: 429 Too Many Requests. RESOURCE_EXHAUSTED: You exceeded your current quota"), { status: 429 });

let router, health, drill, evalStore;
beforeEach(() => {
	jest.resetModules();
	setEnv();
	global.fetch = jest.fn();
	mockGenerateContent.mockReset();
	router = require("./router");
	health = require("./health");
	drill = require("./drill");
	evalStore = require("./evalStore");
	require("./telemetry")._disableDb();
	evalStore._disableDb();
	evalStore.reset();
	evalStore._setLoaded();
	router.reload();
});

afterAll(() => {
	delete process.env.LLM_POLICY;
});

/** Eval evidence: the local model scoring `local`, Gemini `frontier` (passed/total). */
function evidence({ local = [6, 6], frontier = [6, 6], localLatency = 1500 } = {}) {
	evalStore.record({
		endpoints: {
			desk: { tier: "orcwood", avgLatencyMs: localLatency, bySuite: { "reply-contract": { passed: local[0] * 4 / 6, total: 4, model: LOCAL.models.chat }, "recall-honesty": { passed: local[0] * 2 / 6, total: 2, model: LOCAL.models.chat }, extraction: { passed: 2, total: 2, model: LOCAL.models.extract } } },
			gemini: { tier: "frontier", avgLatencyMs: 700, bySuite: { "reply-contract": { passed: frontier[0] * 4 / 6, total: 4 }, "recall-honesty": { passed: frontier[0] * 2 / 6, total: 2 }, extraction: { passed: 2, total: 2 } } },
		},
	});
}

describe("quota errors", () => {
	test("are classified apart from rate limits and timeouts", () => {
		expect(health.classify(quotaError())).toBe("quota");
		expect(health.classify(new Error("openai /chat/completions -> HTTP 429 insufficient_quota"))).toBe("quota");
		expect(health.classify(new Error("gemini -> HTTP 429 Too Many Requests"))).toBe("rate_limit");
		expect(health.classify(new Error("desk /chat/completions timed out"))).toBe("timeout");
		expect(health.classify(new Error("ECONNREFUSED"))).toBe("error");
	});

	test("one quota error opens the circuit for the quota cooldown, not 30 seconds", () => {
		const now = 1_000_000;
		health.reportFailure("gemini", quotaError(), now);
		expect(health.isAvailable("gemini", now + 10 * 60_000)).toBe(false);
		expect(health.isAvailable("gemini", now + 61 * 60_000)).toBe(true);
		expect(health.snapshot(now + 1000).find((h) => h.id === "gemini")).toMatchObject({ circuit: "open", openReason: "quota" });
	});

	test("Gemini out of quota: chat falls to the desktop and the outage says so", async () => {
		mockGenerateContent.mockRejectedValue(quotaError());
		global.fetch.mockResolvedValue(okCompletion('{"response":"from the desk"}'));

		const first = await router.generate({ task: "chat", contents: "hello" });
		expect(first).toMatchObject({ endpointId: "desk", tier: "orcwood", fallback: true });
		expect(first.why).toMatch(/fallback after gemini/);

		// The second call doesn't even try Gemini: its circuit is open.
		mockGenerateContent.mockClear();
		const second = await router.generate({ task: "chat", contents: "again" });
		expect(second.endpointId).toBe("desk");
		expect(mockGenerateContent).not.toHaveBeenCalled();

		const o = router.outage();
		expect(o.level).toBe("degraded");
		expect(o.down).toEqual([expect.objectContaining({ endpointId: "gemini", reason: "quota" })]);
		expect(o.answering).toMatchObject({ endpointId: "desk", tier: "orcwood" });
		expect(o.message).toMatch(/Gemini is out of quota\. Athena is answering with the desktop model \(slower\)\./);
		expect(o.lost).toEqual(expect.arrayContaining(["her voice", "web search"]));
	});

	test("the desktop being off is a backup problem, not a banner", () => {
		health.reportFailure("desk", new Error("desk /chat/completions timed out"));
		const o = router.outage();
		expect(o.level).toBe("ok");
		expect(o.backupDown).toEqual([expect.objectContaining({ endpointId: "desk" })]);
	});

	test("nothing left to answer is 'down'", () => {
		health.reportFailure("gemini", quotaError());
		health.reportFailure("desk", new Error("desk timed out"));
		// Both open: the router still tries them (half-open), but the summary is honest.
		expect(router.outage()).toMatchObject({ level: "down", answering: null });
	});
});

describe("drills", () => {
	test("a request drill only affects calls inside it, and never trips the real circuit", async () => {
		global.fetch.mockResolvedValue(okCompletion('{"response":"desk"}'));
		mockGenerateContent.mockResolvedValue({ text: '{"response":"gemini"}' });

		const drilled = await drill.runWithDrill("gemini-quota", () => router.generate({ task: "chat", contents: "x" }));
		expect(drilled).toMatchObject({ endpointId: "desk", fallback: true });
		expect(drilled.attempts).toEqual([expect.objectContaining({ id: "gemini", drill: true })]);
		expect(mockGenerateContent).not.toHaveBeenCalled();
		expect(health.isAvailable("gemini")).toBe(true);

		const normal = await router.generate({ task: "chat", contents: "x" });
		expect(normal.endpointId).toBe("gemini");
		expect(router.outage().level).toBe("ok");
	});

	test("drills also take out the pinned paths (voice, search)", async () => {
		await expect(drill.runWithDrill("gemini-quota", () => router.speech("hi"))).rejects.toThrow(/drill/);
		await expect(drill.runWithDrill("gemini-quota", () => router.search("weather"))).rejects.toThrow(/drill/);
	});

	test("a server drill shows in the outage summary and ends by itself", async () => {
		const now = Date.now();
		drill.startServerDrill("gemini-quota", 5, { now });
		const o = router.outage(now + 1000);
		expect(o).toMatchObject({ level: "degraded", drill: expect.objectContaining({ scenario: "gemini-quota" }) });
		expect(o.down[0]).toMatchObject({ endpointId: "gemini", drill: "gemini-quota" });
		expect(router.outage(now + 6 * 60_000)).toMatchObject({ level: "ok", drill: null });
	});

	test("a server drill is capped at 30 minutes and can be stopped", () => {
		const now = Date.now();
		const d = drill.startServerDrill("local-offline", 999, { now });
		expect(d.endsAt - now).toBe(30 * 60_000);
		expect(drill.stopServerDrill()).toBe(true);
		expect(drill.describeServerDrill()).toBeNull();
	});

	test("unknown scenarios are refused", () => {
		expect(() => drill.runWithDrill("everything", () => null)).toThrow(/Unknown drill/);
		expect(() => drill.startServerDrill("__proto__", 5)).toThrow(/Unknown drill/);
	});
});

describe("smart policy: the local model leads only when it has earned it", () => {
	const lead = (task, opts) => router.preview(task, opts).decision;

	test("with no eval evidence, Gemini answers and the desktop is the fallback", () => {
		const p = router.preview("chat");
		expect(p.chain.map((c) => c.endpointId)).toEqual(["gemini", "desk"]);
		expect(p.decision.lead.why).toMatch(/fallback: evidence/);
	});

	test("with evidence as good as Gemini's, the desktop answers typed chat and background work", () => {
		evidence();
		expect(router.preview("chat").chain[0].endpointId).toBe("desk");
		expect(router.preview("extract").chain[0].endpointId).toBe("desk");
		expect(lead("chat").lead.why).toBe("local model passed every check");
	});

	test("scoring worse than Gemini on any suite keeps it the fallback", () => {
		evidence({ local: [3, 6], frontier: [6, 6] });
		expect(router.preview("chat").chain[0].endpointId).toBe("gemini");
	});

	test("evidence about a different model doesn't count", () => {
		evalStore.record({ endpoints: { desk: { tier: "orcwood", avgLatencyMs: 1000, bySuite: { "reply-contract": { passed: 4, total: 4, model: "llama3:8b" }, "recall-honesty": { passed: 2, total: 2, model: "llama3:8b" } } } } });
		expect(router.preview("chat").chain[0].endpointId).toBe("gemini");
	});

	test("a spoken turn needs the desktop to be fast", () => {
		evidence({ localLatency: 6000 });
		expect(router.preview("chat", { urgency: "voice" }).chain[0].endpointId).toBe("gemini");
		expect(router.preview("chat", { urgency: "interactive" }).chain[0].endpointId).toBe("desk");
	});

	test("a prompt too big for the local window goes to Gemini", () => {
		evidence();
		expect(router.preview("chat", { contents: "x".repeat(30_000) }).chain[0].endpointId).toBe("gemini");
	});

	test("children always get Gemini first, and a child's extraction never runs locally", () => {
		evidence();
		expect(router.preview("chat", { audience: "child" }).chain[0].endpointId).toBe("gemini");
		const p = router.preview("extract", { audience: "child" });
		expect(p.chain.map((c) => c.endpointId)).toEqual(["gemini"]);
		expect(p.decision.excluded.endpoints).toEqual(["desk"]);
	});

	test("a child's extraction waits during an outage rather than running locally", async () => {
		mockGenerateContent.mockRejectedValue(quotaError());
		global.fetch.mockResolvedValue(okCompletion('{"facts":[]}'));
		await expect(router.generate({ task: "extract", contents: "x", audience: "child" })).rejects.toThrow(router.NoModelAvailableError);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	test("a web-grounded reply still prefers the frontier", () => {
		evidence();
		expect(router.preview("chat", { prefer: "frontier" }).chain[0].endpointId).toBe("gemini");
	});

	test("pinned tasks are never reordered", () => {
		evidence();
		expect(router.preview("tts").chain.map((c) => c.endpointId)).toEqual(["gemini"]);
	});
});

describe("tailnet route", () => {
	const config = () => require("./config").loadConfig();

	test("accepts a fixed https *.ts.net endpoint and routes it through the local proxy", () => {
		setEnv({
			LLM_TAILSCALE_HTTP_PROXY: "http://127.0.0.1:1055",
			LLM_ORCWOOD_ENDPOINTS: JSON.stringify([{ id: "desk", baseUrl: "https://bt-one.tail91d9bb.ts.net:8443/v1", viaTailnet: true, apiKeySecret: "OLLAMA_GATE_TOKEN", models: { chat: "qwen2.5:7b-instruct" } }]),
		});
		const [e] = config().orcwood;
		expect(e).toMatchObject({ tailnet: "http://127.0.0.1:1055", apiKeySecret: "OLLAMA_GATE_TOKEN" });
		expect(require("./adapters/openaiCompat").dispatcherFor(e)).toBeDefined();
	});

	test("refuses a tailnet endpoint that isn't https *.ts.net", () => {
		setEnv({ LLM_ORCWOOD_ENDPOINTS: JSON.stringify([{ id: "x", baseUrl: "http://evil.example.com/v1", viaTailnet: true, models: { chat: "m" } }]) });
		expect(config().orcwood).toEqual([]);
	});

	test("refuses any other proxy address", () => {
		setEnv({
			LLM_TAILSCALE_HTTP_PROXY: "http://10.0.0.9:3128",
			LLM_ORCWOOD_ENDPOINTS: JSON.stringify([{ id: "desk", baseUrl: "https://bt-one.tail91d9bb.ts.net/v1", viaTailnet: true, models: { chat: "m" } }]),
		});
		expect(config().orcwood).toEqual([]);
	});

	test("ordinary endpoints get no proxy, and the adapter re-checks a forged one", () => {
		const { dispatcherFor } = require("./adapters/openaiCompat");
		expect(dispatcherFor({ id: "a", baseUrl: "http://127.0.0.1:11434/v1", tailnet: null })).toBeUndefined();
		expect(() => dispatcherFor({ id: "a", baseUrl: "https://api.openai.com/v1", tailnet: "http://127.0.0.1:1055" })).toThrow(/invalid tailnet/);
	});
});
