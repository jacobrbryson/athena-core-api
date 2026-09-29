/**
 * The Jev adapter: the access check comes before any request leaves, a slow
 * answer becomes an error rather than a stall, and the key is sent as Bearer.
 */
const mockAssertAccess = jest.fn().mockResolvedValue();
jest.mock("../../security/access", () => ({
	assertModelAccess: mockAssertAccess,
	context: { getStore: () => null },
}));

// Env wins in getSecret; this keeps a missing env var from reaching the real
// Secret Manager.
jest.mock("../secrets", () => ({
	getSecret: jest.fn(async (name) => process.env[name] ?? null),
}));

const jev = require("./adapters/jev");

const QUESTIONS = { calendar: { type: "noul", instructions: "Needs the calendar?" } };
const savedKey = process.env.JEV_API_KEY;

beforeEach(() => {
	jest.clearAllMocks();
	mockAssertAccess.mockResolvedValue();
	process.env.JEV_API_KEY = "test-key";
	global.fetch = jest.fn();
});

afterAll(() => {
	if (savedKey === undefined) delete process.env.JEV_API_KEY;
	else process.env.JEV_API_KEY = savedKey;
});

it("refuses before sending anything when access is denied", async () => {
	mockAssertAccess.mockRejectedValue(Object.assign(new Error("denied"), { code: "ACCESS_REQUIRED" }));
	await expect(jev.decide({ state: "hi", questions: QUESTIONS })).rejects.toMatchObject({ code: "ACCESS_REQUIRED" });
	expect(global.fetch).not.toHaveBeenCalled();
});

it("posts the state and questions with the key as Bearer", async () => {
	global.fetch.mockResolvedValue({
		ok: true,
		json: async () => ({ model: "jev-1.13.0", answers: { calendar: { type: "noul", noul: 0.9 } }, usage: {} }),
	});
	const out = await jev.decide({ state: "anything tonight?", questions: QUESTIONS });
	const [url, init] = global.fetch.mock.calls[0];
	expect(url).toBe("https://api.typesafe.ai/v1/systemone");
	expect(init.headers.Authorization).toBe("Bearer test-key");
	expect(JSON.parse(init.body)).toMatchObject({ state: "anything tonight?", questions: QUESTIONS });
	expect(out.answers.calendar.noul).toBe(0.9);
});

it("turns a slow answer into a timeout error", async () => {
	global.fetch.mockImplementation((_url, { signal }) =>
		new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
		})
	);
	await expect(jev.decide({ state: "hi", questions: QUESTIONS, timeoutMs: 20 })).rejects.toThrow(/timed out after 20 ms/);
});

it("reports the provider's status on an HTTP error", async () => {
	global.fetch.mockResolvedValue({ ok: false, status: 401, text: async () => "Missing or invalid API key" });
	await expect(jev.decide({ state: "hi", questions: QUESTIONS })).rejects.toMatchObject({ status: 401 });
});

it("fails without a key", async () => {
	delete process.env.JEV_API_KEY;
	await expect(jev.decide({ state: "hi", questions: QUESTIONS })).rejects.toThrow(/JEV_API_KEY/);
	expect(global.fetch).not.toHaveBeenCalled();
});
