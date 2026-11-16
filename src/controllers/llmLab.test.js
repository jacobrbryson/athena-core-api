/**
 * The model lab is owner-only, and its drill proves the fallback end to end
 * through the real router: Gemini "out of quota", the desktop answers, the
 * call is logged as a smoke test, and the real circuit is untouched.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn().mockResolvedValue([[]]) }));
jest.mock("../security/access", () => ({ assertModelAccess: jest.fn().mockResolvedValue() }));
const mockIsOwner = jest.fn();
jest.mock("../services/systemHealth", () => ({ isOwner: (...a) => mockIsOwner(...a) }));
jest.mock("../helpers/actor", () => ({ requireAdultActor: jest.fn(async () => ({ profileId: 7, audience: "adult" })) }));
jest.mock("./prompt", () => ({ buildAdultCompanionPrompt: () => "system", RESPONSE_SCHEMA: { type: "object" } }));
const mockGenerateContent = jest.fn();
jest.mock("@google/genai", () => ({
	GoogleGenAI: jest.fn().mockImplementation(() => ({ models: { generateContent: mockGenerateContent, embedContent: jest.fn() } })),
}));

const reply = JSON.stringify({ response: "Try a short walk.", action: "NO_CHANGE", topic_name: "", new_proficiency: -1, is_factually_true: true });

function res() {
	const r = { statusCode: 200, body: null, headers: {} };
	r.status = (c) => ((r.statusCode = c), r);
	r.json = (b) => ((r.body = b), r);
	r.set = (k, v) => ((r.headers[k] = v), r);
	return r;
}

let lab, health, telemetry;
beforeEach(() => {
	jest.resetModules();
	process.env.GEMINI_API_KEY = "k";
	process.env.LLM_POLICY = "smart";
	process.env.LLM_ORCWOOD_ENDPOINTS = JSON.stringify([{ id: "desk", baseUrl: "http://desk:11434/v1", models: { chat: "qwen2.5:7b-instruct" } }]);
	global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: reply } }] }) });
	mockGenerateContent.mockReset().mockResolvedValue({ text: reply });
	mockIsOwner.mockReset().mockResolvedValue(true);
	telemetry = require("../services/llm/telemetry");
	telemetry._disableDb();
	require("../services/llm/evalStore")._disableDb();
	require("../services/llm/router").reload();
	health = require("../services/llm/health");
	lab = require("./llmLab");
});

afterAll(() => {
	delete process.env.LLM_POLICY;
	delete process.env.LLM_ORCWOOD_ENDPOINTS;
});

test("everyone but the owner is refused", async () => {
	mockIsOwner.mockResolvedValue(false);
	for (const fn of ["overview", "stats", "preview", "drillTest", "serverDrillStart", "compare", "runEvalsNow", "ping"]) {
		const r = res();
		await lab[fn]({ query: {}, body: { scenario: "gemini-quota" } }, r);
		expect([fn, r.statusCode]).toEqual([fn, 403]);
	}
	expect(require("../services/llm/drill").describeServerDrill()).toBeNull();
});

test("a Gemini-quota drill is answered by the desktop, logged as a test, and trips nothing", async () => {
	const r = res();
	await lab.drillTest({ body: { scenario: "gemini-quota", message: "how do I unwind?" } }, r);
	expect(r.body).toMatchObject({
		passed: true,
		reply: "Try a short walk.",
		servedBy: { endpointId: "desk", tier: "orcwood", fallback: true },
		attempts: [expect.objectContaining({ endpointId: "gemini", drill: true })],
	});
	expect(r.body.wouldLose).toEqual(expect.arrayContaining(["voice", "web search"]));
	expect(mockGenerateContent).not.toHaveBeenCalled();
	expect(health.isAvailable("gemini")).toBe(true);
	expect(telemetry.recent(5).map((c) => c.task)).toEqual(["smoke:chat"]);
});

test("a drill where nothing can answer fails honestly", async () => {
	global.fetch.mockRejectedValue(new Error("ECONNREFUSED"));
	const r = res();
	await lab.drillTest({ body: { scenario: "gemini-quota" } }, r);
	expect(r.body).toMatchObject({ passed: false, servedBy: null });
	expect(r.body.error).toMatch(/No model could serve/);
});

test("the server drill starts, shows in the outage, and stops", async () => {
	const start = res();
	await lab.serverDrillStart({ body: { scenario: "gemini-quota", minutes: 5 } }, start);
	expect(start.body.outage).toMatchObject({ level: "degraded", drill: expect.objectContaining({ scenario: "gemini-quota" }) });
	const stop = res();
	await lab.serverDrillStop({}, stop);
	expect(stop.body).toMatchObject({ stopped: true, outage: { level: "ok" } });
});

test("preview explains the choice without calling a model", async () => {
	const r = res();
	await lab.preview({ query: { task: "chat", urgency: "voice", scenario: "gemini-quota" } }, r);
	expect(r.body.serving).toMatchObject({ endpointId: "desk" });
	expect(r.body.chain.find((c) => c.endpointId === "gemini")).toMatchObject({ available: false, drilled: "gemini-quota" });
	expect(global.fetch).not.toHaveBeenCalled();
	expect(mockGenerateContent).not.toHaveBeenCalled();
});

test("the side-by-side is logged as a comparison, not an eval", async () => {
	const r = res();
	await lab.compare({ body: { message: "how do I unwind?" } }, r);
	expect(r.body.results.map((x) => x.endpointId).sort()).toEqual(["desk", "gemini"]);
	expect(telemetry.recent(5).map((c) => c.task)).toEqual(["smoke:compare", "smoke:compare"]);
});

test("bad input is a 400", async () => {
	const r = res();
	await lab.drillTest({ body: { scenario: "nope" } }, r);
	expect(r.statusCode).toBe(400);
	const p = res();
	await lab.preview({ query: { task: "teleport" } }, p);
	expect(p.statusCode).toBe(400);
});
