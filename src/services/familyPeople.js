const pool = require("../helpers/db");
const familyService = require("./family");
const community = require("./community");

/**
 * What the Family card knows about people beyond memories: the children on
 * the family's profiles (name, birthday) and the Google Contact, if any, the
 * person linked to a remembered family member. Everything here is the
 * caller's own; nothing accepts a caller-supplied profile. See
 * docs/capabilities/companion-dashboard.md.
 */

const FAMILY_CATEGORIES = ["person", "family", "pet"];
const bad = (message) => Object.assign(new Error(message), { status: 400 });

/** A DATE column as YYYY-MM-DD, whether the driver gave a string or a Date. */
function isoDay(value) {
	if (!value) return null;
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return null;
		const mm = String(value.getMonth() + 1).padStart(2, "0");
		const dd = String(value.getDate()).padStart(2, "0");
		return `${value.getFullYear()}-${mm}-${dd}`;
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
	const [children, { links, contactsLinked }] = await Promise.all([childrenOf(profileId), linksFor(profileId)]);
	return { children, links, contactsLinked };
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

module.exports = { overview, linkContact, unlinkContact, isoDay };
