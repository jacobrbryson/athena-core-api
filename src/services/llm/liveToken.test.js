jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));

const { assertModelAccess } = require("../../security/access");
const gemini = require("./adapters/gemini");

const create = jest.fn();
beforeEach(() => {
	jest.clearAllMocks();
	gemini._setLiveClient({ authTokens: { create } });
	create.mockResolvedValue({ name: "auth_tokens/xyz" });
});

test("checks access before asking Google for a token", async () => {
	assertModelAccess.mockRejectedValue(Object.assign(new Error("denied"), { status: 403 }));
	await expect(gemini.liveToken({ model: "m", config: {} })).rejects.toMatchObject({ status: 403 });
	expect(create).not.toHaveBeenCalled();
});

test("a one-use token, locked to the model and config it was given", async () => {
	assertModelAccess.mockResolvedValue();
	const config = { responseModalities: ["AUDIO"], systemInstruction: { parts: [{ text: "hi" }] } };
	const out = await gemini.liveToken({ model: "gemini-3.8-live", config });
	expect(out.token).toBe("auth_tokens/xyz");
	const sent = create.mock.calls[0][0].config;
	expect(sent.uses).toBe(1);
	expect(sent.liveConnectConstraints).toEqual({ model: "gemini-3.8-live", config });
	// Unset = every field locked; the page's setup can't override any of it.
	expect(sent).not.toHaveProperty("lockAdditionalFields");
	expect(Date.parse(sent.newSessionExpireTime) - Date.now()).toBeLessThanOrEqual(60_000);
});
