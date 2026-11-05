/**
 * The per-turn performance trace. What matters most is what it must never
 * do: slow a turn, throw into one, or log a person's words.
 */
process.env.LLM_TELEMETRY_DB = "false";

const perfTrace = require("./perfTrace");

const tick = () => new Promise((r) => setImmediate(r));

let logSpy;
beforeEach(() => {
	delete process.env.PERF_TRACE;
	delete process.env.PERF_TRACE_SAMPLE;
	perfTrace._reload();
	logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});
// Let any line still queued from this test be written before the spy goes.
afterEach(async () => {
	await tick();
	logSpy.mockRestore();
});

const lines = () =>
	logSpy.mock.calls
		.map(([l]) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter((l) => l?.message === "[perf] turn");

describe("outside a trace", () => {
	it("every call is a harmless no-op", async () => {
		expect(perfTrace.current()).toBeNull();
		expect(() => {
			perfTrace.mark("x");
			perfTrace.set({ a: 1 });
			perfTrace.begin("span")({ b: 2 });
			perfTrace.llmCall({ task: "chat" });
			perfTrace.dbQuery("SELECT 1", 3, false);
			perfTrace.end();
		}).not.toThrow();
		const p = Promise.resolve(5);
		expect(perfTrace.timed("t", p)).toBe(p);
		expect(perfTrace.timed("t", null)).toBeNull();
		await tick();
		expect(lines()).toHaveLength(0);
	});
});

describe("one turn", () => {
	it("follows the turn across awaits and writes one line after it ends", async () => {
		const trace = perfTrace.start("message", { client: "android" });
		await perfTrace.run(trace, async () => {
			perfTrace.mark("msg.received", { textChars: 31 });
			await tick();
			const end = perfTrace.begin("memory.recall");
			await new Promise((r) => setTimeout(r, 5));
			end({ chars: 120 });
			await perfTrace.timed("ground.connectors", Promise.resolve("block"));
			await perfTrace.timed("ground.web", Promise.resolve(null));
			perfTrace.llmCall({ task: "chat", endpointId: "gemini", tier: "frontier", model: "g", outcome: "ok", latencyMs: 900, inputChars: 5000, outputChars: 300 });
			perfTrace.dbQuery("SELECT *\n   FROM chat WHERE id = ?", 12, false);
			perfTrace.end({ outcome: "answered" });
		});
		// Nothing is written on the turn's own tick.
		expect(lines()).toHaveLength(0);
		await tick();
		const [line] = lines();
		expect(line.severity).toBe("INFO");
		const perf = line.perf;
		expect(perf).toMatchObject({ kind: "message", client: "android", textChars: 31, outcome: "answered" });
		expect(perf.marks["msg.received"]).toBeGreaterThanOrEqual(0);
		const recall = perf.spans.find((s) => s.n === "memory.recall");
		expect(recall.d).toBeGreaterThanOrEqual(4);
		expect(recall.a).toEqual({ chars: 120 });
		expect(perf.spans.find((s) => s.n === "ground.web").a).toEqual({ empty: true });
		expect(perf.llm[0]).toMatchObject({ task: "chat", ep: "gemini", ms: 900, in: 5000 });
		expect(perf.llmMs).toBe(900);
		expect(perf.db).toMatchObject({ n: 1, ms: 12, max: 12 });
		expect(perf.db.slow[0].sql).toBe("SELECT * FROM chat WHERE id = ?");
		expect(perf.totalMs).toBeGreaterThan(0);
		expect(typeof perf.heapMb).toBe("number");
	});

	it("ends once, however many times it is told to", async () => {
		const trace = perfTrace.start("message");
		trace.end();
		trace.end();
		perfTrace.run(trace, () => perfTrace.end());
		await tick();
		expect(lines()).toHaveLength(1);
	});

	it("records nothing after it has ended", async () => {
		const trace = perfTrace.start("message");
		trace.end();
		perfTrace.run(trace, () => {
			perfTrace.mark("late");
			perfTrace.begin("late")();
		});
		await tick();
		expect(lines()[0].perf.marks).toEqual({});
		expect(lines()[0].perf.spans).toEqual([]);
	});

	it("keeps two concurrent turns apart", async () => {
		const a = perfTrace.start("message", { who: "a" });
		const b = perfTrace.start("message", { who: "b" });
		await Promise.all([
			perfTrace.run(a, async () => {
				await tick();
				perfTrace.mark("only.a");
				perfTrace.end();
			}),
			perfTrace.run(b, async () => {
				await tick();
				perfTrace.mark("only.b");
				perfTrace.end();
			}),
		]);
		await tick();
		const byWho = Object.fromEntries(lines().map((l) => [l.perf.who, l.perf]));
		expect(Object.keys(byWho.a.marks)).toEqual(["only.a"]);
		expect(Object.keys(byWho.b.marks)).toEqual(["only.b"]);
	});

	it("marks a failed promise without changing it or leaving it unhandled", async () => {
		const trace = perfTrace.start("message");
		const failing = Promise.reject(new Error("boom"));
		await perfTrace.run(trace, async () => {
			await expect(perfTrace.timed("ground.trading", failing)).rejects.toThrow("boom");
			perfTrace.end();
		});
		await tick();
		expect(lines()[0].perf.spans[0]).toMatchObject({ n: "ground.trading", a: { failed: true } });
	});
});

describe("never slows a turn", () => {
	it("caps every list and counts what it dropped", async () => {
		const trace = perfTrace.start("message");
		perfTrace.run(trace, () => {
			for (let i = 0; i < perfTrace.MAX_SPANS + 25; i++) perfTrace.begin(`s${i}`)();
			for (let i = 0; i < perfTrace.MAX_LLM + 5; i++) perfTrace.llmCall({ task: "chat", latencyMs: 1 });
			for (let i = 0; i < 500; i++) perfTrace.dbQuery(`SELECT ${i}`, i, false);
			perfTrace.end();
		});
		await tick();
		const perf = lines()[0].perf;
		expect(perf.spans).toHaveLength(perfTrace.MAX_SPANS);
		expect(perf.llm).toHaveLength(perfTrace.MAX_LLM);
		expect(perf.dropped).toBe(30);
		expect(perf.db.n).toBe(500);
		// Only the slowest few statements are kept, slowest first.
		expect(perf.db.slow).toHaveLength(perfTrace.MAX_SLOW_QUERIES);
		expect(perf.db.slow[0].ms).toBe(499);
	});

	it("drops whole traces rather than queue too many", async () => {
		const many = perfTrace.MAX_PENDING + 7;
		for (let i = 0; i < many; i++) perfTrace.start("message").end();
		await tick();
		expect(lines()).toHaveLength(perfTrace.MAX_PENDING);
		// The next line written says how many went missing, once.
		expect(lines()[0].perf.droppedTraces).toBe(7);
		expect(lines().filter((l) => l.perf.droppedTraces)).toHaveLength(1);
	});

	it("swallows a log write that fails", async () => {
		logSpy.mockImplementation(() => {
			throw new Error("stdout closed");
		});
		perfTrace.start("message").end();
		await expect(tick()).resolves.toBeUndefined();
	});

	it("costs microseconds per recorded event", () => {
		const trace = perfTrace.start("message");
		const started = performance.now();
		perfTrace.run(trace, () => {
			for (let i = 0; i < 20000; i++) {
				perfTrace.mark("m");
				perfTrace.dbQuery("SELECT 1", 0.1, false);
				perfTrace.set({ i });
			}
		});
		// 60,000 calls; a generous bound so this never flakes.
		expect(performance.now() - started).toBeLessThan(500);
		trace.end();
	});

	it("can be turned off, or sampled", () => {
		process.env.PERF_TRACE = "off";
		perfTrace._reload();
		expect(perfTrace.start("message")).toBeNull();

		delete process.env.PERF_TRACE;
		process.env.PERF_TRACE_SAMPLE = "0";
		perfTrace._reload();
		expect(perfTrace.start("message")).toBeNull();

		process.env.PERF_TRACE_SAMPLE = "1";
		perfTrace._reload();
		const t = perfTrace.start("message");
		expect(t).not.toBeNull();
		t.end();
	});
});

describe("wiring", () => {
	it("every routed model call lands on the current turn", async () => {
		const telemetry = require("./llm/telemetry");
		const trace = perfTrace.start("message");
		perfTrace.run(trace, () => {
			telemetry.recordCall({ task: "intent", endpointId: "jev", tier: "frontier", model: "jev-1", outcome: "ok", latencyMs: 180 });
			perfTrace.end();
		});
		await tick();
		expect(lines()[0].perf.llm[0]).toMatchObject({ task: "intent", ep: "jev", ms: 180 });
	});

	it("never logs words: only ids, sizes and timings", async () => {
		const trace = perfTrace.start("message");
		perfTrace.run(trace, () => {
			perfTrace.mark("msg.received", { textChars: 11 });
			perfTrace.dbQuery({ sql: "INSERT INTO chat (text) VALUES (?)", values: ["secret plan"] }, 4, false);
			perfTrace.end();
		});
		await tick();
		const raw = logSpy.mock.calls.map(([l]) => l).join("\n");
		expect(raw).not.toContain("secret plan");
		expect(lines()[0].perf.db.slow[0].sql).toBe("INSERT INTO chat (text) VALUES (?)");
	});

	it("writes an abandoned turn eventually, flagged", async () => {
		jest.useFakeTimers();
		try {
			const trace = perfTrace.start("message");
			jest.advanceTimersByTime(3 * 60 * 1000 + 1);
			expect(trace.ended).toBe(true);
			expect(trace.fields.abandoned).toBe(true);
		} finally {
			jest.useRealTimers();
		}
		await tick();
		expect(lines().at(-1).severity).toBe("WARNING");
	});
});
