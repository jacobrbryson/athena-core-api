/**
 * The Gemini request shape. The prompt builder returns a Content array whose
 * `system` entry must become a real system instruction (Gemini rejects a
 * "system" role in contents) — the fix for ~10% unparseable chat replies —
 * while CORE_MISSION stays in front of it and access is still checked.
 */
const mockGenerateContent = jest.fn();
jest.mock("@google/genai", () => ({
	GoogleGenAI: jest.fn().mockImplementation(() => ({ models: { generateContent: mockGenerateContent } })),
}));
const mockAssertAccess = jest.fn().mockResolvedValue(undefined);
jest.mock("../../security/access", () => ({ assertModelAccess: mockAssertAccess, context: { getStore: () => null } }));

const { CORE_MISSION } = require("../../security/mission");
const gemini = require("./adapters/gemini");

const endpoint = { id: "gemini", tier: "frontier", models: { chat: "gemini-3.5-flash-lite" } };
const schema = { type: "object", properties: { response: { type: "string" } }, required: ["response"] };

beforeEach(() => {
	mockGenerateContent.mockReset();
	mockGenerateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }] });
	mockAssertAccess.mockClear();
});

test("the system entry becomes a system instruction, led by CORE_MISSION", async () => {
	await gemini.generate(endpoint, {
		task: "chat",
		contents: [
			{ role: "system", parts: [{ text: "You are Athena." }] },
			{ role: "user", parts: [{ text: "hi" }] },
		],
	});
	const call = mockGenerateContent.mock.calls[0][0];
	expect(call.config.systemInstruction).toBe(`${CORE_MISSION}\n\nYou are Athena.`);
	// No "system" role may reach contents — Gemini only accepts user/model.
	expect(call.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
	expect(mockAssertAccess).toHaveBeenCalledTimes(1);
});

test("a caller schema is sent as structured output", async () => {
	await gemini.generate(endpoint, { task: "chat", contents: "PROMPT", json: true, schema });
	const call = mockGenerateContent.mock.calls[0][0];
	expect(call.config.responseSchema).toBe(schema);
	expect(call.config.responseMimeType).toBe("application/json");
});

test("a string prompt still becomes one user turn, with CORE_MISSION alone", async () => {
	await gemini.generate(endpoint, { task: "chat", contents: "PROMPT" });
	const call = mockGenerateContent.mock.calls[0][0];
	expect(call.contents).toEqual([{ role: "user", parts: [{ text: "PROMPT" }] }]);
	expect(call.config.systemInstruction).toBe(CORE_MISSION);
	expect(call.config.responseSchema).toBeUndefined();
});

test("thought parts are excluded and finishReason is reported", async () => {
	mockGenerateContent.mockResolvedValue({
		candidates: [{ content: { parts: [{ text: "thinking...", thought: true }, { text: '{"a":1}' }] }, finishReason: "MAX_TOKENS" }],
	});
	const out = await gemini.generate(endpoint, { task: "chat", contents: "x" });
	expect(out.text).toBe('{"a":1}');
	expect(out.finishReason).toBe("MAX_TOKENS");
});
