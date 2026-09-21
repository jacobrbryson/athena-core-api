/**
 * Nearby emergencies -> telling the person.
 *
 *   watch.runOnce()             one pass: every watched profile, new incidents -> nudges
 *   watch.nearbyFor(profileId)  what is active near their places right now
 *   watch.promptBlock(profileId) the same, for Athena's own prompt
 *
 * ## Why nudges
 *
 * An incident becomes an `athena_nudge` row, which is the one thing every
 * delivery path in the app already understands: the companion shows pending
 * nudges in-app, `push.deliverNudge` fans out to Android, browser and SMS, and
 * the unique key on (profile, trigger, dedupe_key) guarantees the same batch
 * is never said twice, even if two passes race.
 *
 * ## Why not the initiative trigger registry
 *
 * Initiative runs every ten minutes, raises one observation per trigger per
 * pass, and has a model word every sentence. For "a tree is down across the
 * road you are about to drive" all three are wrong: too slow, one-at-a-time
 * during a storm that produces five at once, and a model call on the path of
 * something that must arrive whether or not a model is answering. The text
 * here is deterministic — the facts ARE the message.
 *
 * ## What is worth telling
 *
 * PulsePoint's `alertable` flag is NOT the gate. It marks Tree Down and
 * Hazardous Condition as non-alertable — reasonable for a county-wide CPR
 * app, wrong for "within three miles of my house", and it was exactly those
 * calls the owner watched pile up while Athena said nothing (2026-09-21).
 *
 * So: every locatable call inside a watched radius is told, except
 *   - medical calls (someone else's private emergency; also redacted to 0,0
 *     most of the time anyway), and
 *   - the pure-noise service codes in QUIET_CODES.
 * `alertable` still matters for one thing: it is what may break quiet hours.
 * A structure fire at 2am wakes you; a tree down at 2am waits for 6am.
 *
 * ## Where the places come from
 *
 * `athena_watch_place` — home, family members' houses, anywhere the person
 * asked to have watched, each with its own radius — plus the profile's most
 * recent phone location (athena_location_sample) when it is fresh, as a place
 * called "you". Deliberately the database and not config: a person adds their
 * mother's house from the app, not by redeploying.
 */
const { randomUUID, createHash } = require("node:crypto");
const pool = require("../../helpers/db");
const { fetchIncidents } = require("./fetch");
const normalise = require("./normalise");
const geo = require("./geo");

const TRIGGER_ID = "nearby_incident";
const AGENCY = process.env.PULSEPOINT_AGENCY || "EMS1681";
const DEFAULT_RADIUS_MILES = Number(process.env.PULSEPOINT_RADIUS_MILES) || 3;
/** A phone position older than this is where you were, not where you are. */
const LOCATION_FRESH_MS = 45 * 60 * 1000;
/** Fetch at most this often, however many callers ask. */
const CACHE_MS = 60 * 1000;
/** How far back "already told them about this one" is remembered. */
const SEEN_WINDOW_HOURS = 24;
/** An incident nudge stays worth reading for this long. */
const NUDGE_TTL_S = 3 * 60 * 60;

/** Codes that are real dispatches but never news to a neighbour. */
const QUIET_CODES = new Set(["LA", "PS", "IFT", "CPR", "ME", "MCI"]);
const QUIET_CATEGORIES = new Set(["Medical"]);

let cache = { at: 0, list: null, pending: null };

/** The county board, decoded and normalised, shared for CACHE_MS. */
async function board() {
	if (cache.list && Date.now() - cache.at < CACHE_MS) return cache.list;
	if (!cache.pending) {
		cache.pending = fetchIncidents(AGENCY)
			.then((payload) => {
				cache = { at: Date.now(), list: normalise.incidents(payload), pending: null };
				return cache.list;
			})
			.catch((error) => {
				cache.pending = null;
				throw error;
			});
	}
	return cache.pending;
}

const bad = (message) => Object.assign(new Error(message), { status: 400 });

function toPlace(row) {
	return {
		uuid: row.uuid,
		name: row.name,
		address: row.address || null,
		latitude: Number(row.latitude),
		longitude: Number(row.longitude),
		radiusMiles: Number(row.radius_miles) || DEFAULT_RADIUS_MILES,
		enabled: row.enabled === 1 || row.enabled === true,
	};
}

/** Every place this person has saved, enabled or not, for the API. */
async function listPlaces(profileId) {
	const [rows] = await pool.query(
		`SELECT uuid, name, address, latitude, longitude, radius_miles, enabled
		 FROM athena_watch_place WHERE profile_id = ? ORDER BY name = 'Home' DESC, name`,
		[profileId]
	);
	return rows.map(toPlace);
}

/**
 * Add or update a place by name. Coordinates are required: this service does
 * not geocode, so a caller that only has an address must resolve it first.
 */
async function savePlace(profileId, input = {}) {
	const name = typeof input.name === "string" ? input.name.trim().slice(0, 60) : "";
	if (!name) throw bad("Give the place a name, like Home or Mom's house.");
	const point = { latitude: Number(input.latitude), longitude: Number(input.longitude) };
	if (!geo.isPoint(point)) throw bad("That place needs a real latitude and longitude.");
	const radius = input.radiusMiles === undefined ? DEFAULT_RADIUS_MILES : Number(input.radiusMiles);
	if (!Number.isFinite(radius) || radius <= 0 || radius > 50) throw bad("Radius must be between 0 and 50 miles.");
	const address = typeof input.address === "string" && input.address.trim() ? input.address.trim().slice(0, 255) : null;
	const enabled = input.enabled === false ? 0 : 1;
	await pool.query(
		`INSERT INTO athena_watch_place (uuid, profile_id, name, address, latitude, longitude, radius_miles, enabled)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE address = VALUES(address), latitude = VALUES(latitude),
		   longitude = VALUES(longitude), radius_miles = VALUES(radius_miles), enabled = VALUES(enabled)`,
		[randomUUID(), profileId, name, address, point.latitude, point.longitude, radius, enabled]
	);
	return listPlaces(profileId);
}

async function removePlace(profileId, uuid) {
	await pool.query("DELETE FROM athena_watch_place WHERE profile_id = ? AND uuid = ?", [profileId, String(uuid)]);
	return listPlaces(profileId);
}

/** Enabled saved places, as points the radius check understands. */
async function savedPlaces(profileId) {
	return (await listPlaces(profileId)).filter((p) => p.enabled && geo.isPoint(p));
}

/** Where their phone last said it was, if that was recent enough to mean now. */
async function currentPosition(profileId) {
	try {
		const [rows] = await pool.query(
			`SELECT s.latitude, s.longitude, s.observed_at
			 FROM athena_location_sample s
			 JOIN athena_location_pref p ON p.profile_id = s.profile_id AND p.enabled = 1
			 WHERE s.profile_id = ?
			 ORDER BY s.observed_at DESC LIMIT 1`,
			[profileId]
		);
		const row = rows[0];
		if (!row || Date.now() - new Date(row.observed_at).getTime() > LOCATION_FRESH_MS) return null;
		const point = {
			name: "you",
			latitude: Number(row.latitude),
			longitude: Number(row.longitude),
			radiusMiles: DEFAULT_RADIUS_MILES,
			live: true,
		};
		return geo.isPoint(point) ? point : null;
	} catch {
		return null;
	}
}

async function placesFor(profileId) {
	const places = await savedPlaces(profileId);
	const here = await currentPosition(profileId);
	if (here) places.push(here);
	return places;
}

/** Is this call one a neighbour would want to hear about? */
function worthTelling(incident) {
	if (!incident.locatable) return false;
	if (QUIET_CODES.has(incident.code)) return false;
	if (incident.category && QUIET_CATEGORIES.has(incident.category)) return false;
	return true;
}

/** Active incidents near this person's places, nearest first, with the match. */
async function nearbyFor(profileId, { list = null, places = null } = {}) {
	const watched = places || (await placesFor(profileId));
	if (!watched.length) return [];
	const incidents = list || (await board());
	const out = [];
	for (const incident of incidents) {
		if (incident.status !== "active" || !worthTelling(incident)) continue;
		const matches = geo.placesNear(incident, watched, DEFAULT_RADIUS_MILES);
		if (matches.length) out.push({ incident, nearest: matches[0], matches });
	}
	return out.sort((a, b) => a.nearest.miles - b.nearest.miles);
}

/** "SHADY COVE RD & PERTH RD, TROUTMAN, NC" -> "Shady Cove Rd & Perth Rd". */
function street(address) {
	if (!address) return "an unknown address";
	const first = String(address).split(",")[0].trim();
	return first.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

/** "home", "Mom's", or "where you are". */
function placeName(place) {
	if (place.live) return "where you are";
	return place.name.toLowerCase() === "home" ? "home" : place.name;
}

function line(hit) {
	const { incident, nearest } = hit;
	const units = incident.units > 1 ? `, ${incident.units} units` : "";
	return `${incident.what} — ${street(incident.address)}, ${geo.describeDistance(nearest.miles)} from ${placeName(nearest.place)}${units}`;
}

/** The whole message. Deterministic on purpose — see the header. */
function wording(hits) {
	if (hits.length === 1) {
		const { incident, nearest } = hits[0];
		const units = incident.units > 1 ? ` (${incident.units} units)` : "";
		return `${incident.what} ${geo.describeDistance(nearest.miles)} from ${placeName(nearest.place)}: ${street(incident.address)}${units}.`.slice(0, 500);
	}
	const head = `${hits.length} new emergency calls near ${placeName(hits[0].nearest.place)}:`;
	return [head, ...hits.slice(0, 6).map((h) => `• ${line(h)}`), hits.length > 6 ? `…and ${hits.length - 6} more.` : null]
		.filter(Boolean)
		.join("\n")
		.slice(0, 500);
}

/** Incident ids already told to this person recently. */
async function alreadyTold(profileId) {
	const [rows] = await pool.query(
		`SELECT facts FROM athena_nudge
		 WHERE profile_id = ? AND trigger_id = ? AND created_at >= NOW() - INTERVAL ? HOUR`,
		[profileId, TRIGGER_ID, SEEN_WINDOW_HOURS]
	);
	const seen = new Set();
	for (const row of rows) {
		let facts = row.facts;
		if (typeof facts === "string") {
			try { facts = JSON.parse(facts); } catch { facts = null; }
		}
		for (const id of facts?.incidentIds || []) seen.add(String(id));
	}
	return seen;
}

async function quietNow(profileId) {
	try {
		const initiative = require("../initiative");
		const pref = await initiative.getPref(profileId);
		return initiative.inQuietHours(pref);
	} catch {
		return false;
	}
}

/**
 * One profile: find what is new, write one nudge for the batch, push it.
 * `dryRun` computes and returns the message without writing or sending.
 */
async function checkProfile(profileId, { dryRun = false, list = null } = {}) {
	const hits = await nearbyFor(profileId, { list });
	if (!hits.length) return { profileId, nearby: 0, told: 0 };

	const seen = await alreadyTold(profileId);
	const fresh = hits.filter((h) => !seen.has(h.incident.id));
	if (!fresh.length) return { profileId, nearby: hits.length, told: 0 };

	const text = wording(fresh);
	const ids = fresh.map((h) => h.incident.id).sort();
	const serious = fresh.some((h) => h.incident.alertable);
	if (dryRun) return { profileId, nearby: hits.length, told: fresh.length, text, serious, dryRun: true };

	const uuid = randomUUID();
	const dedupeKey = `pp:${createHash("sha1").update(ids.join(",")).digest("hex")}`;
	const facts = {
		agency: AGENCY,
		incidentIds: ids,
		incidents: fresh.map(({ incident, nearest }) => ({
			id: incident.id,
			code: incident.code,
			what: incident.what,
			address: incident.address,
			miles: Math.round(nearest.miles * 100) / 100,
			place: nearest.place.name,
			units: incident.units,
			receivedAt: incident.receivedAt,
			alertable: incident.alertable,
		})),
	};
	const [result] = await pool.query(
		`INSERT IGNORE INTO athena_nudge
			(uuid, profile_id, trigger_id, dedupe_key, urgency, text, facts, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
		[uuid, profileId, TRIGGER_ID, dedupeKey, serious ? "high" : "normal", text, JSON.stringify(facts), NUDGE_TTL_S]
	);
	if (!result.affectedRows) return { profileId, nearby: hits.length, told: 0, raced: true };

	// Quiet hours hold the push for routine calls; a PulsePoint-alertable one
	// (fire, wreck, gas, wires down) goes through. The nudge is written either
	// way, so the in-app card and Athena's awareness do not wait.
	let pushed = { sent: 0, skipped: "held for quiet hours" };
	if (serious || !(await quietNow(profileId))) {
		const push = require("../push");
		pushed = await push.deliverNudge(profileId, { uuid, text, trigger_id: TRIGGER_ID }).catch((error) => ({
			sent: 0,
			error: error.message,
		}));
	}
	return { profileId, nearby: hits.length, told: fresh.length, text, serious, pushed };
}

/** Every profile with a saved place or a live phone position. */
async function watchedProfiles() {
	const ids = new Set();
	const [saved] = await pool.query("SELECT DISTINCT profile_id FROM athena_watch_place WHERE enabled = 1");
	for (const row of saved) ids.add(Number(row.profile_id));
	try {
		const [rows] = await pool.query("SELECT profile_id FROM athena_location_pref WHERE enabled = 1");
		for (const row of rows) ids.add(Number(row.profile_id));
	} catch {
		/* location tables absent: saved places still work */
	}
	return [...ids];
}

/** One pass over everyone. Never throws for one profile's failure. */
async function runOnce({ dryRun = false } = {}) {
	const list = await board();
	const results = [];
	for (const profileId of await watchedProfiles()) {
		try {
			results.push(await checkProfile(profileId, { dryRun, list }));
		} catch (error) {
			results.push({ profileId, error: error.message });
		}
	}
	return { agency: AGENCY, active: list.filter((i) => i.status === "active").length, results };
}

/**
 * For Athena's prompt: what is happening near them right now, so "what are
 * all the sirens?" gets an answer and she can raise it herself mid-chat.
 * Short timeout — a slow PulsePoint must never slow a reply.
 */
async function promptBlock(profileId) {
	if (!profileId) return null;
	const places = await placesFor(profileId);
	if (!places.length) return null;
	const hits = await Promise.race([
		nearbyFor(profileId, { places }),
		new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
	]).catch(() => null);
	if (!hits || !hits.length) return null;
	return [
		"# Emergency calls near them right now",
		"",
		"Live from the county 911 dispatch board (PulsePoint, Iredell County).",
		"If they ask about sirens, the storm, road closures or anything happening",
		"nearby, this is what you know. If they have not heard about it and it",
		"could affect them (a road they use, near home), mention it briefly.",
		"Do not speculate beyond what is listed.",
		"",
		...hits.slice(0, 10).map((h) => {
			const at = h.incident.receivedAt
				? ` (dispatched ${Math.max(0, Math.round((Date.now() - h.incident.receivedAt.getTime()) / 60000))} min ago)`
				: "";
			return `- ${line(h)}${at}`;
		}),
	].join("\n");
}

module.exports = {
	TRIGGER_ID,
	runOnce,
	checkProfile,
	nearbyFor,
	promptBlock,
	placesFor,
	listPlaces,
	savePlace,
	removePlace,
	wording,
	worthTelling,
	_resetCache: () => {
		cache = { at: 0, list: null, pending: null };
	},
};
