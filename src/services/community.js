/**
 * Community — the place a person lives, as they describe it.
 *
 *   community.overview(profileId)     places, neighbours, events and local news, for the page
 *   community.saveNeighbor / removeNeighbor
 *   community.saveEvent / removeEvent
 *   community.promptBlock(profileId)  all of it, for Athena's chat prompt
 *
 * Three things, all typed by the person on the Community page:
 *
 *   - Points of interest are the watched places (athena_watch_place, owned by
 *     pulsepoint/watch.js). Every one is still watched for 911 calls and
 *     weather exactly as before; this file only reads them and their `kind`.
 *   - Neighbours: households, keyed on their address, so "the Hendersons"
 *     means something next time it comes up, and so the people next door are
 *     the first ones thought of when something happens on the street.
 *   - Local events: a church supper, a school fair, Ham Day. A `yearly` event
 *     comes round again, so last Saturday's Ham Day is next year's too.
 *
 * Local news is not fetched here. It is the headlines from the news pages the
 * person already has Athena reading, picked out when they mention a town or a
 * place on this list — so it is only ever as wide as their own reading list,
 * and adding a local paper there is how they widen it.
 *
 * Nothing here is inferred: no neighbour is guessed from contacts, no event
 * from email. A person who wants something on this page puts it there.
 *
 * A household can have any number of the person's Google Contacts LINKED to
 * it — picked by searching their own address book, or suggested because the
 * contact's Google address is the household's street line (contacts.readonly,
 * through the guarded connector adapter). A suggestion is only ever offered;
 * the person links it. A link keeps the contact's id and a display-name
 * snapshot (so the chat prompt can say "Bill and Carol" without calling
 * Google every turn); phone, email, address and photo are read from Google
 * each time, so an edit there shows up here and unlinking leaves nothing.
 * A contact lives at one household.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../helpers/db");
const watch = require("./pulsepoint/watch");
const news = require("./news");
const clock = require("./clock");
const googleContacts = require("./connectors/googleContacts");

const MAX_NEIGHBORS = 200;
const MAX_EVENTS = 200;
/** In the prompt, events this far back are "just happened". */
const RECENT_DAYS = 14;
/** ...and this far ahead are worth knowing about. */
const AHEAD_DAYS = 90;
const REPEATS = new Set(["none", "yearly"]);
/** An address book is read once per this, not once per keystroke. */
const CONTACTS_TTL_MS = 5 * 60_000;
const CONTACT_MATCHES = 8;
/** Enough for a big household; a guard, not a product limit. */
const MAX_CONTACTS_PER_HOUSEHOLD = 20;

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const trim = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const isDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));

/** Today, in the person's day (the default zone; profiles carry none yet). */
function today(now = new Date()) {
	return clock.describeNow(now).iso;
}

function addDays(iso, days) {
	const d = new Date(`${iso}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
	return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/**
 * The date that matters for an event today. A one-off is its own date. A
 * yearly one is this year's anniversary until it is more than RECENT_DAYS
 * past, then next year's — so a week after Ham Day it still reads as "last
 * Saturday", and by November it reads as next year's.
 */
function occurrence(event, todayIso = today()) {
	if (event.repeats !== "yearly") return { on: event.startsOn, endsOn: event.endsOn };
	const span = event.endsOn ? daysBetween(event.startsOn, event.endsOn) : 0;
	const md = event.startsOn.slice(5);
	let year = Number(todayIso.slice(0, 4));
	// The first year it happened is the floor: never invent one before it.
	year = Math.max(year, Number(event.startsOn.slice(0, 4)));
	let on = `${year}-${md}`;
	if (md === "02-29" && !isDate(on)) on = `${year}-02-28`;
	if (daysBetween(addDays(on, span), todayIso) > RECENT_DAYS) on = `${year + 1}-${md === "02-29" ? "02-28" : md}`;
	return { on, endsOn: span ? addDays(on, span) : null };
}

function toNeighbor(row) {
	return {
		uuid: row.uuid,
		name: row.name || null,
		address: row.address || null,
		latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
		longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
		placeUuid: row.place_uuid || null,
		where: row.where_text || null,
		contact: row.contact || null,
		notes: row.notes || null,
		contacts: [],
	};
}

/** Street-type and direction words, so "Lane" and "LN" are the same house. */
const STREET_WORDS = {
	street: "st", road: "rd", lane: "ln", drive: "dr", avenue: "ave", av: "ave", court: "ct", circle: "cir",
	trail: "trl", boulevard: "blvd", place: "pl", highway: "hwy", parkway: "pkwy", terrace: "ter",
	point: "pt", crossing: "xing", square: "sq", north: "n", south: "s", east: "e", west: "w",
	northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
};

/**
 * The key a household is stored under: the street line, normalized.
 * "152 Rushing Water Lane, Troutman NC" and "152 RUSHING WATER LN, TROUTMAN,
 * NC, 28166" -> "152 rushing water ln". Null without a house number — a
 * household is a house, and "the blue one" can't be told apart from the next.
 */
function streetKey(address) {
	const line = String(address || "").split(/,|\n/)[0].toLowerCase()
		.replace(/\b(apt|apartment|unit|suite|ste|#)\b.*$/, "")
		.replace(/[.#]/g, " ");
	const words = line.split(/\s+/).filter(Boolean).map((w) => STREET_WORDS[w] || w);
	if (words.length < 2 || !/^\d+[a-z]?$/.test(words[0])) return null;
	return words.join(" ").slice(0, 160);
}

async function listNeighbors(profileId) {
	const [rows] = await pool.query(
		`SELECT id, uuid, name, address, latitude, longitude, place_uuid, where_text, contact, notes
		 FROM athena_neighbor WHERE profile_id = ? ORDER BY COALESCE(name, address)`,
		[profileId]
	);
	const [links] = await pool.query(
		`SELECT neighbor_id, contact_id, contact_name FROM athena_neighbor_contact
		 WHERE profile_id = ? ORDER BY id`,
		[profileId]
	);
	const byId = new Map(rows.map((row) => [row.id, toNeighbor(row)]));
	for (const link of links) {
		byId.get(link.neighbor_id)?.contacts.push({ contactId: link.contact_id, name: link.contact_name || null });
	}
	return [...byId.values()];
}

const notFound = () => Object.assign(new Error("That neighbour is no longer on your list."), { status: 404 });

/** The contacts to link, as [{contactId, name}] — ids checked, duplicates dropped. */
function contactLinks(input) {
	const list = Array.isArray(input) ? input : [];
	if (list.length > MAX_CONTACTS_PER_HOUSEHOLD) throw bad(`A household can have up to ${MAX_CONTACTS_PER_HOUSEHOLD} contacts.`);
	const seen = new Map();
	for (const item of list) {
		const contactId = trim(typeof item === "string" ? item : item?.contactId, 20);
		if (!contactId || !/^\d{1,20}$/.test(contactId)) throw bad("That isn't a Google contact I can link.");
		if (!seen.has(contactId)) seen.set(contactId, trim(item?.name, 160));
	}
	return [...seen].map(([contactId, name]) => ({ contactId, name }));
}

/**
 * Add (no uuid) or edit (uuid) one household. The address is required and is
 * the key; `contacts` is the whole set of linked Google contacts and replaces
 * whatever was linked before.
 */
async function saveNeighbor(profileId, input = {}) {
	const address = trim(input.address, 255);
	if (!address) throw bad("Add the household's address — a neighbour is kept by their house.");
	const key = streetKey(address);
	if (!key) throw bad("Start the address with the house number and street, like 152 Rushing Water Ln.");
	const latitude = Number(input.latitude);
	const longitude = Number(input.longitude);
	const located = Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
	const links = contactLinks(input.contacts);
	const values = [
		trim(input.name, 120),
		address,
		key,
		located ? latitude : null,
		located ? longitude : null,
		trim(input.placeUuid, 36),
		trim(input.where, 160),
		trim(input.contact, 120),
		trim(input.notes, 500),
	];

	const uuid = trim(input.uuid, 36);
	let neighborId;
	try {
		if (uuid) {
			const [[row]] = await pool.query("SELECT id FROM athena_neighbor WHERE profile_id = ? AND uuid = ?", [profileId, uuid]);
			if (!row) throw notFound();
			neighborId = row.id;
			await pool.query(
				`UPDATE athena_neighbor SET name = ?, address = ?, address_key = ?, latitude = ?, longitude = ?,
				   place_uuid = ?, where_text = ?, contact = ?, notes = ?
				 WHERE profile_id = ? AND id = ?`,
				[...values, profileId, neighborId]
			);
		} else {
			const [[count]] = await pool.query("SELECT COUNT(*) AS n FROM athena_neighbor WHERE profile_id = ?", [profileId]);
			if (Number(count?.n) >= MAX_NEIGHBORS) throw bad(`I can keep up to ${MAX_NEIGHBORS} households.`);
			const [result] = await pool.query(
				`INSERT INTO athena_neighbor
				   (uuid, profile_id, name, address, address_key, latitude, longitude, place_uuid, where_text, contact, notes)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[randomUUID(), profileId, ...values]
			);
			neighborId = result.insertId;
		}
	} catch (err) {
		if (err?.code === "ER_DUP_ENTRY") throw bad(`You already have a household at ${address.split(",")[0]} — edit that one instead.`);
		throw err;
	}
	await setContacts(profileId, neighborId, links);
	return neighborsForPage(profileId);
}

/**
 * Make the household's linked contacts exactly `links`. A contact already at
 * another household is refused by name and address rather than silently
 * moved — moving someone is an unlink there and a link here.
 */
async function setContacts(profileId, neighborId, links) {
	if (links.length) {
		const [elsewhere] = await pool.query(
			`SELECT c.contact_id, c.contact_name, n.name, n.address FROM athena_neighbor_contact c
			 JOIN athena_neighbor n ON n.id = c.neighbor_id
			 WHERE c.profile_id = ? AND c.neighbor_id <> ? AND c.contact_id IN (?)`,
			[profileId, neighborId, links.map((l) => l.contactId)]
		);
		if (elsewhere.length) {
			const e = elsewhere[0];
			const who = links.find((l) => l.contactId === e.contact_id)?.name || e.contact_name || "That contact";
			throw bad(`${who} is already linked to ${e.name || String(e.address || "another household").split(",")[0]}. Unlink them there first.`);
		}
	}
	// Names from Google when the address book can be read; the caller's
	// otherwise (it came from the same search a moment ago).
	let book = null;
	try { book = links.length ? await contactsFor(profileId) : null; } catch { book = null; }
	const names = new Map((book || []).map((c) => [c.contactId, c.name]));
	const keep = links.map((l) => l.contactId);
	await pool.query(
		`DELETE FROM athena_neighbor_contact WHERE profile_id = ? AND neighbor_id = ?${keep.length ? " AND contact_id NOT IN (?)" : ""}`,
		keep.length ? [profileId, neighborId, keep] : [profileId, neighborId]
	);
	for (const link of links) {
		await pool.query(
			`INSERT INTO athena_neighbor_contact (neighbor_id, profile_id, contact_id, contact_name) VALUES (?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE contact_name = COALESCE(VALUES(contact_name), contact_name)`,
			[neighborId, profileId, link.contactId, names.get(link.contactId) || link.name || null]
		);
	}
}

async function removeNeighbor(profileId, uuid) {
	const [[row]] = await pool.query("SELECT id FROM athena_neighbor WHERE profile_id = ? AND uuid = ?", [profileId, String(uuid)]);
	if (row) {
		await pool.query("DELETE FROM athena_neighbor_contact WHERE profile_id = ? AND neighbor_id = ?", [profileId, row.id]);
		await pool.query("DELETE FROM athena_neighbor WHERE profile_id = ? AND id = ?", [profileId, row.id]);
	}
	return neighborsForPage(profileId);
}

function toEvent(row, todayIso) {
	const event = {
		uuid: row.uuid,
		title: row.title,
		startsOn: row.starts_on,
		endsOn: row.ends_on || null,
		time: row.time_text || null,
		placeUuid: row.place_uuid || null,
		location: row.location_text || null,
		repeats: row.repeats === "yearly" ? "yearly" : "none",
		url: row.url || null,
		notes: row.notes || null,
	};
	const next = occurrence(event, todayIso);
	return { ...event, nextOn: next.on, nextEndsOn: next.endsOn };
}

/** Every event, soonest next occurrence first; the ones long past last. */
async function listEvents(profileId, todayIso = today()) {
	const [rows] = await pool.query(
		`SELECT uuid, title, DATE_FORMAT(starts_on, '%Y-%m-%d') AS starts_on,
		   DATE_FORMAT(ends_on, '%Y-%m-%d') AS ends_on, time_text, place_uuid, location_text, repeats, url, notes
		 FROM athena_community_event WHERE profile_id = ?`,
		[profileId]
	);
	const events = rows.map((row) => toEvent(row, todayIso));
	const past = (e) => (e.nextEndsOn || e.nextOn) < todayIso;
	return events.sort((a, b) => {
		if (past(a) !== past(b)) return past(a) ? 1 : -1;
		// Upcoming: soonest first. Past: most recent first.
		return past(a) ? b.nextOn.localeCompare(a.nextOn) : a.nextOn.localeCompare(b.nextOn);
	});
}

/** Add (no uuid) or edit (uuid) one event. */
async function saveEvent(profileId, input = {}) {
	const title = trim(input.title, 160);
	if (!title) throw bad("Give the event a name, like Ham Day.");
	if (!isDate(input.startsOn)) throw bad("Pick the day it happens.");
	const endsOn = input.endsOn ? String(input.endsOn) : null;
	if (endsOn && (!isDate(endsOn) || endsOn < input.startsOn)) throw bad("The last day can't be before the first.");
	const repeats = REPEATS.has(input.repeats) ? input.repeats : "none";
	const url = trim(input.url, 500);
	if (url && !/^https?:\/\//i.test(url)) throw bad("A link needs to start with http:// or https://.");
	const values = [
		title,
		input.startsOn,
		endsOn && endsOn !== input.startsOn ? endsOn : null,
		trim(input.time, 60),
		trim(input.placeUuid, 36),
		trim(input.location, 160),
		repeats,
		url,
		trim(input.notes, 500),
	];
	const uuid = trim(input.uuid, 36);
	if (uuid) {
		const [result] = await pool.query(
			`UPDATE athena_community_event SET title = ?, starts_on = ?, ends_on = ?, time_text = ?, place_uuid = ?,
			   location_text = ?, repeats = ?, url = ?, notes = ?
			 WHERE profile_id = ? AND uuid = ?`,
			[...values, profileId, uuid]
		);
		if (!result.affectedRows) throw Object.assign(new Error("That event is no longer on your list."), { status: 404 });
	} else {
		const [[count]] = await pool.query("SELECT COUNT(*) AS n FROM athena_community_event WHERE profile_id = ?", [profileId]);
		if (Number(count?.n) >= MAX_EVENTS) throw bad(`I can keep up to ${MAX_EVENTS} events.`);
		await pool.query(
			`INSERT INTO athena_community_event
			   (uuid, profile_id, title, starts_on, ends_on, time_text, place_uuid, location_text, repeats, url, notes)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[randomUUID(), profileId, ...values]
		);
	}
	return listEvents(profileId);
}

async function removeEvent(profileId, uuid) {
	await pool.query("DELETE FROM athena_community_event WHERE profile_id = ? AND uuid = ?", [profileId, String(uuid)]);
	return listEvents(profileId);
}

// --- Google Contacts --------------------------------------------------------

const contactCache = new Map(); // profileId -> { at, list }

/**
 * The person's address book, normalized, or null when Google Contacts isn't
 * linked. Cached briefly per person: the search box asks on every pause, and
 * the page asks again after every edit.
 */
async function contactsFor(profileId) {
	const hit = contactCache.get(profileId);
	if (hit && Date.now() - hit.at < CONTACTS_TTL_MS) return hit.list;
	const list = await googleContacts.listContacts(profileId);
	contactCache.set(profileId, { at: Date.now(), list });
	return list;
}

/** What the page shows for a linked contact. Only what a neighbour card needs. */
function contactCard(c) {
	return {
		contactId: c.contactId,
		name: c.name,
		phone: c.phones?.[0]?.value || null,
		email: c.emails?.[0]?.value || null,
		address: c.addresses?.[0]?.value || null,
		photoUrl: c.photoUrl || null,
	};
}

const digits = (value) => String(value || "").replace(/\D/g, "");

/** contactId -> the household it is linked to, for "already at …" notes. */
async function linkedHouseholds(profileId) {
	const [rows] = await pool.query(
		`SELECT c.contact_id, n.uuid, n.name, n.address FROM athena_neighbor_contact c
		 JOIN athena_neighbor n ON n.id = c.neighbor_id WHERE c.profile_id = ?`,
		[profileId]
	);
	return new Map(rows.map((r) => [r.contact_id, { uuid: r.uuid, label: r.name || String(r.address || "").split(",")[0] || null }]));
}

const withLinkedTo = (card, linked) => {
	const at = linked.get(card.contactId);
	return at ? { ...card, linkedTo: at } : card;
};

/**
 * Search the person's own contacts by name, nickname, email or phone, for the
 * "link a Google contact" box. `linked: false` means Contacts isn't connected,
 * which the page turns into a Connect button. A contact already at a household
 * says which (`linkedTo`).
 */
async function searchContacts(profileId, query) {
	const q = String(query || "").trim().toLowerCase().slice(0, 80);
	const list = await contactsFor(profileId);
	if (list === null) return { linked: false, matches: [] };
	if (q.length < 2) return { linked: true, matches: [] };
	const qDigits = digits(q);
	const score = (c) => {
		const names = [c.name, c.givenName, c.familyName, ...(c.nicknames || [])].filter(Boolean).map((n) => n.toLowerCase());
		if (names.some((n) => n.startsWith(q))) return 3;
		if (names.some((n) => n.includes(q))) return 2;
		if ((c.emails || []).some((e) => String(e.value).toLowerCase().includes(q))) return 1;
		if (qDigits.length >= 4 && (c.phones || []).some((p) => digits(p.value).includes(qDigits))) return 1;
		return 0;
	};
	const linked = await linkedHouseholds(profileId);
	const matches = list
		.map((c) => ({ c, s: score(c) }))
		.filter((x) => x.s > 0 && x.c.name)
		.sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name))
		.slice(0, CONTACT_MATCHES)
		.map((x) => withLinkedTo(contactCard(x.c), linked));
	return { linked: true, matches };
}

/**
 * Contacts whose Google address is this household's street line — offered as
 * suggestions when an address is entered. Never linked by this function.
 */
async function contactsAtAddress(profileId, address) {
	const key = streetKey(address);
	const list = await contactsFor(profileId);
	if (list === null) return { linked: false, matches: [] };
	if (!key) return { linked: true, matches: [] };
	const linked = await linkedHouseholds(profileId);
	const matches = list
		.filter((c) => c.name && (c.addresses || []).some((a) => streetKey(a.value) === key))
		.sort((a, b) => a.name.localeCompare(b.name))
		.slice(0, MAX_CONTACTS_PER_HOUSEHOLD)
		.map((c) => withLinkedTo(contactCard(c), linked));
	return { linked: true, matches };
}

/**
 * Households with each linked contact's current details. A contact that can't
 * be read right now (Google down, link expired) keeps its snapshot name and is
 * marked, so the page can say why — a link is never dropped because of a bad
 * moment. A name that changed in Google refreshes the snapshot.
 */
async function withContacts(profileId, neighbors) {
	if (!neighbors.some((n) => n.contacts.length)) return { neighbors, contactsLinked: null };
	const mark = (status) => neighbors.map((n) => ({ ...n, contacts: n.contacts.map((c) => ({ ...c, card: null, status })) }));
	let list;
	try {
		list = await contactsFor(profileId);
	} catch (err) {
		console.warn("[community] contacts unavailable:", err.message);
		return { neighbors: mark("unreadable"), contactsLinked: null };
	}
	if (list === null) return { neighbors: mark("not_connected"), contactsLinked: false };
	const byId = new Map(list.map((c) => [c.contactId, c]));
	const renamed = [];
	const out = neighbors.map((n) => ({
		...n,
		contacts: n.contacts.map((link) => {
			const c = byId.get(link.contactId);
			if (!c) return { ...link, card: null, status: "missing" };
			if (c.name && c.name !== link.name) renamed.push([c.name.slice(0, 160), link.contactId]);
			return { ...link, name: c.name || link.name, card: contactCard(c), status: "ok" };
		}),
	}));
	for (const [name, contactId] of renamed) {
		pool.query("UPDATE athena_neighbor_contact SET contact_name = ? WHERE profile_id = ? AND contact_id = ?", [name, profileId, contactId])
			.catch((err) => console.warn("[community] contact name refresh failed:", err.message));
	}
	return { neighbors: out, contactsLinked: true };
}

/** After a save: the list the page shows, with links filled in. */
async function neighborsForPage(profileId) {
	return (await withContacts(profileId, await listNeighbors(profileId))).neighbors;
}

/**
 * "148 RUSHING WATER LN, TROUTMAN, NC, 28166" -> "Troutman". The town is the
 * part before the two-letter state, which is how the Census geocoder (and most
 * people) write an address.
 */
function townOf(address) {
	if (!address) return null;
	const parts = String(address).split(",").map((p) => p.trim()).filter(Boolean);
	const state = parts.findIndex((p, i) => i > 0 && /^[A-Za-z]{2}(\s+\d{5}(-\d{4})?)?$/.test(p));
	const town = state > 0 ? parts[state - 1] : null;
	if (!town || /\d/.test(town)) return null;
	return town.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

/** Names on this list too ordinary to search a headline for. */
const GENERIC = new Set(["home", "work", "school", "church", "the park", "park", "office", "mom's", "dad's"]);

/**
 * What to look for in a headline: each place's town, and the place's own
 * name when it is distinctive enough to mean that place ("Troutman ARP
 * Church", not "Home").
 */
function localTerms(places) {
	const terms = new Map(); // lowercased term -> the place it points at
	for (const place of places) {
		const town = townOf(place.address);
		if (town && !terms.has(town.toLowerCase())) terms.set(town.toLowerCase(), { term: town, place: place.name });
		const name = String(place.name || "").trim();
		if (name.length >= 5 && !GENERIC.has(name.toLowerCase()) && !terms.has(name.toLowerCase())) {
			terms.set(name.toLowerCase(), { term: name, place: place.name });
		}
	}
	return [...terms.values()];
}

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Headlines from the person's own reading list that mention their places. */
function pickLocal(items, places, limit = 12) {
	const terms = localTerms(places).map((t) => ({ ...t, re: new RegExp(`\\b${escapeRe(t.term)}\\b`, "i") }));
	if (!terms.length) return [];
	const out = [];
	for (const item of items || []) {
		const text = `${item.title || ""} ${item.summary || ""}`;
		const hit = terms.find((t) => t.re.test(text));
		if (hit) out.push({ ...item, matched: hit.term });
		if (out.length >= limit) break;
	}
	return out;
}

async function localNews(profileId, places) {
	try {
		const { items } = await news.getNews(profileId);
		return pickLocal(items, places);
	} catch (err) {
		console.warn("[community] local news unavailable:", err.message);
		return null;
	}
}

/** Everything the Community page shows, in one read. */
async function overview(profileId) {
	const places = await watch.listPlaces(profileId);
	const [listed, events, local] = await Promise.all([
		listNeighbors(profileId),
		listEvents(profileId),
		localNews(profileId, places),
	]);
	const { neighbors } = await withContacts(profileId, listed);
	return { places, neighbors, events, localNews: local, kinds: [...watch.PLACE_KINDS] };
}

const KIND_WORDS = {
	home: "home",
	family: "family's home",
	neighborhood: "neighbourhood",
	church: "church",
	school: "school",
	town: "town",
	work: "work",
	business: "local business",
	park: "park",
	other: null,
};

function when(event, todayIso) {
	const on = event.nextOn;
	const delta = daysBetween(todayIso, on);
	const date = new Date(`${on}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
	const rel = delta === 0 ? "today" : delta === 1 ? "tomorrow" : delta === -1 ? "yesterday" : delta < 0 ? `${-delta} days ago` : `in ${delta} days`;
	return `${date} (${rel})${event.nextEndsOn ? ` through ${event.nextEndsOn}` : ""}${event.time ? `, ${event.time}` : ""}`;
}

/**
 * The person's community, for every adult conversation. The owner asked for
 * Athena to always be aware of this, so it is not gated on the message being
 * about it — but it is capped, so a long neighbour list never crowds out the
 * conversation it rides along with.
 */
async function promptBlock(profileId, now = new Date()) {
	const todayIso = today(now);
	const places = await watch.listPlaces(profileId).catch(() => []);
	const [neighbors, events] = await Promise.all([
		listNeighbors(profileId).catch(() => []),
		listEvents(profileId, todayIso).catch(() => []),
	]);
	if (!places.length && !neighbors.length && !events.length) return null;
	const placeName = new Map(places.map((p) => [p.uuid, p.name]));
	const lines = ["# Their community", "", "What this person has told you about where they live. They keep it on the Community page; treat it as theirs and current."];

	if (places.length) {
		lines.push("", "Points of interest (each is also watched for 911 calls and weather warnings within its ring):");
		for (const p of places.slice(0, 25)) {
			const kind = KIND_WORDS[p.kind];
			const bits = [kind && kind !== p.name.toLowerCase() ? kind : null, p.address, `${p.radiusMiles} mi ring`, p.enabled ? null : "paused"].filter(Boolean);
			lines.push(`- ${p.name} (${bits.join("; ")})${p.notes ? ` — ${p.notes}` : ""}`);
		}
	}
	if (neighbors.length) {
		lines.push("", "Neighbours (households):");
		for (const n of neighbors.slice(0, 40)) {
			const street = n.address ? n.address.split(",")[0] : null;
			const where = [n.where, n.placeUuid && placeName.get(n.placeUuid) ? `near ${placeName.get(n.placeUuid)}` : null].filter(Boolean).join(", ");
			const people = n.contacts.map((c) => c.name).filter(Boolean);
			const label = n.name || (people.length ? people.join(" & ") : street || "A household");
			const bits = [street && street !== label ? street : null, where || null].filter(Boolean).join("; ");
			lines.push(`- ${label}${bits ? ` (${bits})` : ""}${people.length ? ` [${n.name ? `${people.join(", ")} — ` : ""}in their Google Contacts]` : ""}${n.notes ? ` — ${n.notes}` : ""}`);
		}
		if (neighbors.length > 40) lines.push(`- …and ${neighbors.length - 40} more on their list.`);
	}
	const relevant = events.filter((e) => {
		const delta = daysBetween(todayIso, e.nextOn);
		return delta >= -RECENT_DAYS && delta <= AHEAD_DAYS;
	});
	if (relevant.length) {
		const upcoming = relevant.filter((e) => (e.nextEndsOn || e.nextOn) >= todayIso);
		const recent = relevant.filter((e) => (e.nextEndsOn || e.nextOn) < todayIso);
		const line = (e) => {
			const where = e.location || (e.placeUuid && placeName.get(e.placeUuid)) || null;
			return `- ${e.title} — ${when(e, todayIso)}${where ? ` at ${where}` : ""}${e.repeats === "yearly" ? " (every year)" : ""}${e.notes ? ` — ${e.notes}` : ""}`;
		};
		if (upcoming.length) lines.push("", "Coming up locally:", ...upcoming.slice(0, 15).map(line));
		if (recent.length) lines.push("", "Just happened:", ...recent.slice(0, 8).map(line));
	}
	lines.push(
		"",
		"Use this the way a well-connected neighbour would: know who and what they mean without asking, mention a local event when it genuinely fits (a free Saturday, a question about plans), and think of the people next door when something happens near home. Don't recite the list, don't bring it up in unrelated conversations, and never share a neighbour's details with anyone else. If they tell you about a new neighbour, place or event, suggest adding it on the Community page so you keep it."
	);
	return lines.join("\n");
}

module.exports = {
	overview,
	listNeighbors,
	saveNeighbor,
	removeNeighbor,
	searchContacts,
	contactsAtAddress,
	streetKey,
	listEvents,
	saveEvent,
	removeEvent,
	promptBlock,
	occurrence,
	townOf,
	pickLocal,
	MAX_NEIGHBORS,
	MAX_EVENTS,
};
