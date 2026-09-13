const llm = require("../services/llm");

/**
 * Image generation.
 *
 * Costs real money per call and is a token-consuming provider path, so it is
 * doubly gated: the access boundary middleware has already required Guardian
 * access or an owner grant before this runs, and the adapter re-checks with
 * assertModelAccess() at dispatch. This controller adds no authorization of
 * its own — it validates input and formats the reply.
 */

const MAX_PROMPT_LENGTH = 4000;
// The sizes the current image models accept. Anything else is rejected here
// rather than spending a request to have the provider reject it.
const SIZES = new Set(["auto", "1024x1024", "1536x1024", "1024x1536"]);
const QUALITIES = new Set(["auto", "low", "medium", "high", "xhigh", "max"]);
const FORMATS = new Set(["png", "jpeg", "webp"]);

function bad(res, message) {
	return res.status(400).json({ success: false, message });
}

async function generateImage(req, res) {
	const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
	if (!prompt) return bad(res, "An image prompt is required");
	if (prompt.length > MAX_PROMPT_LENGTH) {
		return bad(res, `Prompt must be ${MAX_PROMPT_LENGTH} characters or fewer`);
	}

	const { size, quality, output_format: outputFormat } = req.body || {};
	if (size && !SIZES.has(size)) {
		return bad(res, `size must be one of: ${[...SIZES].join(", ")}`);
	}
	if (quality && !QUALITIES.has(quality)) {
		return bad(res, `quality must be one of: ${[...QUALITIES].join(", ")}`);
	}
	if (outputFormat && !FORMATS.has(outputFormat)) {
		return bad(res, `output_format must be one of: ${[...FORMATS].join(", ")}`);
	}

	try {
		const result = await llm.image(prompt, { size, quality, outputFormat });
		res.set("Cache-Control", "no-store");
		return res.json({
			success: true,
			model: result.model,
			endpoint: result.endpointId,
			images: result.images,
		});
	} catch (err) {
		// No configured provider can draw — that is a setup problem, not an
		// outage, so say which rather than returning a bare 502.
		if (err instanceof llm.NoModelAvailableError && !err.attempts?.length) {
			console.warn("[image] no image-capable model is configured");
			return res.status(503).json({
				success: false,
				message: "Image generation is not configured on this server",
			});
		}
		console.error("[image] generation failed:", err.message);
		return res.status(502).json({
			success: false,
			message: "Image generation is temporarily unavailable",
		});
	}
}

module.exports = { generateImage, MAX_PROMPT_LENGTH, SIZES, QUALITIES, FORMATS };
