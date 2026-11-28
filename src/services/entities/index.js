/**
 * "Who do you mean" (owner, 2026-11-28; Collections design, phase 1).
 *
 * One lookup in code turns "Mom", "uncle Mark", "Skylar" into a person on the
 * Family roster — the same key the person pages use: a user_memory uuid, or
 * child:<child_profiles.uuid>. No model decides who someone is: the weights
 * below are constants, and an answer the person confirmed is stored in
 * athena_entity_alias and wins from then on.
 *
 *   resolve(profileId, "my uncle Mark")
 *     -> { person }                 one clear winner
 *     -> { ambiguous: [p, p, …] }   two or more fit; ask which
 *     -> { none: true }             nobody fits
 *
 * Candidates: person / family / pet memories (as services/personUpdate reads
 * them) and the children on the family's profiles. Every query is the
 * caller's own rows.
 */
const pool = require("../../helpers/db");
const family = require("../family");
const { personOf } = require("../personUpdate");

/** Evidence weights. Bounded and visible on purpose: see the design doc. */
const WEIGHT = {
	confirmed: 100, // the person told her who this is
	fullName: 12, // the whole name as written ("Skylar Bryson")
	ownName: 6, // a name only this person has ("Skylar")
	sharedName: 2, // a name several share (the family surname)
	relation: 4, // "mom", "my uncle"
	recent: 2, // named in the last few lines of this conversation
};
/** A winner must score at least this… */
const WIN_AT = 6;
/** …and lead the next candidate by this much, or she asks. */
const LEAD_BY = 4;

const words = (s) =>
	String(s || "")
		.toLowerCase()
		.split(/[^a-z']+/)
		.map((w) => w.replace(/'s$/, "").replace(/'/g, ""))
		.filter(Boolean);

/** An alias as stored: lowercase words, no "my"/"the". */
function aliasKey(phrase) {
	return words(phrase)
		.filter((w) => !["my", "our", "the", "a", "an"].includes(w))
		.join(" ")
		.slice(0, 120);
}

/** Everyone on the roster: { key, name, names[], relationWords[] }. */
async function people(profileId) {
	const [rows] = await pool.query(
		`SELECT uuid, category, memory_key, memory_value FROM user_memory
		 WHERE profile_id = ? AND deleted_at IS NULL AND category IN ('person', 'family', 'pet')
		 ORDER BY updated_at DESC LIMIT 200`,
		[profileId]
	);
	const seen = new Set();
	const out = [];
	for (const row of rows) {
		const p = personOf(row);
		const k = p.key.toLowerCase();
		if (seen.has(k)) continue;
		seen.add(k);
		out.push({ key: p.uuid, name: p.name, names: p.names, relationWords: p.relationWords, category: p.category });
	}
	const fam = await family.getFamilyForProfile(profileId).catch(() => null);
	const kids = fam ? await family.listChildren(fam.id).catch(() => []) : [];
	for (const kid of kids) {
		const names = words(kid.display_name).filter((w) => w.length >= 2);
		// A child already remembered by name is one person, not two: keep the memory row.
		if (out.some((p) => names.length && names.every((n) => p.names.includes(n)))) continue;
		out.push({ key: `child:${kid.uuid}`, name: kid.display_name, names, relationWords: [], category: "child" });
	}
	return out;
}

async function aliases(profileId) {
	const [rows] = await pool.query("SELECT alias, person_key FROM athena_entity_alias WHERE profile_id = ?", [profileId]);
	return rows;
}

/**
 * Score every candidate against a phrase. Pure: the caller passes who exists,
 * the confirmed aliases and the recent lines. Exported for tests.
 */
function score(phrase, everyone, confirmed = [], recent = []) {
	const said = words(phrase);
	const saidSet = new Set(said);
	const key = aliasKey(phrase);
	const count = new Map();
	for (const p of everyone) for (const n of p.names) count.set(n, (count.get(n) || 0) + 1);
	const recentWords = new Set(words((recent || []).join(" ")));
	// A relation only one person has ("mom") names them as surely as their own name.
	const related = everyone.filter((p) => p.relationWords.some((w) => saidSet.has(w)));
	return everyone
		.map((p) => {
			let s = 0;
			if (confirmed.some((a) => a.person_key === p.key && a.alias === key)) s += WEIGHT.confirmed;
			const full = words(p.name);
			if (full.length > 1 && full.every((w) => saidSet.has(w))) s += WEIGHT.fullName;
			for (const n of p.names) if (saidSet.has(n)) s += count.get(n) === 1 ? WEIGHT.ownName : WEIGHT.sharedName;
			if (related.includes(p)) s += related.length === 1 ? WEIGHT.ownName : WEIGHT.relation;
			if (s > 0 && p.names.some((n) => recentWords.has(n))) s += WEIGHT.recent;
			return { person: p, score: s };
		})
		.filter((m) => m.score > 0)
		.sort((a, b) => b.score - a.score);
}

/** The decision rule over scored matches. Exported for tests. */
function decide(matches) {
	const [first, second] = matches;
	if (!first) return { none: true };
	if (first.score >= WIN_AT && (!second || first.score - second.score >= LEAD_BY)) return { person: first.person, score: first.score };
	return { ambiguous: matches.slice(0, 4).map((m) => m.person) };
}

/** Who a phrase means, for this person. Never throws on a lookup failure: { none: true }. */
async function resolve(profileId, phrase, { recent = [] } = {}) {
	if (!profileId || !String(phrase || "").trim()) return { none: true };
	try {
		const [everyone, confirmed] = await Promise.all([people(profileId), aliases(profileId).catch(() => [])]);
		return decide(score(phrase, everyone, confirmed, recent));
	} catch (err) {
		console.warn("[entities] lookup failed:", err.message);
		return { none: true };
	}
}

/** The person a roster key names, if it is the caller's; null otherwise. */
async function byKey(profileId, key) {
	const everyone = await people(profileId);
	return everyone.find((p) => p.key === key) || null;
}

/**
 * "Uncle Mark is Mark Watson": remembered for good. The key must be one of the
 * caller's own people; a phrase that is only a stop word is ignored.
 */
async function confirm(profileId, phrase, personKey) {
	const alias = aliasKey(phrase);
	if (!alias) return false;
	if (!(await byKey(profileId, personKey))) throw Object.assign(new Error("That person isn't in your family memories."), { status: 404 });
	await pool.query(
		`INSERT INTO athena_entity_alias (profile_id, alias, person_key) VALUES (?, ?, ?)
		 ON DUPLICATE KEY UPDATE person_key = VALUES(person_key)`,
		[profileId, alias, personKey]
	);
	return true;
}

module.exports = { resolve, confirm, people, byKey, score, decide, aliasKey, WEIGHT, WIN_AT, LEAD_BY };
