const pool = require("../helpers/db");
const familyService = require("./family");
const community = require("./community");
const memory = require("./memory");

/**
 * What the Family card knows about people beyond memories: the children on
 * the family's profiles (name, birthday) and the Google Contact, if any, the
 * person linked to a remembered family member. Everything here is the
 * caller's own; nothing accepts a caller-supplied profile. See
 * docs/capabilities/companion-dashboard.md.
 */

const FAMILY_CATEGORIES = ["person", "family", "pet"];
const bad = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * A DATE column as YYYY-MM-DD, whether the driver gave a string or a Date.
 * The pool reads with timezone 'Z', so a Date is UTC midnight: read it back in
 * UTC, or any process west of UTC (local dev in Eastern) reports the day before.
 */
function isoDay(value) {
	if (!value) return null;
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return null;
		const mm = String(value.getUTCMonth() + 1).padStart(2, "0");
		const dd = String(value.getUTCDate()).padStart(2, "0");
		return `${value.getUTCFullYear()}-${mm}-${dd}`;
	}
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
	return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

async function childrenOf(profileId) {
	const family = await familyService.getFamilyForProfile(profileId);
	if (!family) return [];
	const kids = await familyService.listChildren(family.id);
	return kids.map((k) => ({ uuid: k.uuid, name: k.display_name, birthday: isoDay(k.birthday), grade: k.grade || null }));
}

const contactCard = (c) => ({
	contactId: c.contactId,
	name: c.name,
	birthday: c.birthday || null,
	phone: c.phones?.[0]?.value || null,
	email: c.emails?.[0]?.value || null,
	photoUrl: c.photoUrl || null,
});

/** The links, each with its contact read from Google (or a reason it can't be). */
async function linksFor(profileId) {
	const [rows] = await pool.query(
		`SELECT l.fact_uuid, l.contact_id, l.contact_name FROM athena_family_contact l
		 JOIN user_memory m ON m.uuid = l.fact_uuid AND m.profile_id = l.profile_id AND m.deleted_at IS NULL
		 WHERE l.profile_id = ?`,
		[profileId]
	);
	if (!rows.length) return { links: [], contactsLinked: null };
	const mark = (status) => rows.map((r) => ({ factUuid: r.fact_uuid, contactId: r.contact_id, name: r.contact_name || null, card: null, status }));
	let list;
	try {
		list = await community.contactsFor(profileId);
	} catch (err) {
		console.warn("[familyPeople] contacts unavailable:", err.message);
		return { links: mark("unreadable"), contactsLinked: null };
	}
	if (list === null) return { links: mark("not_connected"), contactsLinked: false };
	const byId = new Map(list.map((c) => [c.contactId, c]));
	return {
		contactsLinked: true,
		links: rows.map((r) => {
			const c = byId.get(r.contact_id);
			return c
				? { factUuid: r.fact_uuid, contactId: r.contact_id, name: c.name || r.contact_name || null, card: contactCard(c), status: "ok" }
				: { factUuid: r.fact_uuid, contactId: r.contact_id, name: r.contact_name || null, card: null, status: "missing" };
		}),
	};
}

async function overview(profileId) {
	const [children, { links, contactsLinked }, [portraits]] = await Promise.all([
		childrenOf(profileId), linksFor(profileId),
		pool.query(`SELECT p.fact_uuid, p.image FROM athena_family_portrait p
		 JOIN user_memory m ON m.uuid = p.fact_uuid AND m.profile_id = p.profile_id AND m.deleted_at IS NULL
		 WHERE p.profile_id = ?`, [profileId]),
	]);
	const photos = Object.fromEntries(portraits.map((p) => [p.fact_uuid, `data:image/jpeg;base64,${p.image.toString('base64')}`]));
	return { children, links, contactsLinked, photos };
}

/** Replace or clear a portrait. The person must still be in the caller's own family memories. */
async function setPortrait(profileId, factUuid, imageBase64) {
	const fact = await ownFact(profileId, factUuid);
	if (!fact) throw notFound();
	if (imageBase64 === null) {
		await pool.query('DELETE FROM athena_family_portrait WHERE profile_id = ? AND fact_uuid = ?', [profileId, factUuid]);
		return overview(profileId);
	}
	if (typeof imageBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64) || imageBase64.length > 180000) throw bad('Choose a smaller JPEG portrait.');
	const image = Buffer.from(imageBase64, 'base64');
	if (image.length < 4 || image.length > 131072 || image[0] !== 0xff || image[1] !== 0xd8 || image[image.length - 2] !== 0xff || image[image.length - 1] !== 0xd9) throw bad('That portrait is not a valid JPEG.');
	await pool.query(`INSERT INTO athena_family_portrait (profile_id, fact_uuid, image) VALUES (?, ?, ?)
	 ON DUPLICATE KEY UPDATE image = VALUES(image), updated_at = CURRENT_TIMESTAMP`, [profileId, factUuid, image]);
	return overview(profileId);
}

/** Link (or re-link) a remembered family member to a Google Contact. */
async function linkContact(profileId, factUuid, input = {}) {
	const contactId = String(input.contactId || "").trim();
	if (!/^\d{1,20}$/.test(contactId)) throw bad("That isn't a Google contact I can link.");
	const [[fact]] = await pool.query(
		"SELECT uuid FROM user_memory WHERE profile_id = ? AND uuid = ? AND deleted_at IS NULL AND category IN (?)",
		[profileId, String(factUuid), FAMILY_CATEGORIES]
	);
	if (!fact) throw Object.assign(new Error("That person is no longer in your memories."), { status: 404 });
	const [[taken]] = await pool.query(
		"SELECT fact_uuid FROM athena_family_contact WHERE profile_id = ? AND contact_id = ? AND fact_uuid <> ?",
		[profileId, contactId, fact.uuid]
	);
	if (taken) throw bad("That contact is already linked to someone else. Unlink them there first.");
	let name = String(input.name || "").trim().slice(0, 160) || null;
	try {
		const book = await community.contactsFor(profileId);
		name = (book || []).find((c) => c.contactId === contactId)?.name || name;
	} catch { /* the name from the search a moment ago will do */ }
	await pool.query(
		`INSERT INTO athena_family_contact (profile_id, fact_uuid, contact_id, contact_name) VALUES (?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE contact_id = VALUES(contact_id), contact_name = VALUES(contact_name)`,
		[profileId, fact.uuid, contactId, name]
	);
	return overview(profileId);
}

async function unlinkContact(profileId, factUuid) {
	await pool.query("DELETE FROM athena_family_contact WHERE profile_id = ? AND fact_uuid = ?", [profileId, String(factUuid)]);
	return overview(profileId);
}

const notFound = () => Object.assign(new Error("That person is no longer in your memories."), { status: 404 });

async function ownFact(profileId, uuid) {
	const [[fact]] = await pool.query(
		`SELECT id, uuid, category, memory_key, memory_value FROM user_memory
		 WHERE profile_id = ? AND uuid = ? AND deleted_at IS NULL AND category IN (?)`,
		[profileId, String(uuid), FAMILY_CATEGORIES]
	);
	return fact || null;
}

/** Forget a remembered person or pet (the memory is soft-deleted, as everywhere) and drop their contact link. */
async function removePerson(profileId, factUuid) {
	const fact = await ownFact(profileId, factUuid);
	if (!fact) throw notFound();
	// Editor fields are separate memories under this person's key. Forget them too,
	// or a saved "display name" becomes a stray person after the parent is gone.
	const [rows] = await pool.query(
		'SELECT id, memory_key FROM user_memory WHERE profile_id = ? AND category = ? AND deleted_at IS NULL',
		[profileId, fact.category]
	);
	const key = fact.memory_key.trim().toLowerCase();
	const details = rows.filter((row) => row.id !== fact.id &&
		(row.memory_key.trim().toLowerCase().startsWith(`${key} `) || row.memory_key.trim().toLowerCase().startsWith(`${key}'s `)));
	for (const detail of details) {
		await pool.query('UPDATE user_memory SET deleted_at = NOW() WHERE id = ?', [detail.id]);
		memory.memoryEvents.emit('fact:deleted', { id: detail.id, profile_id: profileId });
	}
	await pool.query("UPDATE user_memory SET deleted_at = NOW() WHERE id = ?", [fact.id]);
	await pool.query("DELETE FROM athena_family_contact WHERE profile_id = ? AND fact_uuid = ?", [profileId, fact.uuid]);
	await pool.query("DELETE FROM athena_family_portrait WHERE profile_id = ? AND fact_uuid = ?", [profileId, fact.uuid]);
	memory.memoryEvents.emit("fact:deleted", { id: fact.id, profile_id: profileId });
	return overview(profileId);
}

/**
 * Fold one remembered person into another: what was said about them is kept on
 * the target (never dropped, never repeated), the Google Contact link moves
 * across if the target has none, and the duplicate is forgotten.
 */
async function mergePeople(profileId, fromUuid, intoUuid) {
	if (!fromUuid || !intoUuid || String(fromUuid) === String(intoUuid)) throw bad("Pick two different people to merge.");
	const [from, into] = await Promise.all([ownFact(profileId, fromUuid), ownFact(profileId, intoUuid)]);
	if (!from || !into) throw notFound();

	const had = (into.memory_value || "").trim();
	const add = (from.memory_value || "").trim();
	const merged = !add || had.toLowerCase().includes(add.toLowerCase()) ? had : had ? `${had}; ${add}` : add;
	if (merged !== had) {
		await pool.query("UPDATE user_memory SET memory_value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [merged.slice(0, 2000), into.id]);
	}

	const [[intoLink]] = await pool.query("SELECT id FROM athena_family_contact WHERE profile_id = ? AND fact_uuid = ?", [profileId, into.uuid]);
	if (intoLink) await pool.query("DELETE FROM athena_family_contact WHERE profile_id = ? AND fact_uuid = ?", [profileId, from.uuid]);
	else await pool.query("UPDATE athena_family_contact SET fact_uuid = ? WHERE profile_id = ? AND fact_uuid = ?", [into.uuid, profileId, from.uuid]);
	const [[intoPortrait]] = await pool.query('SELECT fact_uuid FROM athena_family_portrait WHERE profile_id = ? AND fact_uuid = ?', [profileId, into.uuid]);
	if (!intoPortrait) await pool.query('UPDATE athena_family_portrait SET fact_uuid = ? WHERE profile_id = ? AND fact_uuid = ?', [into.uuid, profileId, from.uuid]);
	else await pool.query('DELETE FROM athena_family_portrait WHERE profile_id = ? AND fact_uuid = ?', [profileId, from.uuid]);

	await pool.query("UPDATE user_memory SET deleted_at = NOW() WHERE id = ?", [from.id]);
	memory.memoryEvents.emit("fact:deleted", { id: from.id, profile_id: profileId });
	if (merged !== had) {
		memory.memoryEvents.emit("fact:written", { id: into.id, profile_id: profileId, category: into.category, memory_key: into.memory_key, memory_value: merged.slice(0, 2000) });
	}
	return overview(profileId);
}

module.exports = { overview, linkContact, unlinkContact, removePerson, mergePeople, setPortrait, isoDay };
