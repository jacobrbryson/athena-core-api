/**
 * "Updating Athena about a person" (owner, 2026-11-12).
 *
 * The Family card's Update button opens with "It's been a while since I
 * updated you about Cindy Bryson…", and an update like that is usually one
 * message. Memory extraction waited for a third turn or a "remember that",
 * so the update was read by nobody, Athena still said "I'll make a note", and
 * the card kept saying "Not updated in 5 weeks".
 *
 * Now the turn's fast guess (toolIntent, Jev) also asks whether the message is
 * news about someone in the person's life. When it is:
 *
 *   1. search — the people they have told her about (person / family / pet
 *      memories) whose name or relation the message mentions;
 *   2. decide — one match is the person; several (two Emmas, "Mom" and
 *      "Cindy") or none go back to Jev as a choice, with the last few lines
 *      of the conversation as context, and only a confident pick is taken;
 *   3. the reply is told who the update is about (or to ask, when it is
 *      still unclear), and extraction runs on this very turn with that
 *      person's memory key as its focus, so the news lands on their row and
 *      the card's "Updated …" date moves.
 *
 * Read-only here: it never writes a memory. Extraction does that, under its
 * usual rules. Adults only — a child's words never go to Jev (toolIntent).
 * Anything failing returns null and the turn goes on as before.
 */
const pool = require("../helpers/db");
const llm = require("./llm");

/** How sure the guess must be that this is news about someone. */
const UPDATE_AT = 0.6;
/** How sure the choice must be before it names one of several people. */
const PICK_AT = 0.6;
/** Beyond this many people, a choice without a name match is a guess, not a decision. */
const MAX_CHOICES = 12;
const TIMEOUT_MS = 800;

/** Relation words, each with the words people use for it. */
const RELATIONS = {
	mother: ["mother", "mom", "mum", "mama", "mommy"],
	father: ["father", "dad", "papa", "daddy"],
	wife: ["wife"],
	husband: ["husband"],
	spouse: ["spouse", "wife", "husband"],
	partner: ["partner"],
	son: ["son"],
	daughter: ["daughter"],
	sister: ["sister", "sis"],
	brother: ["brother", "bro"],
	grandmother: ["grandmother", "grandma", "nana", "granny"],
	grandfather: ["grandfather", "grandpa", "papaw", "pop"],
	aunt: ["aunt", "auntie"],
	uncle: ["uncle"],
	cousin: ["cousin"],
	niece: ["niece"],
	nephew: ["nephew"],
};
const RELATION_WORDS = new Set(Object.values(RELATIONS).flat());
const STOP = new Set(["the", "and", "my", "our", "her", "his", "their", "dog", "cat", "pet", "name"]);

const words = (s) =>
	String(s || "")
		.toLowerCase()
		.split(/[^a-z']+/)
		.map((w) => w.replace(/'s$/, "").replace(/'/g, ""))
		.filter(Boolean);

/** The name a memory gives someone: "Cindy Bryson" from "Cindy Bryson; alive but…". */
function leadName(value) {
	const head = String(value || "").split(/[;,(]|\s[—–-]\s/)[0].trim();
	const parts = head.split(/\s+/).filter((w) => /^[A-Z][a-z'’-]+$/.test(w));
	return parts.length && parts.length <= 3 && parts.length === head.split(/\s+/).length ? head : null;
}

/** One remembered person, with the words that would name them in a message. */
function personOf(row) {
	const key = String(row.memory_key || "").trim();
	const keyWords = words(key);
	const relation = Object.keys(RELATIONS).find((r) => keyWords.includes(r) || RELATIONS[r].some((w) => keyWords.includes(w))) || null;
	const lead = leadName(row.memory_value);
	const name = lead || (relation && keyWords.length === 1 ? null : key.replace(/^\w/, (c) => c.toUpperCase()));
	const names = new Set([...words(lead), ...keyWords.filter((w) => !RELATION_WORDS.has(w))].filter((w) => w.length >= 3 && !STOP.has(w)));
	return {
		uuid: row.uuid,
		key,
		category: row.category,
		name: name || key,
		relation,
		value: String(row.memory_value || ""),
		names: [...names],
		relationWords: relation ? RELATIONS[relation] : [],
	};
}

/** Everyone they have told her about. Their own rows only; children's profiles are not read. */
async function people(profileId) {
	const [rows] = await pool.query(
		`SELECT uuid, category, memory_key, memory_value FROM user_memory
		 WHERE profile_id = ? AND deleted_at IS NULL AND category IN ('person', 'family', 'pet')
		 ORDER BY updated_at DESC LIMIT 200`,
		[profileId],
	);
	// A key remembered twice (an old 'person' row beside a 'family' one) is one person.
	const seen = new Set();
	return rows.map(personOf).filter((p) => {
		const k = p.key.toLowerCase();
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

/**
 * The people a message names, best match first. A first or last name counts
 * more than a relation word ("Cindy" beats "mom"), since two people can share
 * a relation but rarely a name and a relation together.
 */
function search(message, everyone) {
	const said = new Set(words(message));
	// A name several people share — the family surname above all — can't say
	// whose news it is on its own; it only adds to a name that can.
	const count = new Map();
	for (const p of everyone) for (const n of p.names) count.set(n, (count.get(n) || 0) + 1);
	const matches = everyone
		.map((p) => {
			const hits = p.names.filter((n) => said.has(n));
			const own = hits.filter((n) => count.get(n) === 1).length;
			return {
				p,
				own,
				score: own * 2 + (hits.length - own) + (p.relationWords.some((w) => said.has(w)) ? 1 : 0),
			};
		})
		.filter((m) => m.score > 0);
	// "Cindy Bryson": the Cindy row, not every Bryson.
	const named = matches.some((m) => m.own > 0) ? matches.filter((m) => m.own > 0 || m.score > 1) : matches;
	return named.sort((a, b) => b.score - a.score);
}

const describe = (p) => `${p.name}${p.relation && p.relation !== p.name.toLowerCase() ? ` (${p.relation})` : ""} — ${p.value.slice(0, 140) || p.key}`;

/** Several (or no) matches: ask Jev which person, with the conversation as context. */
async function choose(message, candidates, recent) {
	const state = [
		...recent.map((m) => `${m.is_human ? "Person" : "Athena"}: ${String(m.text || "").replace(/\s+/g, " ").slice(0, 300)}`),
		`Person: ${message.trim().slice(0, 1500)}`,
	].join("\n");
	const criteria = Object.fromEntries(candidates.map((p, i) => [`p${i}`, describe(p)]));
	criteria.none = "Someone else, or nobody in particular";
	const result = await llm.decide({
		task: "person_update",
		state,
		questions: {
			who: {
				type: "choice",
				instructions: "In the person's last message, who are they giving Athena news or an update about?",
				criteria,
			},
		},
		timeoutMs: TIMEOUT_MS,
	});
	const answer = result.answers?.who || {};
	const pick = answer.choice;
	const p = Number(answer.probabilities?.[pick] ?? answer.confidence);
	if (!pick || pick === "none" || !Number.isFinite(p) || p < PICK_AT) return null;
	return candidates[Number(pick.slice(1))] || null;
}

/**
 * Who this message is an update about.
 *   null                                    — not an update, or nothing to go on
 *   { person, how: "named" | "chosen" }     — one person
 *   { ambiguous: [person, …] }              — several fit; she should ask
 */
async function resolve(message, { profileId, guessed, recent = [] } = {}) {
	if (!profileId || typeof message !== "string" || !message.trim()) return null;
	if (!(Number(guessed?.personUpdate) >= UPDATE_AT)) return null;
	try {
		const everyone = await people(profileId);
		if (!everyone.length) return null;
		const matches = search(message, everyone);
		const found = matches.map((m) => m.p);
		// One clear match: that is who. A name (score ≥ 2) that out-scores every
		// other match wins outright — "Cindy" over another row that only says "mom".
		const [top, next] = matches;
		if (top && (matches.length === 1 || (top.score >= 2 && top.score > next.score))) return { person: top.p, how: "named" };
		const pool = found.length ? found : everyone.length <= MAX_CHOICES ? everyone : [];
		if (!pool.length) return null;
		const picked = await choose(message, pool.slice(0, MAX_CHOICES), recent.slice(-4)).catch((err) => {
			console.warn("[personUpdate] no choice:", err.message);
			return null;
		});
		if (picked) return { person: picked, how: "chosen" };
		return found.length > 1 ? { ambiguous: found.slice(0, 4) } : null;
	} catch (err) {
		console.warn("[personUpdate] skipped:", err.message);
		return null;
	}
}

/** The reply's note: who the news is about, or that she should ask. */
function promptBlock(resolved) {
	if (!resolved) return null;
	if (resolved.person) {
		const p = resolved.person;
		return `# Update about someone
The person is bringing you up to date on ${p.name}${p.relation ? ` (their ${p.relation})` : ""}. What you remembered: "${p.value.slice(0, 300)}".
What they just told you is being saved to ${p.name}'s memory now, so you can say you'll remember it. Respond to the news itself like a friend would.`;
	}
	const names = resolved.ambiguous.map((p) => p.name).join(" or ");
	return `# Update about someone
The person is giving you news about someone, but it could be ${names}. Ask briefly which one they mean before treating it as settled, and don't say you've saved it yet.`;
}

/** What extraction should aim the update at. */
const focusOf = (resolved) =>
	resolved?.person
		? { key: resolved.person.key, category: resolved.person.category, name: resolved.person.name, value: resolved.person.value }
		: null;

module.exports = { resolve, promptBlock, focusOf, search, personOf, leadName, UPDATE_AT, PICK_AT };
