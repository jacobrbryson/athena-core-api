/**
 * Tolerant JSON parsing for model output.
 *
 * Models occasionally wrap JSON in prose or markdown fences, and — when a
 * prompt itself contains escaped JSON — echo that escaping back:
 *
 *   {\"response\": \"hi\", \"action\": \"NO_CHANGE\"}
 *
 * That was the cause of ~10% of chat replies failing validation (fixed at the
 * source by sending Gemini a real system instruction + response schema). This
 * salvage layer stays as defense in depth: a reply that can be recovered is
 * worth more than a dropped turn, and small local models need it too.
 *
 * Returns the parsed value, or null when nothing usable can be recovered.
 */

function stripFence(text) {
	const fenced = text.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
	return fenced ? fenced[1] : text;
}

/** The outermost balanced {...} or [...] block, ignoring braces inside strings. */
function extractBlock(text) {
	const start = text.search(/[[{]/);
	if (start === -1) return null;
	const open = text[start];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === open) depth++;
		else if (ch === close && --depth === 0) return text.slice(start, i + 1);
	}
	return null;
}

/**
 * Undo one level of string escaping: \" -> ", \n -> newline. Only applied when
 * the text looks like escaped JSON (no bare quoted keys anywhere), so genuine
 * escapes inside real JSON strings are left alone.
 */
function unescapeOnce(text) {
	if (!/\\"/.test(text) || /"[A-Za-z_][\w]*"\s*:/.test(text)) return null;
	return text
		.replace(/\\r\\n|\\n/g, "\n")
		.replace(/\\t/g, "\t")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
}

function attempt(text) {
	if (typeof text !== "string" || !text.trim()) return { ok: false };
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

/** Parse model output into a value, repairing the common malformations. */
function parseModelJson(text) {
	if (typeof text !== "string") return null;
	const candidates = [];
	const stripped = stripFence(text).trim();
	candidates.push(stripped);

	const unescaped = unescapeOnce(stripped);
	if (unescaped) candidates.push(unescaped.trim());

	for (const candidate of [...candidates]) {
		const block = extractBlock(candidate);
		if (block && block !== candidate) candidates.push(block);
	}

	for (const candidate of candidates) {
		const result = attempt(candidate);
		if (result.ok && result.value && typeof result.value === "object") return result.value;
	}
	return null;
}

module.exports = { parseModelJson, extractBlock, stripFence };
