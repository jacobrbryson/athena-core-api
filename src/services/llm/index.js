/**
 * Athena's model layer. Import this — not a provider SDK — for any LLM work.
 *
 *   llm.generate({ task, contents, json, schema, audience, validate })
 *   llm.generateJson({ ... })   // generate + parse, with validation-driven fallback
 *   llm.embed(texts, { purpose })
 *   llm.image(prompt, { size, quality })
 *   llm.speech(text)
 *   llm.raw(contents, config)   // Gemini function calling
 *   llm.status() / llm.manifest()
 *
 * See config.js for tiers and env vars.
 */
const router = require("./router");
const { buildManifest } = require("./manifest");
const { parseModelJson } = require("./parse");

/**
 * Generate and parse JSON. A tier that returns unparseable JSON (or fails the
 * caller's `check`) is treated as a miss and the router moves down the chain.
 * Returns { data, endpointId, tier, model }.
 */
async function generateJson({ check, ...opts }) {
	let parsed;
	const result = await router.generate({
		...opts,
		json: true,
		validate: (text) => {
			parsed = parseModelJson(text);
			if (!parsed) return "not valid JSON";
			if (check) {
				const problem = check(parsed);
				if (problem && problem !== true) return problem;
			}
			return null;
		},
	});
	return { data: parsed, endpointId: result.endpointId, tier: result.tier, model: result.model };
}

module.exports = {
	generate: router.generate,
	generateOn: router.generateOn,
	endpointsFor: router.endpointsFor,
	generateJson,
	raw: router.raw,
	embed: router.embed,
	embeddingSpace: router.embeddingSpace,
	image: router.image,
	speech: router.speech,
	status: router.status,
	servingTier: router.servingTier,
	startHealthLoop: router.startHealthLoop,
	manifest: buildManifest,
	reload: router.reload,
	NoModelAvailableError: router.NoModelAvailableError,
};
