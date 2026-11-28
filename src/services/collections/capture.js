/**
 * The reading loop for collections (design doc, "The reading loop").
 *
 * Two ways in, one rule: what Athena finds is written as a SUGGESTION, with a
 * pointer to where it came from and why — never the original text — and it
 * stays a suggestion until the person keeps it.
 *
 *   backfill(profileId, collectionId)  once, when a collection is started:
 *       reads their memories and the interests on each person's page, and
 *       suggests what fits (plus a few ideas of her own, marked as hers).
 *   fromChat(profileId, message)       after an adult's chat turn: anything
 *       the message says that belongs on an active collection.
 *
 * Adults only: the chat hook runs only on turns that may propose actions
 * (never a child's or a Guardian session), and backfill reads the owner's
 * own memories. Texts are not read here (owner, 2026-11-28: off for now).
 * A model reads; code resolves people, checks shapes, dedupes and writes.
 */
const pool = require("../../helpers/db");
const llm = require("../llm");
const collections = require("./index");

const MAX_FOUND_PER_PERSON = 5;
const MAX_IDEAS_PER_PERSON = 3;
const MAX_CHAT_CLAIMS = 5;

async function collectionById(profileId, id) {
	const [[row]] = await pool.query("SELECT uuid FROM athena_collection WHERE profile_id = ? AND id = ?", [profileId, id]);
	return row ? collections.byUuid(profileId, row.uuid) : null;
}

const clean = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);

/** Already on the list for that person (any status, removed ones too, so a removed idea isn't re-suggested). */
async function existingTitles(profileId, collectionId) {
	const [rows] = await pool.query(
		"SELECT subject_id, LOWER(title) AS t FROM athena_collection_item WHERE profile_id = ? AND collection_id = ?",
		[profileId, collectionId]
	);
	return new Set(rows.map((r) => `${r.subject_id || 0}|${r.t}`));
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

function backfillPrompt({ c, people, memories }) {
	const lines = [
		`You are filling a new list for the person you look after: "${c.name}".`,
		c.def.purpose ? `What it's for: ${c.def.purpose}` : null,
		c.def.capture ? `What belongs on it: ${c.def.capture}` : null,
		"",
		"People on the list (id: name — what you know):",
		...people.map((p) => `- ${p.id}: ${p.label}${p.about ? ` — ${p.about}` : ""}${p.interests.length ? `; interests: ${p.interests.join(", ")}` : ""}`),
		"",
		"Their memories (id: text):",
		...memories.map((m) => `- ${m.id}: ${m.text}`),
		"",
		"Return JSON { found: [...], ideas: [...] }.",
		`found: things for the list that their memories or the people's interests actually show, at most ${MAX_FOUND_PER_PERSON} per person. Each { person (an id above), title (short, concrete), reason (one short line saying what showed it), memory (the memory id it came from, or "" for an interest) }.`,
		`ideas: your own suggestions that fit what you know, at most ${MAX_IDEAS_PER_PERSON} per person. Each { person, title, reason }.`,
		"Never invent facts about anyone. Leave a person out rather than guess. Titles are things, not sentences.",
	];
	return lines.filter((l) => l !== null).join("\n");
}

function checkBackfill(data) {
	if (!data || !Array.isArray(data.found) || !Array.isArray(data.ideas)) return "needs found and ideas arrays";
	return true;
}

/**
 * Fill a just-started collection from what Athena already knows. For a
 * per-person list: per person, what their memories and page show, plus a few
 * ideas of her own. Returns how many suggestions were written.
 */
async function backfill(profileId, collectionId) {
	const c = await collectionById(profileId, collectionId);
	if (!c || !c.def.perPerson) return { written: 0 };
	const subjects = await collections.subjectsOf(profileId, c.id);
	if (!subjects.length) return { written: 0 };

	const keys = subjects.map((s) => s.personKey);
	const [interests] = await pool.query(
		"SELECT person_key, label FROM athena_person_interest WHERE profile_id = ? AND person_key IN (?) AND deleted_at IS NULL",
		[profileId, keys]
	);
	const [about] = await pool.query("SELECT person_key, about FROM athena_person WHERE profile_id = ? AND person_key IN (?)", [profileId, keys]);
	const [mem] = await pool.query(
		`SELECT uuid, category, memory_key, memory_value FROM user_memory
		 WHERE profile_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 300`,
		[profileId]
	);
	const people = subjects.map((s, i) => ({
		id: `p${i + 1}`,
		subjectId: s.id,
		label: s.label,
		about: clean(about.find((a) => a.person_key === s.personKey)?.about, 300),
		interests: interests.filter((r) => r.person_key === s.personKey).map((r) => clean(r.label, 60)),
	}));
	const memories = mem.map((m, i) => ({ id: `m${i + 1}`, uuid: m.uuid, text: clean(`${m.memory_key}: ${m.memory_value}`, 240) }));

	const { data } = await llm.generateJson({
		task: "json",
		audience: "adult",
		temperature: 0.4,
		contents: [{ role: "user", parts: [{ text: backfillPrompt({ c, people, memories }) }] }],
		check: checkBackfill,
	});

	const have = await existingTitles(profileId, c.id);
	const perPerson = new Map();
	let written = 0;
	const write = async (entry, kind) => {
		const person = people.find((p) => p.id === entry?.person);
		const title = clean(entry?.title, 120);
		if (!person || !title) return;
		const limit = kind === "athena" ? MAX_IDEAS_PER_PERSON : MAX_FOUND_PER_PERSON;
		const tally = `${person.id}|${kind}`;
		if ((perPerson.get(tally) || 0) >= limit) return;
		const dedupe = `${person.subjectId}|${title.toLowerCase()}`;
		if (have.has(dedupe)) return;
		const memory = kind === "memory" ? memories.find((m) => m.id === entry.memory) : null;
		const sourceKind = kind === "athena" ? "athena" : memory ? "memory" : "person";
		await collections.addItem(profileId, c, {
			subjectId: person.subjectId,
			title,
			status: collections.SUGGESTED,
			sourceKind,
			sourceRef: memory?.uuid || null,
			reason: clean(entry.reason, 200) || null,
		});
		have.add(dedupe);
		perPerson.set(tally, (perPerson.get(tally) || 0) + 1);
		written += 1;
	};
	for (const f of data.found.slice(0, 60)) await write(f, "memory");
	for (const idea of data.ideas.slice(0, 40)) await write(idea, "athena");
	return { written };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function chatPrompt({ cols, message }) {
	return [
		"The person you look after just said this to you:",
		`"${clean(message, 1500)}"`,
		"",
		"Their active lists:",
		...cols.map((c) => `- ${c.key}: "${c.name}"${c.capture ? ` — keeps: ${c.capture}` : ""}${c.people.length ? `; people: ${c.people.join(", ")}` : ""}`),
		"",
		"Does the message say something that belongs on one of these lists — something a person on it wants, likes or",
		"needs, or an item the list keeps? Only what the message itself states; not what they asked you to add (that is",
		"handled separately) and nothing you infer beyond it.",
		`Return JSON { claims: [ { list (a key above), person (a name exactly as listed, or ""), title (short, concrete), reason (one short line) } ] }, at most ${MAX_CHAT_CLAIMS}. Usually claims is empty.`,
	].join("\n");
}

const checkChat = (data) => (data && Array.isArray(data.claims) ? true : "needs a claims array");

/** Suggestions from one adult chat turn. Never throws; returns how many were written. */
async function fromChat(profileId, message) {
	try {
		if (!profileId || String(message || "").trim().length < 12) return { written: 0 };
		const active = await collections.listActive(profileId);
		if (!active.length) return { written: 0 };
		const cols = [];
		for (const [i, c] of active.slice(0, 8).entries()) {
			const subjects = c.def.perPerson ? await collections.subjectsOf(profileId, c.id) : [];
			cols.push({ key: `l${i + 1}`, c, name: c.name, capture: c.def.capture, subjects, people: subjects.map((s) => s.label) });
		}
		const { data } = await llm.generateJson({
			task: "json",
			audience: "adult",
			temperature: 0.2,
			contents: [{ role: "user", parts: [{ text: chatPrompt({ cols, message }) }] }],
			check: checkChat,
		});
		let written = 0;
		for (const claim of data.claims.slice(0, MAX_CHAT_CLAIMS)) {
			const col = cols.find((x) => x.key === claim?.list);
			const title = clean(claim?.title, 120);
			if (!col || !title) continue;
			let subjectId = null;
			if (col.c.def.perPerson) {
				// Only someone already on that list: Athena never adds people by herself.
				const name = String(claim.person || "").toLowerCase().trim();
				const s = col.subjects.find((x) => x.label.toLowerCase() === name) || col.subjects.find((x) => name && x.label.toLowerCase().split(/\s+/)[0] === name.split(/\s+/)[0]);
				if (!s) continue;
				subjectId = s.id;
			}
			const have = await existingTitles(profileId, col.c.id);
			if (have.has(`${subjectId || 0}|${title.toLowerCase()}`)) continue;
			await collections.addItem(profileId, col.c, {
				subjectId,
				title,
				status: collections.SUGGESTED,
				sourceKind: "chat",
				reason: clean(claim.reason, 200) || null,
			});
			written += 1;
		}
		return { written };
	} catch (err) {
		console.warn("[collections] chat capture skipped:", err.message);
		return { written: 0 };
	}
}

module.exports = { backfill, fromChat, backfillPrompt, chatPrompt };
