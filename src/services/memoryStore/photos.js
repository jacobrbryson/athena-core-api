/**
 * Photo memories: "Athena, remember this."
 *
 * The image is described by the "vision" task (local vision model first,
 * frontier fallback) and ONLY the description is stored. The photo itself
 * never leaves the device beyond this one request: `media_ref` is an opaque
 * device-local handle so the app can show the original next to the memory.
 *
 * Adult profiles only — children's photos are out of scope by product
 * decision (COPPA); the route enforces it.
 */
const llm = require("../llm");
const { createEvent } = require("./events");

const MAX_IMAGE_BASE64 = 6 * 1024 * 1024; // ~4.5 MB binary; clients downscale to ~1024px first
const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const PHOTO_SCHEMA = {
	type: "object",
	properties: {
		title: { type: "string" },
		description: { type: "string" },
		setting: { type: "string" },
		objects: {
			type: "array",
			items: {
				type: "object",
				properties: { label: { type: "string" }, detail: { type: "string" } },
				required: ["label"],
			},
		},
		people_count: { type: "number" },
		visible_text: { type: "string" },
		mood: { type: "string" },
	},
	required: ["title", "description", "objects", "people_count"],
};

function validateImage({ imageBase64, mimeType }) {
	if (typeof imageBase64 !== "string" || imageBase64.length < 100) return "An image is required";
	if (imageBase64.length > MAX_IMAGE_BASE64) return "Image is too large — downscale to about 1024px first";
	if (!MIME_TYPES.has(mimeType)) return "Image must be JPEG, PNG, or WebP";
	return null;
}

async function describeImage({ imageBase64, mimeType, caption, audience = "adult" }) {
	const prompt = `Describe this photo so it can be remembered and found again later.
- title: 3-6 words.
- description: 2-4 sentences of what is actually visible — place, activity, notable things, time of day or season if evident.
- objects: the notable things in it (label + short detail).
- people_count: how many people are visible.
- Never guess who anyone is. Describe people generically ("a man in a blue jacket") unless the caption below names them.
- visible_text: any legible signs or text, else "".
${caption ? `The person said about it: "${String(caption).slice(0, 300)}"` : ""}
Return ONLY JSON matching: ${JSON.stringify(PHOTO_SCHEMA)}`;

	const { data, endpointId, tier } = await llm.generateJson({
		task: "vision",
		audience,
		schema: PHOTO_SCHEMA,
		contents: [
			{
				role: "user",
				parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBase64 } }],
			},
		],
		check: (d) =>
			typeof d?.description === "string" && d.description.trim() && Array.isArray(d.objects)
				? null
				: "missing description/objects",
	});
	return { ...data, _servedBy: { endpointId, tier } };
}

/**
 * Describe and store a photo memory. Returns the created event.
 * input: { imageBase64, mimeType, caption?, takenAt?, mediaRef?, place? }
 */
async function rememberPhoto(profileId, familyId, input) {
	const problem = validateImage(input);
	if (problem) {
		const err = new Error(problem);
		err.status = 400;
		throw err;
	}
	const d = await describeImage(input);
	const objects = (d.objects || [])
		.slice(0, 12)
		.map((o) => (o.detail ? `${o.label} (${o.detail})` : o.label))
		.join(", ");
	const content = [
		d.description,
		input.caption ? `They said: "${String(input.caption).slice(0, 300)}"` : null,
		objects ? `In it: ${objects}.` : null,
		d.visible_text ? `Text visible: ${d.visible_text}` : null,
		input.place ? `Place: ${String(input.place).slice(0, 120)}` : null,
	]
		.filter(Boolean)
		.join("\n");

	return createEvent(
		{
			profileId,
			familyId,
			kind: "photo",
			title: d.title || "A photo",
			content,
			occurredAt: input.takenAt || null,
			importance: 6,
			source: "user",
			visibility: "private",
			mediaRef: input.mediaRef || null,
			metadata: {
				setting: d.setting || null,
				objects: d.objects || [],
				people_count: d.people_count ?? null,
				mood: d.mood || null,
				place: input.place || null,
				described_by: d._servedBy,
			},
		},
		{ awaitEmbedding: true }
	);
}

module.exports = { describeImage, rememberPhoto, validateImage, PHOTO_SCHEMA };
