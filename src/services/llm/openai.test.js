/**
 * OpenAI as a frontier provider: endpoint construction, the image path, and
 * the guarantee that adding it does not silently re-route existing traffic.
 */
const mockAssertAccess = jest.fn().mockResolvedValue();
jest.mock("../../security/access", () => ({
	assertModelAccess: mockAssertAccess,
	context: { getStore: () => null },
}));
jest.mock("../../security/mission", () => ({ CORE_MISSION: "mission" }));

const mockGetSecret = jest.fn();
jest.mock("../secrets", () => ({ getSecret: mockGetSecret }));

jest.mock("@google/genai", () => ({
	GoogleGenAI: jest.fn().mockImplementation(() => ({ models: {} })),
}));

const { loadConfig } = require("./config");
const openaiAdapter = require("./adapters/openaiCompat");
const router = require("./router");

const OPENAI_ENV = [
	"OPENAI_API_KEY",
	"OPENAI_ENABLED",
	"OPENAI_CHAT_MODEL",
	"OPENAI_VISION_MODEL",
	"OPENAI_IMAGE_MODEL",
	"OPENAI_PRIORITY",
	"OPENAI_BASE_URL",
	"LLM_POLICY",
	"LLM_ORCWOOD_ENDPOINTS",
];

function apiResponse(body, { ok = true, status = 200 } = {}) {
	return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

// Env is process-wide and jest reuses a worker across suites, so snapshot
// everything this file touches and put it back — otherwise GEMINI_API_KEY
// leaks into whichever suite runs next.
const ENV_KEYS = [...OPENAI_ENV, "GEMINI_API_KEY"];
const savedEnv = {};

beforeAll(() => {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	router.reload();
});

beforeEach(() => {
	jest.clearAllMocks();
	for (const key of OPENAI_ENV) delete process.env[key];
	process.env.GEMINI_API_KEY = "gemini-key";
	mockGetSecret.mockResolvedValue(null);
	mockAssertAccess.mockResolvedValue();
	global.fetch = jest.fn();
	jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("endpoint construction", () => {
	it("is absent until a key or the enable flag is set", () => {
		expect(loadConfig().frontier.map((e) => e.id)).toEqual(["gemini"]);
	});

	it("appears when OPENAI_API_KEY is set", () => {
		process.env.OPENAI_API_KEY = "sk-test";
		const openai = loadConfig().frontier.find((e) => e.id === "openai");
		expect(openai).toMatchObject({
			tier: "frontier",
			kind: "openai",
			baseUrl: "https://api.openai.com/v1",
			supportsJsonSchema: true,
		});
	});

	it("can be enabled with the key living only in Secret Manager", () => {
		process.env.OPENAI_ENABLED = "true";
		const openai = loadConfig().frontier.find((e) => e.id === "openai");
		expect(openai).toBeDefined();
		expect(openai.apiKey).toBe("");
		expect(openai.apiKeySecret).toBe("OPENAI_API_KEY");
	});

	it("declares no text models unless they are named explicitly", () => {
		// An invented model id 404s at the provider, so nothing is defaulted.
		process.env.OPENAI_API_KEY = "sk-test";
		const openai = loadConfig().frontier.find((e) => e.id === "openai");
		expect(openai.models.chat).toBeNull();
		expect(openai.models.json).toBeNull();
		expect(openai.models.vision).toBeNull();
	});

	it("defaults only the image model", () => {
		process.env.OPENAI_API_KEY = "sk-test";
		expect(
			loadConfig().frontier.find((e) => e.id === "openai").models.image
		).toBe("gpt-image-1");
		process.env.OPENAI_IMAGE_MODEL = "gpt-image-2.5-flare";
		expect(
			loadConfig().frontier.find((e) => e.id === "openai").models.image
		).toBe("gpt-image-2.5-flare");
	});

	it("spreads one chat model across the text tasks", () => {
		process.env.OPENAI_API_KEY = "sk-test";
		process.env.OPENAI_CHAT_MODEL = "gpt-x";
		const { models } = loadConfig().frontier.find((e) => e.id === "openai");
		expect(models).toMatchObject({
			chat: "gpt-x",
			json: "gpt-x",
			extract: "gpt-x",
			review: "gpt-x",
		});
	});

	it("orders behind Gemini by default, and can be promoted", () => {
		process.env.OPENAI_API_KEY = "sk-test";
		process.env.OPENAI_CHAT_MODEL = "gpt-x";
		expect(loadConfig().frontier.map((e) => e.id)).toEqual(["gemini", "openai"]);

		process.env.OPENAI_PRIORITY = "-1";
		expect(loadConfig().frontier.map((e) => e.id)).toEqual(["openai", "gemini"]);
	});
});

describe("routing", () => {
	beforeEach(() => {
		process.env.OPENAI_API_KEY = "sk-test";
		process.env.OPENAI_CHAT_MODEL = "gpt-x";
		router.reload();
	});
	afterEach(() => {
		for (const key of OPENAI_ENV) delete process.env[key];
		router.reload();
	});

	it("adds OpenAI to the chat chain without displacing Gemini", () => {
		const chain = router.candidatesFor("chat").map((e) => e.id);
		expect(chain).toContain("openai");
		expect(chain.indexOf("gemini")).toBeLessThan(chain.indexOf("openai"));
	});

	it("leaves Gemini-format tool calling to Gemini", () => {
		// OpenAI declares no `tools` model, so raw() still finds Gemini even
		// when OpenAI sorts first.
		process.env.OPENAI_PRIORITY = "-5";
		router.reload();
		expect(router.candidatesFor("tools").map((e) => e.id)).toEqual(["gemini"]);
	});

	it("keeps speech on Gemini", () => {
		expect(router.candidatesFor("tts").map((e) => e.id)).toEqual(["gemini"]);
	});

	it("does not offer OpenAI for a task it has no model for", () => {
		expect(router.candidatesFor("vision").map((e) => e.id)).not.toContain("openai");
	});
});

describe("image generation", () => {
	const endpoint = {
		id: "openai",
		tier: "frontier",
		baseUrl: "https://api.openai.com/v1",
		apiKey: "sk-test",
		models: { image: "gpt-image-1" },
		timeoutMs: 30000,
	};

	it("posts to /images/generations and returns base64 images", async () => {
		global.fetch.mockResolvedValue(
			apiResponse({ data: [{ b64_json: "aGVsbG8=", revised_prompt: "a cat, detailed" }] })
		);

		const result = await openaiAdapter.image(endpoint, "a cat");

		const [url, init] = global.fetch.mock.calls[0];
		expect(url).toBe("https://api.openai.com/v1/images/generations");
		expect(init.headers.Authorization).toBe("Bearer sk-test");
		const body = JSON.parse(init.body);
		expect(body).toMatchObject({ model: "gpt-image-1", prompt: "a cat", n: 1 });
		expect(result.images[0]).toEqual({
			b64: "aGVsbG8=",
			mimeType: "image/png",
			revisedPrompt: "a cat, detailed",
		});
	});

	it("never sends response_format", async () => {
		// GPT image models reject it outright rather than ignoring it.
		global.fetch.mockResolvedValue(apiResponse({ data: [{ b64_json: "x" }] }));
		await openaiAdapter.image(endpoint, "a cat", { size: "1024x1536", quality: "high" });
		const body = JSON.parse(global.fetch.mock.calls[0][1].body);
		expect(body).not.toHaveProperty("response_format");
		expect(body.size).toBe("1024x1536");
		expect(body.quality).toBe("high");
	});

	it("reports the mime type for a requested output format", async () => {
		global.fetch.mockResolvedValue(apiResponse({ data: [{ b64_json: "x" }] }));
		const result = await openaiAdapter.image(endpoint, "a cat", { outputFormat: "webp" });
		expect(JSON.parse(global.fetch.mock.calls[0][1].body).output_format).toBe("webp");
		expect(result.images[0].mimeType).toBe("image/webp");
	});

	it("falls back to a URL when a DALL-E model returns one", async () => {
		global.fetch.mockResolvedValue(
			apiResponse({ data: [{ url: "https://oai.test/img.png" }] })
		);
		const result = await openaiAdapter.image(endpoint, "a cat");
		expect(result.images[0]).toEqual({
			url: "https://oai.test/img.png",
			revisedPrompt: null,
		});
	});

	it("clamps how many images one call can request", async () => {
		global.fetch.mockResolvedValue(apiResponse({ data: [{ b64_json: "x" }] }));
		await openaiAdapter.image(endpoint, "a cat", { n: 99 });
		expect(JSON.parse(global.fetch.mock.calls[0][1].body).n).toBe(4);
	});

	it("runs the access guard before dispatching", async () => {
		mockAssertAccess.mockRejectedValue(
			Object.assign(new Error("Guardian access or owner approval required"), { status: 403 })
		);
		await expect(openaiAdapter.image(endpoint, "a cat")).rejects.toThrow(
			/Guardian access/
		);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("resolves the key from Secret Manager when none is inline", async () => {
		mockGetSecret.mockResolvedValue("sk-rotated");
		global.fetch.mockResolvedValue(apiResponse({ data: [{ b64_json: "x" }] }));

		await openaiAdapter.image(
			{ ...endpoint, apiKey: "", apiKeySecret: "OPENAI_API_KEY" },
			"a cat"
		);
		expect(mockGetSecret).toHaveBeenCalledWith("OPENAI_API_KEY");
		expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-rotated");
	});

	it("raises when the provider returns no image data", async () => {
		global.fetch.mockResolvedValue(apiResponse({ data: [] }));
		await expect(openaiAdapter.image(endpoint, "a cat")).rejects.toThrow(/no image data/);
	});

	it("raises when the endpoint declares no image model", async () => {
		await expect(
			openaiAdapter.image({ ...endpoint, models: {} }, "a cat")
		).rejects.toThrow(/no image model/);
	});
});

describe("router.image", () => {
	afterEach(() => {
		for (const key of OPENAI_ENV) delete process.env[key];
		router.reload();
	});

	it("dispatches to the configured image endpoint", async () => {
		process.env.OPENAI_API_KEY = "sk-test";
		router.reload();
		global.fetch.mockResolvedValue(apiResponse({ data: [{ b64_json: "aGk=" }] }));

		const result = await router.image("a lighthouse at dusk");
		expect(result.endpointId).toBe("openai");
		expect(result.model).toBe("gpt-image-1");
		expect(result.images).toHaveLength(1);
	});

	it("raises NoModelAvailableError with no attempts when unconfigured", async () => {
		router.reload();
		const err = await router.image("a lighthouse").catch((e) => e);
		expect(err).toBeInstanceOf(router.NoModelAvailableError);
		// An empty attempts list is what the controller reads as "not
		// configured" rather than "the provider is down".
		expect(err.attempts).toEqual([]);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("requires a prompt", async () => {
		await expect(router.image("   ")).rejects.toThrow(/requires a prompt/);
	});

	it("records the call as task \"image\"", async () => {
		process.env.OPENAI_API_KEY = "sk-test";
		router.reload();
		global.fetch.mockResolvedValue(apiResponse({ data: [{ b64_json: "aGk=" }] }));

		await router.image("a lighthouse");
		const recent = router.status().recentCalls;
		expect(recent.some((c) => c.task === "image" && c.outcome === "ok")).toBe(true);
	});
});
