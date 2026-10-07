const { randomUUID } = require("node:crypto");
const pool = require("../helpers/db");
const watch = require("./pulsepoint/watch");
const community = require("./community");

/**
 * Door-to-door safety checks. In an emergency the person walks their street
 * and marks each house safe / no answer / needs help.
 *
 * A round is one street, listed ahead of time (so the walk needs no signal)
 * from two places only: OpenStreetMap address points on that street, and the
 * person's own neighbour households. Addresses only - nobody is named,
 * guessed or looked up. The only thing sent off-server is the street name and
 * a point rounded to ~1 km, to the public Overpass API. Every status is the
 * person's own mark. See docs/capabilities/door-to-door.md.
 */

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
// Overpass refuses requests that do not say who is asking.
const USER_AGENT = "athena-community/1.0 (street list for a door-to-door safety check)";
const SEARCH_RADIUS_M = 2500;
const LOOKUP_TTL_MS = 60 * 60_000;
const MAX_DOORS = 400;
const MAX_ROUNDS = 25;
const STATUSES = new Set(["todo", "safe", "no_answer", "needs_help", "skipped"]);

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const notFound = () => Object.assign(new Error("That street check is no longer on your list."), { status: 404 });
const trim = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/** Words that end a street name; dropped so "Rushing Water" also finds "Rushing Water Ln". */
const SUFFIXES = new Set(["street", "st", "road", "rd", "lane", "ln", "drive", "dr", "avenue", "ave", "court", "ct", "circle", "cir", "trail", "trl", "boulevard", "blvd", "place", "pl", "highway", "hwy", "parkway", "pkwy", "terrace", "ter", "way", "loop", "run", "path", "pt", "point"]);

/** "148 Rushing Water Lane, Troutman, NC" -> "Rushing Water Lane". */
function streetOf(address) {
	const line = String(address || "").split(/,|\n/)[0].trim().replace(/^\d+[a-z]?\s+/i, "");
	return line.replace(/\s+/g, " ").slice(0, 120);
}

/** The name without its type, for matching: "Rushing Water Lane" -> "Rushing Water". */
function streetCore(street) {
	const words = String(street || "").trim().split(/\s+/).filter(Boolean);
	if (words.length > 1 && SUFFIXES.has(words[words.length - 1].toLowerCase().replace(/\./g, ""))) words.pop();
	return words.join(" ");
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\"]/g, "\\$&");

/** Odd numbers up one side, even numbers back down the other: the walk a person actually does. */
function walkOrder(a, b) {
	const na = parseInt(a, 10) || 0;
	const nb = parseInt(b, 10) || 0;
	const oddA = na % 2 === 1;
	const oddB = nb % 2 === 1;
	if (oddA !== oddB) return oddA ? -1 : 1;
	return oddA ? na - nb : nb - na;
}

const lookupCache = new Map();

/**
 * House numbers on a street from OpenStreetMap. `fetchImpl` is injectable for
 * tests. Returns [{ address, latitude, longitude }] in walking order.
 */
async function lookupStreet({ street, latitude, longitude }, fetchImpl = fetch) {
	const core = streetCore(street);
	if (core.length < 3) throw bad("I need the street's name to list it.");
	if (![latitude, longitude].every(Number.isFinite)) throw bad("That place has no location to search around.");
	// ~1 km of blur: the street is found by name, so the exact house is not needed.
	const lat = latitude.toFixed(2);
	const lon = longitude.toFixed(2);
	const key = `${core.toLowerCase()}|${lat}|${lon}`;
	const hit = lookupCache.get(key);
	if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.doors.map((d) => ({ ...d }));

	const re = `^${escapeRe(core)}`;
	const query = `[out:json][timeout:25];(node["addr:housenumber"]["addr:street"~"${re}",i](around:${SEARCH_RADIUS_M},${lat},${lon});way["addr:housenumber"]["addr:street"~"${re}",i](around:${SEARCH_RADIUS_M},${lat},${lon}););out tags center;`;
	let res;
	try {
		res = await fetchImpl(OVERPASS_URL, {
			method: "POST",
			headers: { "User-Agent": USER_AGENT, Accept: "*/*", "Content-Type": "application/x-www-form-urlencoded" },
			body: `data=${encodeURIComponent(query)}`,
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err) {
		throw Object.assign(new Error("I couldn't reach the map data just now. Try again in a minute, or add the houses by hand."), { status: 503, cause: err });
	}
	if (!res.ok) throw Object.assign(new Error("The map data is busy right now. Try again in a minute, or add the houses by hand."), { status: 503 });
	const body = await res.json();

	const found = new Map();
	for (const el of body.elements || []) {
		const number = trim(el.tags?.["addr:housenumber"], 20);
		const name = trim(el.tags?.["addr:street"], 120);
		if (!number || !name) continue;
		const address = `${number} ${name}`;
		const k = community.streetKey(address);
		if (!k || found.has(k)) continue;
		const at = el.center || el;
		found.set(k, { address, number, latitude: Number.isFinite(at.lat) ? at.lat : null, longitude: Number.isFinite(at.lon) ? at.lon : null });
	}
	const doors = [...found.values()].sort((a, b) => walkOrder(a.number, b.number)).map(({ address, latitude: la, longitude: lo }) => ({ address, latitude: la, longitude: lo }));
	lookupCache.set(key, { at: Date.now(), doors });
	if (lookupCache.size > 50) lookupCache.delete(lookupCache.keys().next().value);
	return doors.map((d) => ({ ...d }));
}

const toDoor = (row, household) => ({
	address: row.address,
	status: row.status,
	note: row.note || null,
	checkedAt: row.checked_at ? new Date(row.checked_at).toISOString() : null,
	household: household ? { name: household.name || null, contact: household.contact || null, notes: household.notes || null } : null,
});

async function householdsByKey(profileId) {
	const map = new Map();
	for (const n of await community.listNeighbors(profileId)) {
		const k = community.streetKey(n.address);
		if (k) map.set(k, n);
	}
	return map;
}

async function ownRound(profileId, uuid) {
	const [[round]] = await pool.query(
		"SELECT id, uuid, street, place_uuid, source, created_at, closed_at FROM athena_door_round WHERE profile_id = ? AND uuid = ?",
		[profileId, String(uuid)]
	);
	if (!round) throw notFound();
	return round;
}

async function describe(profileId, round) {
	const [rows] = await pool.query(
		"SELECT address, address_key, status, note, checked_at FROM athena_door_check WHERE round_id = ? ORDER BY position, id",
		[round.id]
	);
	const homes = await householdsByKey(profileId);
	return {
		uuid: round.uuid,
		street: round.street,
		placeUuid: round.place_uuid || null,
		source: round.source,
		createdAt: new Date(round.created_at).toISOString(),
		closedAt: round.closed_at ? new Date(round.closed_at).toISOString() : null,
		doors: rows.map((r) => toDoor(r, homes.get(r.address_key))),
	};
}

async function listRounds(profileId) {
	const [rounds] = await pool.query(
		`SELECT r.uuid, r.street, r.created_at, r.closed_at,
		        COUNT(c.id) AS total,
		        SUM(c.status <> 'todo') AS checked,
		        SUM(c.status = 'needs_help') AS needs_help
		 FROM athena_door_round r LEFT JOIN athena_door_check c ON c.round_id = r.id
		 WHERE r.profile_id = ? GROUP BY r.id ORDER BY r.created_at DESC LIMIT ?`,
		[profileId, MAX_ROUNDS]
	);
	return rounds.map((r) => ({
		uuid: r.uuid,
		street: r.street,
		total: Number(r.total),
		checked: Number(r.checked || 0),
		needsHelp: Number(r.needs_help || 0),
		createdAt: new Date(r.created_at).toISOString(),
		closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
	}));
}

/**
 * List a street ahead of time. The street comes from the person (or from the
 * place's address); the houses come from OpenStreetMap, plus any neighbour
 * household of theirs on that street the map is missing.
 */
async function startRound(profileId, input = {}, fetchImpl = fetch) {
	const places = await watch.listPlaces(profileId);
	const place = places.find((p) => p.uuid === input.placeUuid);
	if (!place) throw bad("Pick one of your points of interest to list a street near.");
	const street = trim(input.street, 120) || streetOf(place.address);
	if (!street) throw bad("That place has no street address. Type the street's name instead.");

	const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM athena_door_round WHERE profile_id = ?", [profileId]);
	if (n >= MAX_ROUNDS) throw bad(`You can keep up to ${MAX_ROUNDS} street checks. Delete an old one first.`);

	const doors = await lookupStreet({ street, latitude: place.latitude, longitude: place.longitude }, fetchImpl);
	// A household of theirs on this street that the map does not know is still a door.
	const have = new Set(doors.map((d) => community.streetKey(d.address)));
	const streetWords = ` ${community.streetKey(`1 ${street}`)?.replace(/^1 /, "") || ""}`;
	for (const home of await community.listNeighbors(profileId)) {
		const k = community.streetKey(home.address);
		if (k && !have.has(k) && k.replace(/^\S+/, "") === streetWords) {
			doors.push({ address: String(home.address).split(/,|\n/)[0].trim(), latitude: home.latitude, longitude: home.longitude });
			have.add(k);
		}
	}
	if (doors.length > MAX_DOORS) doors.length = MAX_DOORS;

	const uuid = randomUUID();
	const [res] = await pool.query(
		"INSERT INTO athena_door_round (uuid, profile_id, street, place_uuid, source) VALUES (?, ?, ?, ?, 'osm')",
		[uuid, profileId, street, place.uuid]
	);
	for (const [i, d] of doors.entries()) {
		await pool.query(
			"INSERT IGNORE INTO athena_door_check (round_id, profile_id, address, address_key, position) VALUES (?, ?, ?, ?, ?)",
			[res.insertId, profileId, d.address.slice(0, 160), community.streetKey(d.address), i]
		);
	}
	return getRound(profileId, uuid);
}

async function getRound(profileId, uuid) {
	return describe(profileId, await ownRound(profileId, uuid));
}

/** Add a house the map missed. */
async function addDoor(profileId, uuid, address) {
	const round = await ownRound(profileId, uuid);
	const line = trim(address, 160);
	const key = community.streetKey(line);
	if (!line || !key) throw bad("A house needs a number and a street, like \"152 Rushing Water Lane\".");
	const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM athena_door_check WHERE round_id = ?", [round.id]);
	if (n >= MAX_DOORS) throw bad("That street check is full.");
	await pool.query(
		"INSERT IGNORE INTO athena_door_check (round_id, profile_id, address, address_key, position) VALUES (?, ?, ?, ?, ?)",
		[round.id, profileId, line.split(/,|\n/)[0].trim(), key, 100000 + n]
	);
	return describe(profileId, round);
}

/**
 * Apply marks, in any order and any number: the phone queues them while it has
 * no signal and sends them together. A mark older than the one already kept
 * for that house loses, so a late flush never overwrites a newer answer.
 */
async function applyMarks(profileId, uuid, updates) {
	const round = await ownRound(profileId, uuid);
	const list = Array.isArray(updates) ? updates.slice(0, 500) : [];
	for (const u of list) {
		const key = community.streetKey(u?.address);
		if (!key) continue;
		if (!STATUSES.has(u.status)) throw bad("That isn't a status I know.");
		const at = u.at && !Number.isNaN(Date.parse(u.at)) ? new Date(Math.min(Date.parse(u.at), Date.now())) : new Date();
		await pool.query(
			`UPDATE athena_door_check SET status = ?, note = ?, checked_at = ?
			 WHERE round_id = ? AND address_key = ? AND (checked_at IS NULL OR checked_at <= ?)`,
			[u.status, trim(u.note, 500), u.status === "todo" ? null : at, round.id, key, at]
		);
	}
	return describe(profileId, round);
}

async function closeRound(profileId, uuid, closed = true) {
	const round = await ownRound(profileId, uuid);
	await pool.query("UPDATE athena_door_round SET closed_at = ? WHERE id = ?", [closed ? new Date() : null, round.id]);
	return getRound(profileId, uuid);
}

async function removeRound(profileId, uuid) {
	const round = await ownRound(profileId, uuid);
	await pool.query("DELETE FROM athena_door_check WHERE round_id = ?", [round.id]);
	await pool.query("DELETE FROM athena_door_round WHERE id = ?", [round.id]);
	return listRounds(profileId);
}

module.exports = { lookupStreet, streetOf, streetCore, walkOrder, listRounds, startRound, getRound, addDoor, applyMarks, closeRound, removeRound, STATUSES };
