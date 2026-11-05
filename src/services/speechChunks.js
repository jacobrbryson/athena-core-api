/**
 * The parts a reply's voice is generated in — the same split the clients
 * make (companion/src/athena/speechChunks.ts, guardians' copy, and the
 * phone's SpeechChunks.java). The server needs it to voice a reply's first
 * part before anyone asks (services/speechCache): the text it voices has to
 * be exactly the text a client will send to /speech, so this must stay in
 * step with the other three. speechChunks.test.js holds the shared cases.
 */

/** A reply this short is voiced in one go. */
const WHOLE_MAX = 60;
/** "Sure." alone is too short a part; it joins the next sentence. */
const FIRST_MIN = 30;
/** A first part longer than this is cut to its opening clause. */
const FIRST_MAX = 70;
/** Neither side of that cut is shorter than this, so no part is a word or two. */
const CLAUSE_MIN = 18;
const SECOND_MAX = 220;
const LATER_MAX = 400;
/** One /speech request allows 800 (MAX_SPEECH_TEXT_LENGTH). */
const HARD_MAX = 780;

// A period after these is not the end of a sentence.
const ABBREVIATIONS = new Set([
	"mr", "mrs", "ms", "dr", "st", "mt", "jr", "sr", "vs", "etc", "e.g", "i.e", "a.m", "p.m", "approx",
]);

/** Sentences, each keeping its own punctuation and trailing space. */
function sentences(text) {
	const out = [];
	const end = /[.!?…]+["'”’)\]]*\s+|\n+/g;
	let from = 0;
	for (let match = end.exec(text); match; match = end.exec(text)) {
		const cut = match.index + match[0].length;
		if (match[0][0] === ".") {
			const word = (/([A-Za-z.]+)$/.exec(text.slice(from, match.index))?.[1] ?? "").toLowerCase();
			// "Dr. Smith", "e.g. this", "J. R. R. Tolkien": not an ending.
			if (ABBREVIATIONS.has(word) || /^[a-z]$/i.test(word)) continue;
		}
		out.push(text.slice(from, cut));
		from = cut;
	}
	if (from < text.length) out.push(text.slice(from));
	return out.filter((sentence) => sentence.trim());
}

// Where a sentence can pause: punctuation first, then before a conjunction.
const CLAUSE_BREAK = /[,;:]\s+|\s[—–-]\s/g;
const CONJUNCTION = /\s(?=(?:and|but|so|because|which|while|or|then)\s)/gi;

/** Where to cut a long first part at its opening clause, or -1. */
function clauseCut(part) {
	for (const pause of [CLAUSE_BREAK, CONJUNCTION]) {
		pause.lastIndex = 0;
		for (let match = pause.exec(part); match; match = pause.exec(part)) {
			const cut = match.index + match[0].length;
			if (cut > FIRST_MAX) break;
			if (cut >= CLAUSE_MIN && part.length - cut >= CLAUSE_MIN) return cut;
		}
	}
	return -1;
}

/** A run-on longer than one request allows, cut at the last space that fits. */
function fit(sentence) {
	const out = [];
	let rest = sentence;
	while (rest.length > HARD_MAX) {
		const space = rest.lastIndexOf(" ", HARD_MAX);
		const cut = space > HARD_MAX / 2 ? space + 1 : HARD_MAX;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	out.push(rest);
	return out;
}

function speechChunks(text) {
	const clean = (text || "").trim();
	if (!clean) return [];
	if (clean.length <= WHOLE_MAX) return [clean];

	const parts = [];
	let current = "";
	const limit = () => (parts.length === 0 ? FIRST_MIN : parts.length === 1 ? SECOND_MAX : LATER_MAX);
	for (const sentence of sentences(clean).flatMap(fit)) {
		if (parts.length === 0) {
			// The first part closes as soon as it is long enough.
			if (current && (current + sentence).length > HARD_MAX) {
				parts.push(current);
				current = sentence;
				continue;
			}
			current += sentence;
			if (current.trim().length >= FIRST_MIN) {
				parts.push(current);
				current = "";
			}
			continue;
		}
		if (current && (current + sentence).trim().length > limit()) {
			parts.push(current);
			current = "";
		}
		current += sentence;
	}
	if (current.trim()) parts.push(current);
	const out = parts.map((part) => part.trim()).filter(Boolean);
	const cut = out[0].length > FIRST_MAX ? clauseCut(out[0]) : -1;
	if (cut > 0) out.splice(0, 1, out[0].slice(0, cut).trim(), out[0].slice(cut).trim());
	return out;
}

module.exports = { speechChunks, sentences, clauseCut };
