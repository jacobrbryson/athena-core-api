/**
 * Model router tests: tier ordering, policy, fallback, circuit breaking, and
 * the no-cross-model rule for embeddings.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn().mockResolvedValue([[]]) }));

const mockGenerateContent = jest.fn();
const mockEmbedContent = jest.fn();
jest.mock("@google/genai", () => ({
	GoogleGenAI: jest.fn().mockImplementation(() => ({
		models: { generateContent: mockGenerateContent, embedContent: mockEmbedContent },
	})),
}));

const ORCWOOD = [
	{
		id: "orc-a",
		baseUrl: "http://orc-a:11434/v1",
		models: { chat: "qwen3:8b", vision: "qwen2.5vl:7b", embed: "nomic-embed-text" },
	},
];

function setEnv(over = {}) {
	process.env.GEMINI_API_KEY = "test-key";
	process.env.LLM_ORCWOOD_ENDPOINTS = JSON.stringify(ORCWOOD);
	delete process.env.LLM_POLICY;
	delete process.env.LLM_CHILD_POLICY;
	delete process.env.LLM_EMBED_MODEL;
	Object.assign(process.env, over);
}

function okCompletion(content) {
	return {
		ok: true,
		json: async () => ({ choices: [{ message: { content } }], usage: {} }),
	};
}

let router;
let health;
beforeEach(() => {
	jest.resetModules();
	setEnv();
	global.fetch = jest.fn();
	mockGenerateContent.mockReset();
	mockEmbedContent.mockReset();
	router = require("./router");
	health = require("./health");
	require("./telemetry")._disableDb();
	router.reload();
});

describe("candidate ordering", () => {
	test("local-first puts Orcwood ahead of the frontier", () => {
		expect(router.candidatesFor("chat").map((e) => e.id)).toEqual(["orc-a", "gemini"]);
	});

	test("child sessions default to frontier-first", () => {
		expect(router.candidatesFor("chat", { audience: "child" }).map((e) => e.id)).toEqual([
			"gemini",
			"orc-a",
		]);
	});

	test("frontier-only drops Orcwood entirely", () => {
		setEnv({ LLM_POLICY: "frontier-only" });
		router.reload();
		expect(router.candidatesFor("chat").map((e) => e.id)).toEqual(["gemini"]);
	});

	test("TTS and tool calling are pinned to the frontier", () => {
		expect(router.candidatesFor("tts").map((e) => e.id)).toEqual(["gemini"]);
		expect(router.candidatesFor("tools").map((e) => e.id)).toEqual(["gemini"]);
	});

	test("with no Orcwood endpoints configured, behavior is Gemini-only (unchanged prod)", () => {
		setEnv({ LLM_ORCWOOD_ENDPOINTS: "" });
		router.reload();
		expect(router.candidatesFor("chat").map((e) => e.id)).toEqual(["gemini"]);
	});
});

describe("generate + fallback", () => {
	test("Orcwood serves when healthy", async () => {
		global.fetch.mockResolvedValueOnce(okCompletion('{"response":"hi"}'));
		const out = await router.generate({ task: "chat", contents: "hello" });
		expect(out).toMatchObject({ endpointId: "orc-a", tier: "orcwood", text: '{"response":"hi"}' });
		expect(mockGenerateContent).not.toHaveBeenCalled();
	});

	test("an Orcwood error falls through to Gemini", async () => {
		global.fetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
		mockGenerateContent.mockResolvedValueOnce({ text: '{"response":"from gemini"}' });
		const out = await router.generate({ task: "chat", contents: "hello" });
		expect(out.endpointId).toBe("gemini");
	});

	test("invalid output from a local model falls through, without tripping its circuit", async () => {
		const llm = require("./index");
		global.fetch.mockResolvedValueOnce(okCompletion("sure! here you go: {broken"));
		mockGenerateContent.mockResolvedValueOnce({ text: '{"ok":true}' });
		const out = await llm.generateJson({ task: "json", contents: "x" });
		expect(out).toMatchObject({ endpointId: "gemini", data: { ok: true } });
		expect(health.isAvailable("orc-a")).toBe(true);
	});

	test("the circuit opens after repeated failures and Orcwood is skipped", async () => {
		for (let i = 0; i < health.FAILURE_THRESHOLD; i++) {
			global.fetch.mockRejectedValueOnce(new Error("down"));
			mockGenerateContent.mockResolvedValueOnce({ text: "{}" });
			await router.generate({ task: "chat", contents: "x" });
		}
		expect(health.isAvailable("orc-a")).toBe(false);

		global.fetch.mockClear();
		mockGenerateContent.mockResolvedValueOnce({ text: "{}" });
		await router.generate({ task: "chat", contents: "x" });
		expect(global.fetch).not.toHaveBeenCalled();
	});

	test("if every circuit is open, still try rather than refuse (half-open)", async () => {
		setEnv({ LLM_POLICY: "local-first", GEMINI_API_KEY: "" });
		router.reload();
		for (let i = 0; i < health.FAILURE_THRESHOLD; i++) {
			global.fetch.mockRejectedValueOnce(new Error("down"));
			await expect(router.generate({ task: "chat", contents: "x" })).rejects.toThrow(
				router.NoModelAvailableError
			);
		}
		global.fetch.mockResolvedValueOnce(okCompletion("{}"));
		await expect(router.generate({ task: "chat", contents: "x" })).resolves.toMatchObject({
			endpointId: "orc-a",
		});
	});

	test("Gemini receives a string prompt wrapped exactly as before the router", async () => {
		setEnv({ LLM_ORCWOOD_ENDPOINTS: "" });
		router.reload();
		mockGenerateContent.mockResolvedValueOnce({ text: "{}" });
		await router.generate({ task: "json", contents: "PROMPT" });
		expect(mockGenerateContent).toHaveBeenCalledWith({
			model: "gemini-3.5-flash-lite",
			contents: [{ role: "user", parts: [{ text: "PROMPT" }] }],
			config: { responseMimeType: "application/json" },
		});
	});
});

describe("embeddings", () => {
	test("never fall back to a different model's vector space", async () => {
		setEnv({ LLM_EMBED_MODEL: "orc-a:nomic-embed-text" });
		router.reload();
		global.fetch.mockRejectedValueOnce(new Error("down"));
		await expect(router.embed(["hello"])).rejects.toThrow("down");
		expect(mockEmbedContent).not.toHaveBeenCalled();
	});

	test("report the space they belong to", async () => {
		mockEmbedContent.mockResolvedValueOnce({ embeddings: [{ values: [0.1, 0.2] }] });
		const out = await router.embed("hello");
		expect(out).toEqual({ vectors: [[0.1, 0.2]], space: "gemini:gemini-embedding-001", dims: 2 });
	});
});

describe("OpenAI-compatible adapter helpers", () => {
	const { toMessages, cleanOutput } = require("./adapters/openaiCompat");

	test("unpacks the prompt builder's JSON-string contents into real roles", () => {
		const contents = JSON.stringify([
			{ role: "system", parts: [{ text: "be Athena" }] },
			{ role: "model", parts: [{ text: "hello" }] },
			{ role: "user", parts: [{ text: "hi" }] },
		]);
		expect(toMessages(contents)).toEqual([
			{ role: "system", content: "be Athena" },
			{ role: "assistant", content: "hello" },
			{ role: "user", content: "hi" },
		]);
	});

	test("images become image_url parts", () => {
		const out = toMessages([
			{ role: "user", parts: [{ text: "what is this" }, { inlineData: { mimeType: "image/png", data: "AAA" } }] },
		]);
		expect(out[0].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } });
	});

	test("strips reasoning blocks and JSON fences", () => {
		expect(cleanOutput('<think>hmm</think>\n```json\n{"a":1}\n```', true)).toBe('{"a":1}');
	});
});

describe("device manifest", () => {
	test("entries without a download URL stay disabled; version is stable", () => {
		const { buildManifest } = require("./manifest");
		const a = buildManifest();
		const b = buildManifest();
		expect(a.version).toBe(b.version);
		expect(a.models.find((m) => m.id === "vision-detector").enabled).toBe(false);
		expect(a.models.find((m) => m.id === "gemini-nano").enabled).toBe(true);
	});
});
