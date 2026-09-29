/**
 * Did the microphone just hear Athena herself?
 *
 * Hands-free listens for a follow-up the moment she stops talking. On a phone
 * speaker the tail of her own voice can land in that window, get transcribed,
 * and come back as "the person's" next message — and she answers it, and hears
 * that too. On 2026-09-29 that ran five turns in seventy seconds.
 *
 * The test is word pairs, not single words: a real follow-up reuses her words
 * ("the dentist on Thursday?") but rarely in her order, while an echo is her
 * sentence with a few words dropped or misheard. Short utterances ("yes",
 * "and tomorrow?") are never called echoes — too little to tell, and those
 * are exactly the follow-ups the window exists for.
 */

const MIN_WORDS = 4;
const SHARED_PAIRS = 0.6;

function words(text) {
	return String(text || "")
		.toLowerCase()
		.replace(/[’']/g, "")
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter(Boolean);
}

function pairs(list) {
	const out = [];
	for (let i = 0; i + 1 < list.length; i++) out.push(`${list[i]} ${list[i + 1]}`);
	return out;
}

/** True when `heard` is most likely a transcription of `spoken`. */
function isEcho(heard, spoken) {
	const h = words(heard);
	if (h.length < MIN_WORDS) return false;
	const said = new Set(pairs(words(spoken)));
	if (!said.size) return false;
	const hp = pairs(h);
	const shared = hp.filter((p) => said.has(p)).length;
	return shared / hp.length >= SHARED_PAIRS;
}

module.exports = { isEcho, words };
