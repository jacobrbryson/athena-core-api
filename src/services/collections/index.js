/**
 * Collections: kinds of things defined as data (owner, 2026-11-28).
 *
 * Design: claude.ai/artifact/HiT81qEfBoXFBpQRpUNCNG. "The real goal is that I
 * ask Athena for that and she facilitates all those changes internally without
 * code changes and just database updates."
 *
 * A collection is a definition row (athena_collection) — a Christmas list, a
 * birthday list, a maintenance log — and every item of every collection lives
 * in athena_collection_item, its fields checked against the definition HERE.
 * No collection gets a table of its own and no model writes SQL.
 *
 * Who changes what:
 *   - Chat changes go through the five general actions (./actions.js), so the
 *     action layer's propose / approve / audit sequence holds for every one.
 *   - The person's own taps in the app (check someone off, keep a suggestion,
 *     remove an idea) are their decision and come through the REST routes.
 *   - What Athena finds by herself (./capture.js) is written as 'suggested'
 *     and is only a record until the person keeps it.
 *
 * Rules the engine holds for every collection (design doc, "Rules the engine
 * enforces"): every row is the caller's (profile_id on every query); items
 * keep a pointer to their source, never the original text; an item whose
 * only source was a memory that has since been forgotten is not shown; remove
 * hides with undo.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../../helpers/db");
const entities = require("../entities");

const TZ = process.env.ATHENA_DEFAULT_TZ || "America/New_York";
const FIELD_TYPES = new Set(["text", "number", "money", "date", "yes_no", "choice", "link"]);
const RESERVED = new Set(["title", "status", "person", "id", "uuid", "source", "reason"]);
const HOME = new Set(["top", "after", "off"]);
const MAX_FIELDS = 12;
const MAX_ITEMS = 500;
const UNDO_DAYS = 30;
/** Athena's finds wait here until the person keeps one. */
const SUGGESTED = "suggested";

const bad = (message, status = 400, hint) => Object.assign(new Error(message), { status, ...(hint ? { hint } : {}) });

function today(at = new Date()) {
	return at.toLocaleDateString("en-CA", { timeZone: TZ });
}

function str(value, max) {
	if (typeof value !== "string") return null;
	const t = value.trim();
	return t ? t.slice(0, max) : null;
}

const fieldName = (raw) =>
	String(raw || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 40);

function slugify(name) {
	return (
		String(name || "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "collection"
	);
}

const parseJson = (v) => {
	if (v == null) return null;
	if (typeof v !== "string") return v;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
};

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/**
 * A definition from untrusted input (a model's draft), or a 400 saying what
 * is wrong. What comes out is the only shape the engine ever stores.
 */
function normalizeDefinition(raw = {}, { now = new Date() } = {}) {
	const name = str(raw.name, 120);
	if (!name) throw bad("A collection needs a name");
	const purpose = str(raw.purpose, 300);

	const fields = [];
	const seen = new Set();
	for (const f of Array.isArray(raw.fields) ? raw.fields : []) {
		if (!f || typeof f !== "object") continue;
		const fname = fieldName(f.name);
		if (!fname || RESERVED.has(fname) || seen.has(fname)) continue;
		const type = String(f.type || "text").toLowerCase();
		if (!FIELD_TYPES.has(type)) throw bad(`"${f.name}" has an unknown type "${f.type}"`, 400, `Field types are: ${[...FIELD_TYPES].join(", ")}`);
		const field = { name: fname, label: str(f.label, 60) || str(f.name, 60) || fname, type, required: f.required === true };
		if (type === "choice") {
			const choices = [...new Set((Array.isArray(f.choices) ? f.choices : []).map((c) => str(String(c ?? ""), 40)).filter(Boolean))];
			if (choices.length < 2 || choices.length > 12) throw bad(`"${field.label}" needs 2 to 12 choices`);
			field.choices = choices;
		}
		seen.add(fname);
		fields.push(field);
		if (fields.length > MAX_FIELDS) throw bad(`A collection can have at most ${MAX_FIELDS} fields`);
	}

	let statuses = [...new Set((Array.isArray(raw.statuses) ? raw.statuses : []).map((s) => str(String(s ?? ""), 24)?.toLowerCase()).filter(Boolean))];
	statuses = statuses.filter((s) => s !== SUGGESTED);
	if (!statuses.length) statuses = ["open", "done"];
	if (statuses.length > 8) throw bad("A collection can have at most 8 statuses");

	const home = HOME.has(raw.home) ? raw.home : "after";
	let endsOn = null;
	if (raw.endsOn != null && raw.endsOn !== "") {
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw.endsOn));
		if (!m || Number.isNaN(Date.parse(`${raw.endsOn}T00:00:00Z`))) throw bad("The end date must be YYYY-MM-DD");
		if (raw.endsOn < today(now)) throw bad("The end date is already past");
		const limit = new Date(now.getTime() + 2 * 366 * 86400000).toISOString().slice(0, 10);
		if (raw.endsOn > limit) throw bad("The end date can be at most two years away");
		endsOn = raw.endsOn;
	}
	return {
		name,
		purpose,
		fields,
		statuses,
		perPerson: raw.perPerson === true,
		capture: str(raw.capture, 400),
		home,
		endsOn,
	};
}

/** Field values from [{field, value}] (or an object), checked against the definition. */
function normalizeValues(def, raw, { partial = false } = {}) {
	const pairs = Array.isArray(raw)
		? raw.filter((p) => p && typeof p === "object").map((p) => [p.field ?? p.name, p.value])
		: raw && typeof raw === "object"
			? Object.entries(raw)
			: [];
	const out = {};
	for (const [rawName, value] of pairs) {
		const name = fieldName(rawName);
		const field = def.fields.find((f) => f.name === name || fieldName(f.label) === name);
		if (!field) throw bad(`"${rawName}" isn't a field of ${def.name}`, 400, `Its fields are: ${def.fields.map((f) => f.name).join(", ") || "none"}`);
		out[field.name] = coerce(field, value);
	}
	if (!partial) {
		for (const f of def.fields) if (f.required && (out[f.name] == null || out[f.name] === "")) throw bad(`${def.name} needs ${f.label}`);
	}
	return out;
}

function coerce(field, value) {
	if (value == null || value === "") return null;
	const text = String(value).trim();
	switch (field.type) {
		case "number":
		case "money": {
			const n = Number(text.replace(/[$,\s]/g, ""));
			if (!Number.isFinite(n)) throw bad(`${field.label} must be a number`);
			return field.type === "money" ? Math.round(n * 100) / 100 : n;
		}
		case "date":
			if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw bad(`${field.label} must be a date, YYYY-MM-DD`);
			return text;
		case "yes_no":
			return /^(y|yes|true|1|on)$/i.test(text);
		case "choice": {
			const hit = field.choices.find((c) => c.toLowerCase() === text.toLowerCase());
			if (!hit) throw bad(`${field.label} must be one of: ${field.choices.join(", ")}`);
			return hit;
		}
		case "link":
			if (!/^https?:\/\/\S+$/i.test(text)) throw bad(`${field.label} must be a link starting with http`);
			return text.slice(0, 500);
		default:
			return text.slice(0, 500);
	}
}

function rowToCollection(row) {
	const def = parseJson(row.definition) || {};
	const endsOn = row.ends_on ? (row.ends_on instanceof Date ? row.ends_on.toISOString().slice(0, 10) : String(row.ends_on).slice(0, 10)) : null;
	return {
		id: row.id,
		uuid: row.uuid,
		slug: row.slug,
		name: row.name,
		version: row.version,
		endsOn,
		archived: !!row.archived_at || (endsOn ? endsOn < today() : false),
		def: { ...def, name: row.name, endsOn },
	};
}

// ---------------------------------------------------------------------------
// Reading collections
// ---------------------------------------------------------------------------

async function listRows(profileId, { includeArchived = false } = {}) {
	const [rows] = await pool.query(
		`SELECT id, uuid, slug, name, definition, version, ends_on, archived_at, created_at FROM athena_collection
		 WHERE profile_id = ? ${includeArchived ? "" : "AND archived_at IS NULL AND (ends_on IS NULL OR ends_on >= ?)"}
		 ORDER BY created_at DESC LIMIT 50`,
		includeArchived ? [profileId] : [profileId, today()]
	);
	return rows.map(rowToCollection);
}

/** Active collections. */
const listActive = (profileId) => listRows(profileId);

/**
 * The active collection a name means: its slug, its exact name, or the one
 * collection whose name contains every word given. Ambiguous or missing is a
 * 400 naming what exists, so a model can try again.
 */
async function find(profileId, nameOrSlug, { includeArchived = false } = {}) {
	const all = await listRows(profileId, { includeArchived });
	const said = String(nameOrSlug || "").trim().toLowerCase();
	if (!said) {
		if (all.length === 1) return all[0];
		throw bad("Which collection?", 400, `Name one of: ${all.map((c) => c.name).join(", ") || "none yet"}`);
	}
	const exact = all.find((c) => c.slug === slugify(said) || c.name.toLowerCase() === said);
	if (exact) return exact;
	const want = said.split(/\s+/).filter((w) => w.length > 2);
	const hits = all.filter((c) => want.every((w) => c.name.toLowerCase().includes(w)));
	if (hits.length === 1) return hits[0];
	throw bad(`There's no ${hits.length ? "single " : ""}collection called "${nameOrSlug}"`, 400, `Collections: ${all.map((c) => c.name).join(", ") || "none yet"}`);
}

async function byUuid(profileId, uuid) {
	const [[row]] = await pool.query(
		"SELECT id, uuid, slug, name, definition, version, ends_on, archived_at FROM athena_collection WHERE profile_id = ? AND uuid = ?",
		[profileId, String(uuid || "")]
	);
	if (!row) throw bad("That collection isn't yours or doesn't exist.", 404);
	return rowToCollection(row);
}

async function subjectsOf(profileId, collectionId) {
	const [rows] = await pool.query(
		`SELECT id, uuid, person_key, label, done_at FROM athena_collection_subject
		 WHERE profile_id = ? AND collection_id = ? AND removed_at IS NULL ORDER BY id`,
		[profileId, collectionId]
	);
	return rows.map((r) => ({ id: r.id, uuid: r.uuid, personKey: r.person_key, label: r.label, done: !!r.done_at }));
}

/**
 * Items, minus removed ones and minus any whose only source was a memory
 * that has since been forgotten (the forgetting rule, enforced at read time
 * so no path can show one).
 */
async function itemsOf(profileId, collectionIds, { includeRemoved = false } = {}) {
	if (!collectionIds.length) return [];
	const [rows] = await pool.query(
		`SELECT i.id, i.uuid, i.collection_id, i.subject_id, i.title, i.status, i.fields, i.source_kind, i.source_ref,
		        i.reason, i.removed_at, i.created_at, i.updated_at
		   FROM athena_collection_item i
		   LEFT JOIN user_memory m ON i.source_kind = 'memory' AND m.uuid = i.source_ref AND m.profile_id = i.profile_id
		  WHERE i.profile_id = ? AND i.collection_id IN (?)
		    ${includeRemoved ? "" : "AND i.removed_at IS NULL"}
		    AND (i.source_kind <> 'memory' OR (m.uuid IS NOT NULL AND m.deleted_at IS NULL))
		  ORDER BY i.created_at`,
		[profileId, collectionIds]
	);
	return rows.map((r) => ({
		id: r.id,
		uuid: r.uuid,
		collectionId: r.collection_id,
		subjectId: r.subject_id,
		title: r.title,
		status: r.status,
		fields: parseJson(r.fields) || {},
		source: r.source_kind,
		reason: r.reason || null,
		removed: !!r.removed_at,
		createdAt: r.created_at,
	}));
}

/** What the app shows for one collection. */
function present(c, subjects, items) {
	const bySubject = (id) => items.filter((i) => i.subjectId === id);
	return {
		uuid: c.uuid,
		name: c.name,
		purpose: c.def.purpose || null,
		fields: c.def.fields || [],
		statuses: c.def.statuses || [],
		perPerson: !!c.def.perPerson,
		home: c.def.home || "after",
		endsOn: c.endsOn,
		archived: c.archived,
		people: subjects.map((s) => ({
			uuid: s.uuid,
			personKey: s.personKey,
			label: s.label,
			done: s.done,
			items: bySubject(s.id).map(publicItem),
		})),
		items: items.filter((i) => !i.subjectId).map(publicItem),
		counts: {
			people: subjects.length,
			peopleDone: subjects.filter((s) => s.done).length,
			items: items.filter((i) => i.status !== SUGGESTED).length,
			suggested: items.filter((i) => i.status === SUGGESTED).length,
		},
	};
}

function publicItem(i) {
	return { uuid: i.uuid, title: i.title, status: i.status, fields: i.fields, source: i.source, reason: i.reason, removed: i.removed };
}

/** Every active collection, ready to draw (Home cards, the collections page). */
async function overview(profileId) {
	const cols = await listActive(profileId);
	const items = await itemsOf(profileId, cols.map((c) => c.id));
	const out = [];
	for (const c of cols) out.push(present(c, await subjectsOf(profileId, c.id), items.filter((i) => i.collectionId === c.id)));
	return { collections: out };
}

/** One collection in full, archived ones too (so an archived list can be reopened). */
async function detail(profileId, uuid) {
	const c = await byUuid(profileId, uuid);
	const [subjects, items] = await Promise.all([subjectsOf(profileId, c.id), itemsOf(profileId, [c.id])]);
	return present(c, subjects, items);
}

/** The active collections a person is on, with their items (the person page). */
async function forPerson(profileId, personKey) {
	const [rows] = await pool.query(
		`SELECT s.id AS subject_id, s.uuid AS subject_uuid, s.done_at, c.id, c.uuid, c.slug, c.name, c.definition, c.version, c.ends_on, c.archived_at
		   FROM athena_collection_subject s JOIN athena_collection c ON c.id = s.collection_id AND c.profile_id = s.profile_id
		  WHERE s.profile_id = ? AND s.person_key = ? AND s.removed_at IS NULL
		    AND c.archived_at IS NULL AND (c.ends_on IS NULL OR c.ends_on >= ?)`,
		[profileId, String(personKey || ""), today()]
	);
	if (!rows.length) return { collections: [] };
	const items = await itemsOf(profileId, rows.map((r) => r.id));
	return {
		collections: rows.map((r) => {
			const c = rowToCollection(r);
			return {
				uuid: c.uuid,
				name: c.name,
				statuses: c.def.statuses || [],
				fields: c.def.fields || [],
				subjectUuid: r.subject_uuid,
				done: !!r.done_at,
				items: items.filter((i) => i.subjectId === r.subject_id).map(publicItem),
			};
		}),
	};
}

// ---------------------------------------------------------------------------
// Writing (called by the actions, the REST routes and capture — never by a model directly)
// ---------------------------------------------------------------------------

async function create(profileId, def, people = []) {
	const uuid = randomUUID();
	let slug = slugify(def.name);
	const [[clash]] = await pool.query("SELECT COUNT(*) AS n FROM athena_collection WHERE profile_id = ? AND slug LIKE ?", [profileId, `${slug}%`]);
	if (Number(clash?.n) > 0) slug = `${slug}-${Number(clash.n) + 1}`.slice(0, 80);
	const { name, endsOn, ...stored } = def;
	const [res] = await pool.query(
		`INSERT INTO athena_collection (uuid, profile_id, slug, name, definition, ends_on) VALUES (?, ?, ?, ?, ?, ?)`,
		[uuid, profileId, slug, name, JSON.stringify(stored), endsOn]
	);
	for (const p of people) await addSubject(profileId, res.insertId, p);
	return { id: res.insertId, uuid, slug };
}

/** Put someone on a per-person collection (again, if they were removed). */
async function addSubject(profileId, collectionId, { key, label }) {
	await pool.query(
		`INSERT INTO athena_collection_subject (uuid, collection_id, profile_id, person_key, label) VALUES (?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE removed_at = NULL, label = VALUES(label)`,
		[randomUUID(), collectionId, profileId, String(key).slice(0, 64), String(label || key).slice(0, 120)]
	);
	const [[row]] = await pool.query(
		"SELECT id, uuid FROM athena_collection_subject WHERE collection_id = ? AND profile_id = ? AND person_key = ?",
		[collectionId, profileId, String(key).slice(0, 64)]
	);
	return row;
}

async function subjectFor(profileId, collectionId, personKey) {
	const [[row]] = await pool.query(
		"SELECT id, uuid, label, done_at FROM athena_collection_subject WHERE profile_id = ? AND collection_id = ? AND person_key = ? AND removed_at IS NULL",
		[profileId, collectionId, personKey]
	);
	return row || null;
}

async function setSubjectDone(profileId, subjectUuid, done) {
	const [res] = await pool.query(
		`UPDATE athena_collection_subject SET done_at = ${done ? "COALESCE(done_at, NOW())" : "NULL"} WHERE profile_id = ? AND uuid = ? AND removed_at IS NULL`,
		[profileId, String(subjectUuid || "")]
	);
	if (!res.affectedRows) throw bad("That person isn't on one of your lists.", 404);
}

async function removeSubject(profileId, subjectUuid) {
	const [res] = await pool.query("UPDATE athena_collection_subject SET removed_at = NOW() WHERE profile_id = ? AND uuid = ?", [profileId, String(subjectUuid || "")]);
	if (!res.affectedRows) throw bad("That person isn't on one of your lists.", 404);
}

async function addItem(profileId, collection, { subjectId = null, title, status, fields = {}, sourceKind = "chat", sourceRef = null, reason = null }) {
	const [[count]] = await pool.query("SELECT COUNT(*) AS n FROM athena_collection_item WHERE profile_id = ? AND collection_id = ? AND removed_at IS NULL", [profileId, collection.id]);
	if (Number(count?.n) >= MAX_ITEMS) throw bad(`${collection.name} is full (${MAX_ITEMS} items)`);
	const uuid = randomUUID();
	await pool.query(
		`INSERT INTO athena_collection_item (uuid, collection_id, profile_id, subject_id, title, status, fields, source_kind, source_ref, reason)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[uuid, collection.id, profileId, subjectId, String(title).slice(0, 200), status, JSON.stringify(fields || {}), sourceKind, sourceRef, reason ? String(reason).slice(0, 255) : null]
	);
	return uuid;
}

/** An item of the caller's with its collection, or a 404. */
async function ownItem(profileId, itemUuid) {
	const [[row]] = await pool.query(
		`SELECT i.id, i.uuid, i.collection_id, i.subject_id, i.title, i.status, i.fields, i.removed_at, c.uuid AS collection_uuid
		   FROM athena_collection_item i JOIN athena_collection c ON c.id = i.collection_id AND c.profile_id = i.profile_id
		  WHERE i.profile_id = ? AND i.uuid = ?`,
		[profileId, String(itemUuid || "")]
	);
	if (!row) throw bad("That item isn't yours or doesn't exist.", 404);
	return row;
}

async function updateItem(profileId, itemUuid, { title, status, fields }) {
	const item = await ownItem(profileId, itemUuid);
	const c = await byUuid(profileId, item.collection_uuid);
	const sets = [];
	const args = [];
	if (title != null) {
		const t = str(title, 200);
		if (!t) throw bad("An item needs a title");
		sets.push("title = ?");
		args.push(t);
	}
	if (status != null) {
		const s = String(status).toLowerCase();
		if (s !== SUGGESTED && !c.def.statuses.includes(s)) throw bad(`Status must be one of: ${c.def.statuses.join(", ")}`);
		sets.push("status = ?");
		args.push(s);
	}
	if (fields && Object.keys(fields).length) {
		const merged = { ...(parseJson(item.fields) || {}), ...normalizeValues(c.def, fields, { partial: true }) };
		sets.push("fields = ?");
		args.push(JSON.stringify(merged));
	}
	if (!sets.length) return;
	await pool.query(`UPDATE athena_collection_item SET ${sets.join(", ")} WHERE profile_id = ? AND uuid = ?`, [...args, profileId, item.uuid]);
}

async function removeItem(profileId, itemUuid) {
	await ownItem(profileId, itemUuid);
	await pool.query("UPDATE athena_collection_item SET removed_at = NOW() WHERE profile_id = ? AND uuid = ?", [profileId, itemUuid]);
}

async function restoreItem(profileId, itemUuid) {
	const item = await ownItem(profileId, itemUuid);
	if (!item.removed_at) return;
	await pool.query(
		`UPDATE athena_collection_item SET removed_at = NULL
		 WHERE profile_id = ? AND uuid = ? AND removed_at >= NOW() - INTERVAL ? DAY`,
		[profileId, itemUuid, UNDO_DAYS]
	);
}

async function setArchived(profileId, collectionId, archived) {
	await pool.query(
		`UPDATE athena_collection SET archived_at = ${archived ? "NOW()" : "NULL"}${archived ? "" : ", ends_on = IF(ends_on < ?, NULL, ends_on)"}
		 WHERE profile_id = ? AND id = ?`,
		archived ? [profileId, collectionId] : [today(), profileId, collectionId]
	);
}

/**
 * The item a phrase names inside a collection (and person), or a 400 listing
 * what is there. Exact title first, then the single title containing it.
 */
async function findItem(profileId, collection, phrase, { subjectId } = {}) {
	const items = (await itemsOf(profileId, [collection.id])).filter((i) => (subjectId ? i.subjectId === subjectId : true));
	const said = String(phrase || "").trim().toLowerCase();
	const exact = items.filter((i) => i.title.toLowerCase() === said);
	if (exact.length === 1) return exact[0];
	const partial = items.filter((i) => i.title.toLowerCase().includes(said) || said.includes(i.title.toLowerCase()));
	if (partial.length === 1) return partial[0];
	throw bad(
		partial.length > 1 ? `More than one item matches "${phrase}"` : `Nothing in ${collection.name} matches "${phrase}"`,
		400,
		`Items: ${items.slice(0, 20).map((i) => i.title).join("; ") || "none"}`
	);
}

/** After a list's last day: archived for good by the nightly sweep. */
async function sweep() {
	const [res] = await pool.query("UPDATE athena_collection SET archived_at = NOW() WHERE archived_at IS NULL AND ends_on IS NOT NULL AND ends_on < ?", [today()]);
	return { archived: res.affectedRows || 0 };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/**
 * What chat knows about collections this turn: the active ones, who is on
 * them and what is in them, compactly, plus how to start a new one. Read-only;
 * every change is one of the five actions.
 */
async function promptBlock(profileId) {
	const { collections } = await overview(profileId);
	const lines = [
		"# Collections (lists and trackers you keep for them)",
		"You can start a new kind of list, log or tracker for them with define_collection — a Christmas list, a birthday",
		"list, a packing list, a maintenance log — when they ask you to keep track of something. A list about people",
		"(gifts, birthdays) is per-person: name the people you already know should be on it and ask who else.",
		"Change what is in one with add_item / update_item / remove_item, and end or reopen one with archive_collection.",
		"Items marked (suggested) are things you found that they haven't kept yet.",
	];
	if (!collections.length) {
		lines.push("", "They have no collections yet.");
		return lines.join("\n");
	}
	for (const c of collections.slice(0, 8)) {
		lines.push("", `## ${c.name}${c.endsOn ? ` (until ${c.endsOn})` : ""}`);
		if (c.purpose) lines.push(c.purpose);
		lines.push(`Statuses: ${c.statuses.join(", ")}.${c.fields.length ? ` Fields: ${c.fields.map((f) => `${f.name} (${f.type})`).join(", ")}.` : ""}`);
		const itemLine = (i) => `${i.title}${i.status === SUGGESTED ? " (suggested)" : ` [${i.status}]`}`;
		for (const p of c.people.slice(0, 20)) {
			const shown = p.items.slice(0, 8).map(itemLine).join("; ");
			lines.push(`- ${p.label}${p.done ? " ✓ done" : ""}: ${shown || "no ideas yet"}`);
		}
		if (c.items.length) lines.push(`- ${c.items.slice(0, 12).map(itemLine).join("; ")}`);
	}
	return lines.join("\n");
}

module.exports = {
	normalizeDefinition,
	normalizeValues,
	slugify,
	today,
	listActive,
	find,
	byUuid,
	overview,
	detail,
	forPerson,
	create,
	addSubject,
	subjectFor,
	setSubjectDone,
	removeSubject,
	addItem,
	updateItem,
	removeItem,
	restoreItem,
	setArchived,
	findItem,
	itemsOf,
	subjectsOf,
	sweep,
	promptBlock,
	entities,
	SUGGESTED,
	FIELD_TYPES,
};
