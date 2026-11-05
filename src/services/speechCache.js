/**
 * Her voice for a reply, made before anyone asks for it.
 *
 * 2026-11-05 ("the Hmm… then a 7–15 second wait is tedious"): a spoken
 * reply's voice was only started once the phone had found the reply, and
 * the first part took 2–3 s more. Now, on a spoken turn, the reply's first
 * part is voiced as soon as the draft exists — while the inner monologue
 * checks it and the reply is saved — and kept here, so the client's /speech
 * for that exact text is answered from what is already made or nearly made.
 *
 * In memory, on this instance: a /speech landing on another instance just
 * makes it as before. Entries are the person's reply audio, so they live
 * briefly (TTL), are taken once, and the map is small. A failed prefetch is
 * forgotten, and /speech then makes it as usual.
 */
const geminiService = require("./gemini");

const TTL_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 40;
const MAX_TEXT = 800;

const entries = new Map(); // text -> { promise, at }

function sweep(now = Date.now()) {
	for (const [text, entry] of entries) if (now - entry.at > TTL_MS) entries.delete(text);
	while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
}

/** Start voicing this text now (once), and keep it for the /speech that will ask. */
function prefetch(text) {
	const key = typeof text === "string" ? text.trim() : "";
	if (!key || key.length > MAX_TEXT || entries.has(key)) return;
	sweep();
	const promise = geminiService.generateSpeech(key).catch((error) => {
		entries.delete(key);
		console.warn("[speech] prefetch failed:", error.message);
		return null;
	});
	entries.set(key, { promise, at: Date.now() });
}

/** The prefetched voice for this text, taken once; null when there is none (or it failed). */
async function take(text) {
	const key = typeof text === "string" ? text.trim() : "";
	const entry = entries.get(key);
	if (!entry) return null;
	entries.delete(key);
	if (Date.now() - entry.at > TTL_MS) return null;
	return entry.promise;
}

module.exports = { prefetch, take, _reset: () => entries.clear(), _size: () => entries.size, TTL_MS };
