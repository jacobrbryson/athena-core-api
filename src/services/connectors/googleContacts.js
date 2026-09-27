const { providerGet, isNotConnected } = require("./http");

/**
 * Google Contacts reads (People API, contacts.readonly).
 *
 * Read by the nightly dream, not per message: contacts are the person's
 * address book, and what makes them useful is linking them to the people
 * Athena already knows about — that is table work, and tables are built at
 * night (services/dreams). Nothing here writes; the scope couldn't anyway.
 */

const PROVIDER = "google_contacts";
const PAGE_SIZE = 1000;
// A guard against pathological address books, not a product limit.
const MAX_CONTACTS = 5000;

const PERSON_FIELDS = [
	"names",
	"nicknames",
	"emailAddresses",
	"phoneNumbers",
	"relations",
	"photos",
	"birthdays",
	"addresses",
	"organizations",
	"memberships",
].join(",");

const first = (list) => (Array.isArray(list) && list.length ? list.find((x) => x?.metadata?.primary) || list[0] : null);
const values = (list, pick) =>
	(Array.isArray(list) ? list : [])
		.map(pick)
		.filter((v) => v && Object.values(v).some(Boolean));

/** "people/c123456789" -> "123456789". Null for anything else. */
function contactId(resourceName) {
	const m = /^people\/c(\d{1,20})$/.exec(String(resourceName || ""));
	return m ? m[1] : null;
}

function birthday(list) {
	const b = first(list);
	if (!b) return null;
	if (b.date && b.date.month && b.date.day) {
		const mm = String(b.date.month).padStart(2, "0");
		const dd = String(b.date.day).padStart(2, "0");
		return b.date.year ? `${b.date.year}-${mm}-${dd}` : `--${mm}-${dd}`;
	}
	return b.text ? String(b.text).slice(0, 40) : null;
}

/** One People API person -> the flat shape the dream mirror stores. */
function normalize(person) {
	const id = contactId(person?.resourceName);
	if (!id) return null;
	const name = first(person.names);
	// A default "no photo" silhouette says nothing about the person.
	const photo = (person.photos || []).find((p) => p?.url && !p.default);
	const org = first(person.organizations);
	return {
		contactId: id,
		name: name?.displayName || [name?.givenName, name?.familyName].filter(Boolean).join(" ") || null,
		givenName: name?.givenName || null,
		familyName: name?.familyName || null,
		nicknames: values(person.nicknames, (n) => ({ value: n?.value || null })).map((n) => n.value),
		emails: values(person.emailAddresses, (e) => ({ value: e?.value || null, type: e?.formattedType || e?.type || null })),
		phones: values(person.phoneNumbers, (p) => ({
			value: p?.canonicalForm || p?.value || null,
			type: p?.formattedType || p?.type || null,
		})),
		// Relations are the contact's own relations as the person recorded them
		// ("spouse: Jane"), which is how a contact gets tied to family.
		relations: values(person.relations, (r) => ({ person: r?.person || null, type: r?.formattedType || r?.type || null })),
		addresses: values(person.addresses, (a) => ({
			value: a?.formattedValue ? String(a.formattedValue).replace(/\s+/g, " ") : null,
			type: a?.formattedType || a?.type || null,
		})),
		organization: org ? [org.title, org.name].filter(Boolean).join(", ") || null : null,
		birthday: birthday(person.birthdays),
		photoUrl: photo ? photo.url : null,
		groups: values(person.memberships, (m) => ({
			value: m?.contactGroupMembership?.contactGroupResourceName || null,
		}))
			.map((m) => m.value)
			.filter((g) => g !== "contactGroups/myContacts"),
		updatedAt: first(person.metadata?.sources)?.updateTime || null,
	};
}

/**
 * Every contact of this person, normalized. Null when Contacts isn't linked
 * (or the link is dead), so callers skip rather than catch.
 */
async function listContacts(profileId, { actor = "athena" } = {}) {
	const out = [];
	let pageToken;
	try {
		do {
			const data = await providerGet(profileId, PROVIDER, "/people/me/connections", {
				actor,
				query: {
					personFields: PERSON_FIELDS,
					pageSize: PAGE_SIZE,
					sortOrder: "LAST_MODIFIED_DESCENDING",
					...(pageToken ? { pageToken } : {}),
				},
			});
			for (const person of data?.connections || []) {
				const c = normalize(person);
				if (c) out.push(c);
			}
			pageToken = data?.nextPageToken;
		} while (pageToken && out.length < MAX_CONTACTS);
	} catch (err) {
		// Only "nothing usable is linked" (disconnected, or the grant refused
		// at refresh) means the address book is gone. An unreadable credential
		// or a 403 mid-read is a bad night, and a caller that mirrors contacts
		// must not read it as the person withdrawing them.
		if (isNotConnected(err) && err.reason === "absent") return null;
		throw err;
	}
	return out.slice(0, MAX_CONTACTS);
}

module.exports = { PROVIDER, PERSON_FIELDS, listContacts, normalize, contactId };
