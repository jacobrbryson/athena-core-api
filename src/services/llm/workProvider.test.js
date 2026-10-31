jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("./adapters/openaiCompat", () => ({ generate: jest.fn() }));
const access = require("../../security/access");
const openai = require("./adapters/openaiCompat");
const provider = require("./adapters/workProvider");
const originalFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
  access.assertModelAccess.mockResolvedValue();
});
afterAll(() => {
  global.fetch = originalFetch;
});
test("denied live access prevents either company provider dispatch", async () => {
  access.assertModelAccess.mockRejectedValue(new Error("revoked"));
  await expect(
    provider.generate({
      provider: "openai",
      model: "chosen",
      apiKey: "company-key",
      prompt: "source",
    }),
  ).rejects.toThrow("revoked");
  expect(openai.generate).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
});
test("OpenAI gets only the explicitly supplied company key and an output ceiling", async () => {
  openai.generate.mockResolvedValue({
    text: "{}",
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
  await provider.generate({
    provider: "openai",
    model: "chosen",
    apiKey: "company-key",
    prompt: "source",
  });
  expect(openai.generate).toHaveBeenCalledWith(
    expect.objectContaining({
      apiKey: "company-key",
      baseUrl: "https://api.openai.com/v1",
    }),
    expect.objectContaining({ maxOutputTokens: 3000 }),
  );
  expect(global.fetch).not.toHaveBeenCalled();
});
test("Anthropic uses its native guarded API and preserves reported usage", async () => {
  const usage = { input_tokens: 10, output_tokens: 20 };
  global.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [{ type: "text", text: "{}" }],
      usage,
      model: "chosen",
    }),
  });
  expect(
    await provider.generate({
      provider: "anthropic",
      model: "chosen",
      apiKey: "company-key",
      prompt: "source",
    }),
  ).toEqual({ text: "{}", model: "chosen", usage, stopReason: null });
  expect(global.fetch).toHaveBeenCalledWith(
    "https://api.anthropic.com/v1/messages",
    expect.objectContaining({
      redirect: "error",
      headers: expect.objectContaining({ "x-api-key": "company-key" }),
    }),
  );
  expect(openai.generate).not.toHaveBeenCalled();
});
test("Anthropic reports why a response stopped, so an empty one can be explained", async () => {
  global.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [{ type: "thinking", thinking: "" }],
      stop_reason: "max_tokens",
    }),
  });
  await expect(
    provider.generate({
      provider: "anthropic",
      model: "chosen",
      apiKey: "company-key",
      prompt: "source",
    }),
  ).resolves.toMatchObject({ text: "", stopReason: "max_tokens" });
});
test("provider failure cannot fall back to core keys or another vendor", async () => {
  global.fetch.mockResolvedValue({ ok: false, status: 401 });
  await expect(
    provider.generate({
      provider: "anthropic",
      model: "chosen",
      apiKey: "company-key",
      prompt: "source",
    }),
  ).rejects.toThrow("HTTP 401");
  expect(openai.generate).not.toHaveBeenCalled();
});
