/**
 * Device model manifest — how Athena keeps on-device models current by herself.
 *
 * Devices (Companion web app, Unity Android build, car head unit) poll
 * GET /api/v1/llm/manifest. When `version` changes, a device:
 *   1. filters `models` to its platform + capabilities (RAM, WebGPU, NPU),
 *   2. downloads new/changed entries in the background (Wi-Fi + charging only),
 *   3. verifies sha256, swaps the model in atomically, keeps the previous one
 *      until the new one has passed a smoke prompt,
 *   4. reports what it now runs via POST /api/v1/llm/device-report.
 * Tasks listed in `routing.preferDevice` then run locally; anything else, or
 * any on-device failure, escalates to the server router (Orcwood -> frontier).
 *
 * Override the whole manifest with LLM_DEVICE_MANIFEST (JSON). Entries whose
 * `url` is unset stay disabled so devices never fetch a placeholder.
 */
const crypto = require("crypto");

function defaultModels() {
	return [
		{
			id: "gemini-nano",
			runtime: "android-aicore",
			platforms: ["android"],
			tasks: ["intent", "summarize", "chat-lite"],
			systemProvided: true,
			notes:
				"Provided by the OS on supported Android devices (ML Kit GenAI / AICore). Nothing to download; devices report availability.",
		},
		{
			id: "vision-detector",
			runtime: "unity-inference-engine",
			platforms: ["android"],
			tasks: ["vision-fast"],
			format: "onnx",
			url: process.env.DEVICE_VISION_MODEL_URL || null,
			sha256: process.env.DEVICE_VISION_MODEL_SHA256 || null,
			sizeMb: Number(process.env.DEVICE_VISION_MODEL_SIZE_MB) || null,
			minRamGb: 4,
			notes: "Real-time object detector (YOLO-family ONNX export) for the fast perception loop.",
		},
		{
			id: "web-chat-lite",
			runtime: "webllm",
			platforms: ["web"],
			tasks: ["intent", "chat-lite"],
			modelId: process.env.DEVICE_WEBLLM_MODEL_ID || null,
			url: process.env.DEVICE_WEBLLM_MODEL_ID ? "webllm://prebuilt" : null,
			minVramGb: 4,
			requires: ["webgpu"],
			notes: "In-browser model via WebLLM for instant intent detection and offline fallback.",
		},
	];
}

function buildManifest() {
	let models = defaultModels();
	if (process.env.LLM_DEVICE_MANIFEST) {
		try {
			const override = JSON.parse(process.env.LLM_DEVICE_MANIFEST);
			if (Array.isArray(override?.models)) models = override.models;
		} catch (err) {
			console.warn("[llm] LLM_DEVICE_MANIFEST is not valid JSON — using defaults:", err.message);
		}
	}

	const normalized = models.map((m) => ({
		...m,
		enabled: m.systemProvided === true || (typeof m.url === "string" && m.url.length > 0),
	}));

	const body = {
		models: normalized,
		routing: {
			// Tasks a device should try locally before calling the server.
			preferDevice: ["intent", "vision-fast"],
			// Everything else goes to the server router.
			escalate: "server",
		},
		update: {
			pollHours: 12,
			requireUnmetered: true,
			requireCharging: true,
		},
	};
	const version = crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 12);
	return { version, ...body };
}

module.exports = { buildManifest };
