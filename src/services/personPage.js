/**
 * A page for each person Athena knows (owner, 2026-11-22) — what the
 * companion's /family/people/<key> shows beyond what the Family page already
 * has in hand (the person's memory, Contact card, child profile, active
 * health watches, calendar and chores).
 *
 * Read here: what this page stores of its own (the write-up, a relation,
 * interests, related people — migration 0122), the memory events that
 * mention them, every health watch on them (ended ones too), and camera
 * sightings of the subject linked to them.
 *
 * A person is identified the way the Family roster identifies them: a
 * remembered person's user_memory uuid, or `child:<child_profiles.uuid>` for
 * a child on the family's profiles with no memory of their own. Every read
 * and write checks the key belongs to the caller first.
 *
 * Name matching (memories, health watches) uses the tokens the roster
 * already worked out for this person — their names minus words the family
 * shares, like the surname — sent by the page. They only filter the caller's
 * own rows; they can't reach anyone else's.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../helpers/db");
const familyPeople = require("./familyPeople");
const family = require("./family");

const MAX_INTERESTS = 24;
const MAX_RELATED = 24;
const MEMORY_LIMIT = 60;
const SIGHTING_DAYS = 14;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function trim(value, max) {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

const iso = (v) => (v ? new Date(v).toISOString() : null);

/**
 * Grades in order. A grade is stored with the school year it was set in and
 * shown advanced by every school year begun since, so "4th" set in November
 * 2026 reads "5th" from August 1st 2027 with nothing scheduled to move it.
 */
const GRADES = ["pre-k", "kindergarten", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
const GRADE_ROLLOVER_MONTH = 7; // August, 0-based: the school year turns over on August 1st

/** The school year `at` falls in, by the year it began: Aug 2026 – Jul 2027 is 2026. */
function schoolYear(at = new Date()) {
	const d = new Date(at);
	return d.getMonth() >= GRADE_ROLLOVER_MONTH ? d.getFullYear() : d.getFullYear() - 1;
}

function normalizeGrade(value) {
	const v = String(value ?? "").trim().toLowerCase().replace(/(st|nd|rd|th)$/, "");
	if (v === "k" || v === "kinder") return "kindergarten";
	if (v === "prek" || v === "pre k" || v === "preschool") return "pre-k";
	return GRADES.includes(v) ? v : null;
}

/** The grade as of `at`, from what was set and when: "5", "kindergarten", or "graduated" past 12th. */
function currentGrade(grade, gradeYear, at = new Date()) {
	const i = GRADES.indexOf(normalizeGrade(grade));
	if (i < 0) return null;
	const moved = Number.isFinite(Number(gradeYear)) && gradeYear !== null ? Math.max(0, schoolYear(at) - Number(gradeYear)) : 0;
	return i + moved < GRADES.length ? GRADES[i + moved] : "graduated";
}

function gradeLabel(grade) {
	if (!grade) return null;
	if (grade === "pre-k") return "Pre-K";
	if (grade === "kindergarten") return "Kindergarten";
	if (grade === "graduated") return "Graduated";
	const n = Number(grade);
	const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
	return `${n}${suffix} grade`;
}

/** Up to four lower-case name words of 3+ letters — anything else is dropped, not trusted. */
function nameTokens(raw) {
	const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
	return [...new Set(list.map((t) => String(t).toLowerCase().trim()).filter((t) => /^[a-z][a-z'-]{2,29}$/.test(t)))].slice(0, 4);
}

/** The person this key names, if it's the caller's: { key, factUuid, childUuid, name }. 404 otherwise. */
async function personFor(profileId, key) {
	const k = String(key || "");
	const child = /^child:([0-9a-f-]{36})$/i.exec(k);
	if (child) {
		const fam = await family.getFamilyForProfile(profileId).catch(() => null);
		const kids = fam ? await family.listChildren(fam.id).catch(() => []) : [];
		const kid = kids.find((c) => c.uuid === child[1]);
		if (kid) return { key: k, factUuid: null, childUuid: kid.uuid, name: kid.display_name };
	} else if (/^[0-9a-f-]{36}$/i.test(k)) {
		const fact = await familyPeople.ownFact(profileId, k);
		if (fact) return { key: k, factUuid: fact.uuid, childUuid: null, name: fact.memory_key, category: fact.category };
	}
	throw bad("That person isn't in your family memories.", 404);
}

/** Someone the related-people list can point at: another remembered person, or a child profile, of the caller's. */
async function assertOther(profileId, key) {
	await personFor(profileId, key);
}

async function ownRow(profileId, key) {
	const [[row]] = await pool.query("SELECT about, relation, grade, grade_year, updated_at FROM athena_person WHERE profile_id = ? AND person_key = ?", [profileId, key]);
	return row || null;
}

async function memoriesFor(profileId, tokens) {
	if (!tokens.length) return [];
	const like = tokens.map(() => "(e.title LIKE ? OR e.content LIKE ?)").join(" OR ");
	const params = tokens.flatMap((t) => [`%${t}%`, `%${t}%`]);
	const [rows] = await pool.query(
		`SELECT e.uuid, e.kind, e.title, e.content, e.occurred_at, e.importance, e.source, e.media_ref
		   FROM memory_event e
		  WHERE e.profile_id = ? AND e.scope <> 'world' AND e.kind <> 'news' AND (${like})
		  ORDER BY e.occurred_at DESC LIMIT ?`,
		[profileId, ...params, MEMORY_LIMIT * 2]
	);
	// LIKE is a coarse first pass; keep only whole-word mentions ("Sky" isn't "Skylar"'s sister "Skye").
	const word = new RegExp(`\\b(${tokens.map((t) => t.replace(/[^a-z'-]/g, "")).join("|")})('s)?\\b`, "i");
	return rows
		.filter((r) => word.test(`${r.title || ""} ${r.content || ""}`))
		.slice(0, MEMORY_LIMIT)
		.map((r) => ({
			uuid: r.uuid,
			kind: r.kind,
			title: r.title,
			content: String(r.content || "").slice(0, 600),
			occurredAt: iso(r.occurred_at),
			importance: Number(r.importance),
			source: r.source,
			mediaRef: r.media_ref || null,
		}));
}

/** Every health watch on them, active first — by first name, as the roster matches them. */
async function healthFor(profileId, tokens) {
	if (!tokens.length) return [];
	const fam = await family.getFamilyForProfile(profileId).catch(() => null);
	if (!fam) return [];
	const [rows] = await pool.query(
		`SELECT uuid, person_name, symptom, severity, status, started_at, resolved_at, last_update_at
		   FROM family_health_status WHERE family_id = ? AND deleted_at IS NULL
		  ORDER BY status = 'active' DESC, started_at DESC LIMIT 100`,
		[fam.id]
	);
	return rows
		.filter((r) => String(r.person_name).toLowerCase().split(/[^a-z']+/).some((w) => tokens.includes(w)))
		.slice(0, 30)
		.map((r) => ({
			uuid: r.uuid,
			personName: r.person_name,
			symptom: r.symptom,
			severity: r.severity,
			status: r.status,
			startedAt: r.started_at ? new Date(r.started_at).toISOString().slice(0, 10) : null,
			resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString().slice(0, 10) : null,
			lastUpdateAt: iso(r.last_update_at),
		}));
}

/** Camera sightings of the subject linked to this person's memory, last two weeks. Null when none is linked. */
async function sightingsFor(profileId, factUuid) {
	if (!factUuid) return null;
	const [[link]] = await pool.query("SELECT subject_id FROM athena_sighting_person_link WHERE profile_id = ? AND fact_uuid = ?", [profileId, factUuid]);
	if (!link) return null;
	const [rows] = await pool.query(
		`SELECT seen_at, device_name, where_text FROM athena_sighting
		  WHERE subject_id = ? AND seen_at >= ? ORDER BY seen_at DESC LIMIT 20`,
		[link.subject_id, new Date(Date.now() - SIGHTING_DAYS * 86_400_000)]
	);
	return {
		days: SIGHTING_DAYS,
		count: rows.length,
		recent: rows.slice(0, 5).map((r) => ({ at: iso(r.seen_at), camera: r.device_name || null, where: r.where_text || null })),
	};
}

async function interestsFor(profileId, key) {
	const [rows] = await pool.query(
		`SELECT uuid, label, icon FROM athena_person_interest
		  WHERE profile_id = ? AND person_key = ? AND deleted_at IS NULL ORDER BY sort_order, id`,
		[profileId, key]
	);
	return rows.map((r) => ({ uuid: r.uuid, label: r.label, icon: r.icon || null }));
}

async function relatedFor(profileId, key) {
	const [rows] = await pool.query(
		`SELECT uuid, other_key, label FROM athena_person_relation
		  WHERE profile_id = ? AND person_key = ? AND deleted_at IS NULL ORDER BY id`,
		[profileId, key]
	);
	return rows.map((r) => ({ uuid: r.uuid, otherKey: r.other_key, label: r.label }));
}

/** Everything the page reads from the server for one person. */
async function read(profileId, key, { names } = {}) {
	const person = await personFor(profileId, key);
	const tokens = nameTokens(names);
	const settle = (p, fallback) => p.catch((err) => {
		console.warn("[personPage] part of the page couldn't be read:", err.message);
		return fallback;
	});
	const [own, interests, related, memories, health, sightings] = await Promise.all([
		ownRow(profileId, person.key),
		interestsFor(profileId, person.key),
		relatedFor(profileId, person.key),
		settle(memoriesFor(profileId, tokens), []),
		settle(healthFor(profileId, tokens), []),
		settle(sightingsFor(profileId, person.factUuid), null),
	]);
	return {
		key: person.key,
		about: own?.about || null,
		relation: own?.relation || null,
		grade: own?.grade ? currentGrade(own.grade, own.grade_year) : null,
		gradeLabel: own?.grade ? gradeLabel(currentGrade(own.grade, own.grade_year)) : null,
		interests,
		related,
		memories,
		health,
		sightings,
	};
}

/**
 * Save the write-up, relation and/or grade. Omitted fields stay; null or ""
 * clears. A grade is stored with this school year, so it moves up by itself.
 */
async function saveAbout(profileId, key, payload = {}) {
	const person = await personFor(profileId, key);
	const has = (k) => Object.prototype.hasOwnProperty.call(payload, k);
	const own = await ownRow(profileId, person.key);
	const about = has("about") ? trim(payload.about, 600) : own?.about ?? null;
	const relation = has("relation") ? trim(payload.relation, 60) : own?.relation ?? null;
	let grade = own?.grade ?? null;
	let gradeYear = own?.grade_year ?? null;
	if (has("grade")) {
		const blank = payload.grade === null || String(payload.grade).trim() === "";
		grade = blank ? null : normalizeGrade(payload.grade);
		if (!blank && !grade) throw bad("Pick a grade from Pre-K to 12th.");
		gradeYear = grade ? schoolYear() : null;
	}
	await pool.query(
		`INSERT INTO athena_person (profile_id, person_key, about, relation, grade, grade_year) VALUES (?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE about = VALUES(about), relation = VALUES(relation), grade = VALUES(grade), grade_year = VALUES(grade_year)`,
		[profileId, person.key, about, relation, grade, gradeYear]
	);
	return read(profileId, person.key, payload);
}

const ICONS = new Set(["star", "ball", "art", "paw", "robot", "food", "book", "music", "game", "run", "bike", "leaf", "heart", "camera", "chef", "plane"]);

async function addInterest(profileId, key, payload = {}) {
	const person = await personFor(profileId, key);
	const label = trim(payload.label, 60);
	if (!label) throw bad("Say what they like.");
	const icon = ICONS.has(payload.icon) ? payload.icon : null;
	const current = await interestsFor(profileId, person.key);
	if (current.length >= MAX_INTERESTS) throw bad(`A person can hold ${MAX_INTERESTS} interests; remove one first.`, 409);
	if (current.some((i) => i.label.toLowerCase() === label.toLowerCase())) throw bad(`${label} is already on the list.`, 409);
	await pool.query(
		`INSERT INTO athena_person_interest (uuid, profile_id, person_key, label, icon, sort_order) VALUES (?, ?, ?, ?, ?, ?)`,
		[randomUUID(), profileId, person.key, label, icon, current.length]
	);
	return read(profileId, person.key, payload);
}

async function removeInterest(profileId, key, uuid, payload = {}) {
	const person = await personFor(profileId, key);
	const [r] = await pool.query(
		"UPDATE athena_person_interest SET deleted_at = NOW() WHERE uuid = ? AND profile_id = ? AND person_key = ? AND deleted_at IS NULL",
		[String(uuid || ""), profileId, person.key]
	);
	if (!r.affectedRows) throw bad("That interest isn't on the list.", 404);
	return read(profileId, person.key, payload);
}

async function addRelated(profileId, key, payload = {}) {
	const person = await personFor(profileId, key);
	const otherKey = String(payload.otherKey || "");
	if (otherKey === person.key) throw bad("Pick someone else.");
	await assertOther(profileId, otherKey);
	const label = trim(payload.label, 60);
	if (!label) throw bad("Say how they're related — e.g. Brother, Mom.");
	const current = await relatedFor(profileId, person.key);
	if (current.length >= MAX_RELATED) throw bad(`A person can list ${MAX_RELATED} related people; remove one first.`, 409);
	if (current.some((r) => r.otherKey === otherKey)) throw bad("They're already listed — remove them to change how.", 409);
	await pool.query(
		`INSERT INTO athena_person_relation (uuid, profile_id, person_key, other_key, label) VALUES (?, ?, ?, ?, ?)`,
		[randomUUID(), profileId, person.key, otherKey, label]
	);
	return read(profileId, person.key, payload);
}

async function removeRelated(profileId, key, uuid, payload = {}) {
	const person = await personFor(profileId, key);
	const [r] = await pool.query(
		"UPDATE athena_person_relation SET deleted_at = NOW() WHERE uuid = ? AND profile_id = ? AND person_key = ? AND deleted_at IS NULL",
		[String(uuid || ""), profileId, person.key]
	);
	if (!r.affectedRows) throw bad("They aren't on the list.", 404);
	return read(profileId, person.key, payload);
}

module.exports = { read, saveAbout, currentGrade, gradeLabel, schoolYear, GRADES, addInterest, removeInterest, addRelated, removeRelated, nameTokens, ICONS: [...ICONS] };
