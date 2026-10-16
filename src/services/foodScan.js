const llm = require("./llm");
const healthPlan = require("./healthPlan");

/**
 * Log food from a camera: a barcode or a plate.
 *
 * A barcode (read on the phone, or failing that by the vision model from the
 * photo, and only trusted when its check digit holds) is looked up on Open
 * Food Facts and one serving is logged. A food without one is estimated by
 * the "vision" task. Either way the entry is stored straight away and marked
 * with where it came from, so the Today list can say "check this" and the
 * person can correct or remove it. The photo itself is never stored.
 */

const MAX_IMAGE_BASE64 = 6 * 1024 * 1024;
const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const OFF_URL = "https://world.openfoodfacts.org/api/v2/product";
const OFF_FIELDS = "product_name,brands,serving_size,serving_quantity,nutriments";

function badRequest(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

/** EAN-8, UPC-A, EAN-13 or GTIN-14 with a valid check digit. */
function validBarcode(code) {
	const digits = String(code || "").replace(/\D/g, "");
	if (![8, 12, 13, 14].includes(digits.length)) return null;
	const body = digits.slice(0, -1).split("").reverse().map(Number);
	const sum = body.reduce((n, d, i) => n + d * (i % 2 === 0 ? 3 : 1), 0);
	return (10 - (sum % 10)) % 10 === Number(digits.at(-1)) ? digits : null;
}

/** Keep a model's or a database's number inside what an entry accepts; null when absent. */
function clamp(field, value) {
	const n = Number(value);
	if (value === null || value === undefined || value === "" || !Number.isFinite(n) || n < 0) return null;
	const [, max] = healthPlan.ENTRY[field];
	return Math.round(Math.min(n, max) * 10) / 10;
}

/**
 * One serving of a packaged food from Open Food Facts, or null when the code
 * isn't there or has no nutrition. Per-serving numbers when the label has
 * them, else per-100 g scaled to the serving size, else per 100 g.
 */
async function lookupBarcode(code) {
	let res;
	try {
		res = await fetch(`${OFF_URL}/${code}.json?fields=${OFF_FIELDS}`, {
			headers: { "User-Agent": "Athena-Companion/1.0 (nutrition log)" },
			signal: AbortSignal.timeout(8000),
		});
	} catch (err) {
		console.warn("[foodScan] barcode lookup failed:", err.message);
		return null;
	}
	if (!res.ok) return null;
	const body = await res.json().catch(() => null);
	const p = body?.status === 1 ? body.product : null;
	if (!p) return null;
	const n = p.nutriments || {};
	const grams = Number(p.serving_quantity);
	const per = (key) => {
		if (n[`${key}_serving`] != null) return Number(n[`${key}_serving`]);
		if (n[`${key}_100g`] == null) return null;
		return Number(n[`${key}_100g`]) * (grams > 0 ? grams / 100 : 1);
	};
	const hasServing = n["energy-kcal_serving"] != null || grams > 0;
	const food = {
		calories: per("energy-kcal"), protein_g: per("proteins"), carbs_g: per("carbohydrates"), fat_g: per("fat"),
	};
	if (Object.values(food).every((v) => v == null || Number.isNaN(v))) return null;
	const name = [p.brands?.split(",")[0]?.trim(), p.product_name?.trim()].filter(Boolean).join(" ") || `Barcode ${code}`;
	return {
		label: name.slice(0, 120),
		serving: (hasServing ? p.serving_size || (grams > 0 ? `${grams} g` : "1 serving") : "100 g").slice(0, 60),
		calories: clamp("calories", food.calories) == null ? null : Math.round(clamp("calories", food.calories)),
		protein_g: clamp("protein_g", food.protein_g), carbs_g: clamp("carbs_g", food.carbs_g), fat_g: clamp("fat_g", food.fat_g),
	};
}

const MACROS = ["calories", "protein_g", "carbs_g", "fat_g"];

/**
 * Every field is required: under a response schema Gemini treats an
 * unrequired field as optional and drops the numbers (see DESCRIBE_SCHEMA).
 * A barcode or "none" reply fills the rest with 0 and "", which is ignored.
 */
const SCAN_SCHEMA = {
	type: "object",
	properties: {
		kind: { type: "string", enum: ["barcode", "food", "none"] },
		barcode: { type: "string" },
		label: { type: "string" },
		calories: { type: "number" },
		protein_g: { type: "number" },
		carbs_g: { type: "number" },
		fat_g: { type: "number" },
		serving: { type: "string" },
		note: { type: "string" },
	},
	required: ["kind", "barcode", "label", ...MACROS, "serving"],
};

/** A food reply must carry at least one number; one without is a miss, not a food. */
const withoutNumbers = (d) => d.kind === "food" && MACROS.every((f) => clamp(f, d[f]) == null);

function checkScanned(d) {
	if (!["barcode", "food", "none"].includes(d?.kind)) return "missing kind";
	return withoutNumbers(d) ? "food without numbers" : null;
}

/** Ask the vision model what is in the photo: a barcode's digits, or an estimate of the food. */
async function readPhoto({ imageBase64, mimeType, hint }) {
	const prompt = `This photo was taken to log food in a nutrition diary.
- If a product barcode is the main subject and its printed digits are legible, return kind "barcode" and the digits only in "barcode".
- Otherwise, if there is food or drink, return kind "food" with:
  label: a short name (2-6 words), e.g. "Chicken rice bowl";
  calories, protein_g, carbs_g, fat_g: numbers, your best estimate for the whole portion shown — always give all four. If a nutrition facts label is visible, use its per-serving numbers instead and say so in note;
  serving: the portion you see, short, e.g. "1 bowl (~450 g)";
  note: one short sentence on what you assumed.
- If there is no food, drink or barcode, return kind "none".
Fields that don't apply to the kind you return get 0 for numbers and "" for text.
${hint ? `The person said: "${String(hint).slice(0, 200)}"` : ""}
Return ONLY JSON matching: ${JSON.stringify(SCAN_SCHEMA)}`;
	const { data } = await llm.generateJson({
		task: "vision",
		audience: "adult",
		schema: SCAN_SCHEMA,
		contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBase64 } }] }],
		check: checkScanned,
	});
	return data;
}

/**
 * Log what's in a photo. body: { imageBase64?, mimeType?, barcode?, hint?, eaten_on? }
 * — a barcode the phone already read needs no image. Returns the stored entry
 * plus how it was found.
 */
async function scan(profileId, body = {}) {
	const { imageBase64, mimeType } = body;
	const hasImage = typeof imageBase64 === "string" && imageBase64.length >= 100;
	if (hasImage && imageBase64.length > MAX_IMAGE_BASE64) throw badRequest("Image is too large — downscale to about 1024px first");
	if (hasImage && !MIME_TYPES.has(mimeType)) throw badRequest("Image must be JPEG, PNG, or WebP");
	// A misread code from the phone is dropped when there's a photo to look at instead.
	let code = body.barcode ? validBarcode(body.barcode) : null;
	if (body.barcode && !code && !hasImage) throw badRequest("That barcode doesn't look right.");
	if (!code && !hasImage) throw badRequest("Take a photo of the food or its barcode.");

	let read = null;
	if (!code) {
		read = await readPhoto({ imageBase64, mimeType, hint: body.hint });
		if (read.kind === "barcode") code = validBarcode(read.barcode);
	}
	const log = (food, how) => healthPlan.addEntry(profileId, { ...food, eaten_on: body.eaten_on, source: how }).then((entry) => ({ entry, how }));

	if (code) {
		const product = await lookupBarcode(code);
		if (product) return { ...(await log({ ...product, barcode: code }, "barcode")), note: `Found ${product.label} — logged one serving (${product.serving}).` };
		// Not in the database: if there's a photo, estimate from it (a visible label is read).
		if (!hasImage) throw badRequest(`Barcode ${code} isn't in the food database. Take a photo of the food or its label instead.`, 404);
		if (!read || read.kind === "barcode") read = await readPhoto({ imageBase64, mimeType, hint: `${body.hint || ""} The barcode ${code} wasn't found in the food database; estimate from the package, and read its nutrition label if visible.`.trim() });
	}
	if (read?.kind !== "food") throw badRequest("Couldn't make out a food or a barcode in that photo. Try again closer, or enter it by hand.", 422);
	const food = {
		label: String(read.label || "").trim().slice(0, 120) || "Food from a photo",
		serving: typeof read.serving === "string" ? read.serving.slice(0, 60) : null,
		calories: clamp("calories", read.calories) == null ? null : Math.round(clamp("calories", read.calories)),
		protein_g: clamp("protein_g", read.protein_g), carbs_g: clamp("carbs_g", read.carbs_g), fat_g: clamp("fat_g", read.fat_g),
		barcode: code,
	};
	if (["calories", "protein_g", "carbs_g", "fat_g"].every((f) => food[f] == null)) throw badRequest("Athena couldn't estimate that one. Enter it by hand.", 422);
	return { ...(await log(food, "photo")), note: read.note ? `Estimated from your photo: ${String(read.note).slice(0, 200)}` : "Estimated from your photo — check the numbers." };
}

const SEARCH_TIMEOUT_MS = 12000;

/**
 * The numbers are required here: under a response schema Gemini treats an
 * unrequired field as optional and was returning a label and a serving with no
 * numbers at all ("6oz of New York Strip Steak", 2026-10-16). The numbers come
 * before the serving, which it otherwise filled with a paragraph.
 */
const DESCRIBE_SCHEMA = {
	type: "object",
	properties: {
		kind: { type: "string", enum: ["food", "none"] },
		label: { type: "string" },
		calories: { type: "number" },
		protein_g: { type: "number" },
		carbs_g: { type: "number" },
		fat_g: { type: "number" },
		serving: { type: "string" },
		note: { type: "string" },
	},
	required: ["kind", "label", ...MACROS, "serving"],
};

function checkDescribed(d) {
	if (!["food", "none"].includes(d?.kind)) return "kind must be food or none";
	return withoutNumbers(d) ? "food without numbers" : null;
}

/** A Google-grounded search for the food's published nutrition; null when it fails or runs long. */
async function searchNutrition(text) {
	let timer;
	try {
		const out = await Promise.race([
			llm.search(`Nutrition facts for one serving of: ${text}. Give calories, protein, carbohydrates and fat in grams, the serving size, and whose figures they are (the restaurant or brand's own published nutrition if it exists).`, { audience: "adult" }),
			new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), SEARCH_TIMEOUT_MS); }),
		]);
		return out?.text ? String(out.text).slice(0, 4000) : null;
	} catch (err) {
		console.warn("[foodScan] nutrition search failed:", err.message);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Log a food from a few words ("Big Mac from McDonald's"). body: { text, eaten_on? }
 *
 * The published numbers are looked up on the web first, so a restaurant or
 * branded item gets its real figures; a model then reads one serving's
 * macros out of that (or, with no search result, estimates them and says so).
 * Logged straight away like a scan, marked "described", for the person to check.
 */
async function describe(profileId, body = {}) {
	const text = typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim().slice(0, 200) : "";
	if (text.length < 2) throw badRequest("Tell Athena what you ate.");
	const found = await searchNutrition(text);
	const prompt = `A person is logging food in a nutrition diary. They said they ate: "${text}"
${found ? `A web search for its nutrition returned:
"""
${found}
"""
Use those published figures where they match what was eaten; scale them if the person gave a different amount (e.g. "two", "large").` : "No web search result is available; estimate from typical values."}
If it names food or drink, return kind "food" with:
  label: a short name (2-6 words), with the restaurant or brand when given, e.g. "McDonald's Big Mac";
  calories, protein_g, carbs_g, fat_g: numbers for the whole amount eaten — always give all four, estimating from typical values if nothing published matches;
  serving: the amount eaten, short, e.g. "1 sandwich (219 g)";
  note: one short sentence on where the numbers came from (e.g. "McDonald's published nutrition") or what you assumed.
If it isn't food or drink, return kind "none" (with 0 for the numbers and "" for the text).
Return ONLY JSON matching: ${JSON.stringify(DESCRIBE_SCHEMA)}`;
	const { data: read } = await llm.generateJson({
		task: "json",
		audience: "adult",
		schema: DESCRIBE_SCHEMA,
		contents: [{ role: "user", parts: [{ text: prompt }] }],
		check: checkDescribed,
	});
	if (read?.kind !== "food") throw badRequest("Athena couldn't tell what food that was. Try naming it another way, or enter it by hand.", 422);
	const food = {
		label: String(read.label || "").trim().slice(0, 120) || text.slice(0, 120),
		serving: typeof read.serving === "string" ? read.serving.slice(0, 60) : null,
		calories: clamp("calories", read.calories) == null ? null : Math.round(clamp("calories", read.calories)),
		protein_g: clamp("protein_g", read.protein_g), carbs_g: clamp("carbs_g", read.carbs_g), fat_g: clamp("fat_g", read.fat_g),
	};
	if (["calories", "protein_g", "carbs_g", "fat_g"].every((f) => food[f] == null)) throw badRequest("Athena couldn't find numbers for that one. Enter it by hand.", 422);
	const entry = await healthPlan.addEntry(profileId, { ...food, eaten_on: body.eaten_on, source: "described" });
	const why = read.note ? String(read.note).slice(0, 200) : found ? "Looked up on the web." : "Estimated — no published numbers found.";
	return { entry, how: "described", note: `Logged ${food.label}${food.serving ? ` (${food.serving})` : ""}. ${why}` };
}

module.exports = { scan, describe, lookupBarcode, validBarcode, _test: { clamp, readPhoto } };
