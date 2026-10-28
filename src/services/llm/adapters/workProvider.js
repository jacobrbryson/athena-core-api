// Client-funded work only. No global key resolution or fallback is possible here.
const { assertModelAccess } = require("../../../security/access");
async function generate({ provider, model, apiKey, prompt, maxTokens = 3000 }) {
  await assertModelAccess();
  if (!apiKey || !["openai", "anthropic"].includes(provider))
    throw new Error("A company provider key is required.");
  if (provider === "openai")
    return require("./openaiCompat").generate(
      {
        id: "company-work",
        apiKey,
        baseUrl: "https://api.openai.com/v1",
        timeoutMs: 90000,
        models: { work: model },
        supportsJsonSchema: false,
      },
      {
        task: "work",
        contents: prompt,
        json: true,
        maxOutputTokens: maxTokens,
      },
    );
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(90000),
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system:
        require("../../../security/mission").CORE_MISSION +
        "\nReturn only one JSON object.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok)
    throw Object.assign(
      new Error(`Company Anthropic request returned HTTP ${response.status}.`),
      { status: 502 },
    );
  const data = await response.json();
  return {
    text: (data.content || [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join(""),
    model: data.model,
    usage: data.usage || null,
  };
}
module.exports = { generate };
