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
 * during a storm that produces five at once, and a model call that can fail
 * the whole thing. Here the model is asked once per CHANGE in the situation,
 * with a time bound, and a rules floor underneath it: it decides how loud and
 * what to say, never whether (see floorLevel), and when it does not answer the
 * rules' own wording goes out instead.
 *
 * ## One situation, every surface
 *
 * Each pass stores the assessed situation in athena_incident_situation. The
 * in-app banner (GET /dashboard/alert), Athena's chat prompt and the nudge text
 * all read that one judgement, so the app, the text message and the
 * conversation never disagree about how serious it is.
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
 * `alertable` still feeds the level (see floorLevel): any serious call, or two
 * or more calls of any kind, is URGENT, and urgent is what breaks quiet hours.
 * A lone tree down at 2am waits for 6am; a fire, or a storm's worth of calls,
 * wakes you.
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

/** The whole message, without a model. The floor every other path falls back to. */
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

// ---------------------------------------------------------------------------
// The situation: how serious, in one judgement every surface shares
// ---------------------------------------------------------------------------

const LEVELS = ["none", "watch", "urgent"];
const rank = (level) => Math.max(0, LEVELS.indexOf(level));
const higher = (a, b) => (rank(a) >= rank(b) ? a : b);
/** A model that does not answer in this long is treated as not answering. */
const MODEL_TIMEOUT_MS = 25_000;

/**
 * The level the model is not allowed to go under.
 *
 * The owner's rule, after a night of trees down and a structure fire within
 * two miles while Athena said nothing (2026-09-21): more than one active call
 * near home, or any serious one, is URGENT — full stop. The model decides how
 * to say it and may raise the level; it may never talk it down, because a
 * model that is "not sure it's a big deal" is exactly the failure being fixed.
 */
function floorLevel(hits) {
	if (!hits.length) return "none";
	if (hits.length >= 2 || hits.some((h) => h.incident.alertable)) return "urgent";
	return "watch";
}

const minutesAgo = (date) =>
	date instanceof Date && !Number.isNaN(date.getTime())
		? Math.max(0, Math.round((Date.now() - date.getTime()) / 60000))
		: null;

/** What the model is shown: the calls, as facts, and nothing it could mistake for an instruction. */
function sheet(hits, countyActive) {
	return {
		countyWideActiveCalls: countyActive,
		nearbyActiveCalls: hits.map(({ incident, nearest }) => ({
			what: incident.what,
			category: incident.category,
			where: street(incident.address),
			milesAway: Math.round(nearest.miles * 10) / 10,
			nearestWatchedPlace: placeName(nearest.place),
			unitsResponding: incident.units,
			dispatchedMinutesAgo: minutesAgo(incident.receivedAt),
			seriousByDispatchStandards: incident.alertable,
		})),
	};
}

const PROMPT = (facts, floor) =>
	"You are Athena, looking after the person you live with. Below is what the county 911 " +
	"dispatch board says is happening near their home and the places they asked you to watch, " +
	"right now.\n\n" +
	JSON.stringify(facts, null, 1) +
	"\n\nDecide how loudly to tell them, then write it.\n" +
	`- level: "none", "watch" or "urgent". It must be at least "${floor}". Ongoing emergencies ` +
	"close to home are a big deal to this person: they would rather be told too loudly than " +
	"find out later that they had no clue.\n" +
	"- headline: at most 8 words. Plain, specific, no exclamation marks.\n" +
	"- body: at most 45 words, spoken to them directly. Say what is happening and how close. " +
	"With three calls or fewer, mention every one by what and street; with more, give the count " +
	"and the nearest. If several calls share a cause you can see in the list (e.g. many trees " +
	"down), say so plainly. You may add one practical suggestion only if it follows directly " +
	"from the list (e.g. avoid a named street with a call on it). Do not invent anything that is " +
	"not in the list — no injuries, causes, advice about other roads, or closures it does not state.\n\n" +
	'Reply as JSON: {"level":"...","headline":"...","body":"..."}';

function fallbackAssessment(hits) {
	const level = floorLevel(hits);
	if (level === "none") return { level, headline: null, body: null, assessedBy: "rules" };
	const place = placeName(hits[0].nearest.place);
	const headline =
		hits.length === 1 ? `${hits[0].incident.what} near ${place}` : `${hits.length} emergencies near ${place}`;
	return { level, headline, body: wording(hits).slice(0, 1000), assessedBy: "rules" };
}

/** The first distinctive word of each street, for checking the model named them. */
function streetMarks(hits) {
	return hits.map(
		(h) =>
			street(h.incident.address)
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.find((w) => w.length > 2 && /[a-z]/.test(w)) || ""
	);
}

/**
 * Is this answer good enough to send? Returning a string rejects it, and the
 * model router then tries the next tier — which is how a lazy answer from a
 * small local model ("Fire near home", dropping the second call) is replaced
 * by a stronger one instead of reaching someone's phone.
 */
function checkAnswer(p, marks = []) {
	if (!LEVELS.includes(p?.level) || typeof p?.headline !== "string" || typeof p?.body !== "string") {
		return "need level, headline and body";
	}
	if (marks.length <= 3) {
		const body = p.body.toLowerCase();
		const missing = marks.filter((m) => m && !body.includes(m));
		if (missing.length) return `body must mention every call; missing: ${missing.join(", ")}`;
	}
	return true;
}

/** The real model call, through the same access gate every model call passes. */
async function generateWithModel(prompt, marks = []) {
	await require("../../security/access").assertModelAccess();
	const llm = require("../llm");
	return llm.generateJson({
		task: "json",
		contents: [{ role: "user", parts: [{ text: prompt }] }],
		check: (p) => checkAnswer(p, marks),
	});
}

/**
 * The model's judgement of the situation, floored by the rules and bounded in
 * time. Never throws and never returns less than the floor: an emergency alert
 * must go out whether or not a model is answering tonight.
 */
async function assess(hits, { countyActive = null, generate = generateWithModel } = {}) {
	const fallback = fallbackAssessment(hits);
	if (!hits.length) return fallback;
	const floor = floorLevel(hits);
	let timer;
	try {
		const result = await Promise.race([
			generate(PROMPT(sheet(hits, countyActive), floor), streetMarks(hits)),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("model timed out")), MODEL_TIMEOUT_MS);
			}),
		]);
		const data = result?.data || {};
		const headline = String(data.headline || "").trim().replace(/[.!]+$/, "").slice(0, 200);
		const body = String(data.body || "").trim().slice(0, 1000);
		if (!headline || !body) return fallback;
		return { level: higher(LEVELS.includes(data.level) ? data.level : floor, floor), headline, body, assessedBy: result.model || "model" };
	} catch (error) {
		console.warn("[pulsepoint] assessment fell back to rules:", error.message);
		return fallback;
	} finally {
		clearTimeout(timer);
	}
}

function parseJson(value) {
	if (value && typeof value === "object") return value;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

/** The stored situation for one person, or a quiet default. */
async function getSituation(profileId) {
	const [rows] = await pool.query(
		`SELECT level, headline, body, incidents, incident_key, assessed_by, started_at, updated_at
		 FROM athena_incident_situation WHERE profile_id = ?`,
		[profileId]
	);
	const row = rows[0];
	if (!row) return { level: "none", headline: null, body: null, incidents: [], key: null };
	return {
		level: row.level,
		headline: row.headline,
		body: row.body,
		incidents: parseJson(row.incidents) || [],
		key: row.incident_key,
		assessedBy: row.assessed_by,
		startedAt: row.started_at,
		updatedAt: row.updated_at,
	};
}

/** The nearby calls as the clients see them. Street names, never raw codes. */
function publicIncidents(hits) {
	return hits.map(({ incident, nearest }) => ({
		id: incident.id,
		what: incident.what,
		category: incident.category,
		where: street(incident.address),
		miles: Math.round(nearest.miles * 10) / 10,
		place: placeName(nearest.place),
		units: incident.units,
		receivedAt: incident.receivedAt,
		serious: incident.alertable,
		// Five decimals is about a metre — more than the dispatch address knows.
		latitude: Math.round(incident.latitude * 1e5) / 1e5,
		longitude: Math.round(incident.longitude * 1e5) / 1e5,
	}));
}

/** The watched places, as a map draws them: the centre of each ring. */
function publicPlaces(places) {
	return (places || []).map((p) => ({
		name: p.live ? "you" : p.name,
		latitude: Math.round(p.latitude * 1e5) / 1e5,
		longitude: Math.round(p.longitude * 1e5) / 1e5,
		radiusMiles: p.radiusMiles || DEFAULT_RADIUS_MILES,
		live: !!p.live,
	}));
}

async function saveSituation(profileId, assessment, hits, key, previous) {
	const continuing = previous.level !== "none" && previous.startedAt;
	const startedAt = assessment.level === "none" ? null : continuing ? previous.startedAt : new Date();
	await pool.query(
		`INSERT INTO athena_incident_situation
			(profile_id, level, headline, body, incidents, incident_key, assessed_by, started_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE level = VALUES(level), headline = VALUES(headline), body = VALUES(body),
		   incidents = VALUES(incidents), incident_key = VALUES(incident_key),
		   assessed_by = VALUES(assessed_by), started_at = VALUES(started_at)`,
		[
			profileId,
			assessment.level,
			assessment.headline,
			assessment.body,
			JSON.stringify(publicIncidents(hits)),
			key,
			assessment.assessedBy,
			startedAt,
		]
	);
}

// ---------------------------------------------------------------------------
// Telling them
// ---------------------------------------------------------------------------

/** Incident ids already told to this person recently. */
async function alreadyTold(profileId) {
	const [rows] = await pool.query(
		`SELECT facts FROM athena_nudge
		 WHERE profile_id = ? AND trigger_id = ? AND created_at >= NOW() - INTERVAL ? HOUR`,
		[profileId, TRIGGER_ID, SEEN_WINDOW_HOURS]
	);
	const seen = new Set();
	for (const row of rows) {
		const facts = parseJson(row.facts);
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
 * Write one nudge and send it everywhere they can be reached: the in-app card
 * (the row itself), push and text (push.sendToProfile fans out to both).
 * Urgent goes out regardless of quiet hours; a lone watch-level call waits.
 */
async function tell(profileId, { dedupeKey, text, urgent, facts }) {
	const uuid = randomUUID();
	const [result] = await pool.query(
		`INSERT IGNORE INTO athena_nudge
			(uuid, profile_id, trigger_id, dedupe_key, urgency, text, facts, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
		[
			uuid,
			profileId,
			TRIGGER_ID,
			dedupeKey.slice(0, 190),
			urgent ? "high" : "normal",
			text.slice(0, 500),
			JSON.stringify(facts || {}),
			NUDGE_TTL_S,
		]
	);
	if (!result.affectedRows) return { written: false, pushed: { sent: 0, skipped: "already told" } };
	if (!urgent && (await quietNow(profileId))) {
		return { written: true, pushed: { sent: 0, skipped: "held for quiet hours" } };
	}
	const push = require("../push");
	const pushed = await push
		.deliverNudge(profileId, { uuid, text: text.slice(0, 500), trigger_id: TRIGGER_ID })
		.catch((error) => ({ sent: 0, error: error.message }));
	return { written: true, pushed };
}

const keyOf = (ids) => createHash("sha1").update(ids.join(",")).digest("hex");

/**
 * One profile: re-judge the situation when the nearby calls change, tell them
 * about any call they have not heard about, and say when it is over.
 * `dryRun` computes everything and writes/sends nothing.
 */
async function checkProfile(profileId, { dryRun = false, list = null, countyActive = null, generate } = {}) {
	const places = await placesFor(profileId);
	const hits = await nearbyFor(profileId, { list, places });
	const ids = hits.map((h) => h.incident.id).sort();
	const key = ids.length ? keyOf(ids) : null;
	const previous = await getSituation(profileId);

	// Re-assess only when the set of calls changed: the model is asked once per
	// development, not once every two minutes.
	const changed = key !== previous.key;
	const situation = changed ? { ...(await assess(hits, { countyActive, generate })), key } : previous;

	const seen = await alreadyTold(profileId);
	const fresh = hits.filter((h) => !seen.has(h.incident.id));
	const urgent = situation.level === "urgent";
	const out = { profileId, nearby: hits.length, level: situation.level, told: 0, headline: situation.headline };

	if (dryRun) return { ...out, told: fresh.length, text: situation.body || null, dryRun: true };
	if (changed) await saveSituation(profileId, situation, hits, key, previous);
	// Same calls, fresher details: units arriving, positions for the map. The
	// judgement is kept; only the list under it is rewritten.
	else if (hits.length)
		await pool.query("UPDATE athena_incident_situation SET incidents = ? WHERE profile_id = ?", [
			JSON.stringify(publicIncidents(hits)),
			profileId,
		]);

	if (fresh.length) {
		const text = urgent ? `🚨 ${situation.headline}. ${situation.body}` : situation.body || wording(fresh);
		const told = await tell(profileId, {
			dedupeKey: `pp:${keyOf(fresh.map((h) => h.incident.id).sort())}`,
			text,
			urgent,
			facts: {
				agency: AGENCY,
				level: situation.level,
				incidentIds: fresh.map((h) => h.incident.id),
				incidents: publicIncidents(fresh),
				places: publicPlaces(places),
			},
		});
		return { ...out, told: told.written ? fresh.length : 0, text, pushed: told.pushed };
	}

	// Escalation without a new call: calls they already heard about, one at a
	// time, now add up to something urgent (a second call joined, or the model
	// read the pattern). That is news in itself and gets said as such.
	if (changed && urgent && previous.level !== "urgent") {
		const text = `🚨 ${situation.headline}. ${situation.body}`;
		const told = await tell(profileId, {
			dedupeKey: `pp-escalate:${key}`,
			text,
			urgent: true,
			facts: { agency: AGENCY, level: "urgent", escalation: true, incidentIds: [], incidents: publicIncidents(hits), places: publicPlaces(places) },
		});
		return { ...out, told: told.written ? hits.length : 0, text, pushed: told.pushed, escalated: true };
	}

	// The all-clear. Someone who was told "urgent" deserves to hear when it is
	// over, rather than being left to wonder whether silence means safe.
	if (changed && !hits.length && previous.level === "urgent") {
		const text = "All clear near home — the emergency calls I told you about have closed.";
		const told = await tell(profileId, {
			dedupeKey: `pp-clear:${previous.key}`,
			text,
			urgent: false,
			facts: { agency: AGENCY, level: "none", clears: previous.key },
		});
		return { ...out, text, pushed: told.pushed, cleared: true };
	}
	return out;
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

// ---------------------------------------------------------------------------
// Feed health: a watcher that silently stops reading is worse than none,
// because it is trusted.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cadence (owner, 2026-09-22): every 15 minutes normally; every 5 for an hour
// once something comes up near a watched place, each new call extending the
// hour. The scheduler fires every 5 minutes and a tick that is not due reads
// nothing — so the rhythm lives here, in one place, and not in cron.
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const CALM_EVERY_MS = 15 * MINUTE_MS;
const HOT_EVERY_MS = 5 * MINUTE_MS;
const HOT_FOR_MS = 60 * MINUTE_MS;
/** A source that has shut automated readers out is asked again this rarely. */
const BLOCKED_EVERY_MS = 6 * 60 * MINUTE_MS;
/** Scheduler ticks drift by seconds; a poll due in under this is due now. */
const TICK_SLACK_MS = 45_000;

/** Two misses in a row is half an hour blind at the calm rhythm — say so. */
const OUTAGE_AFTER_FAILURES = 2;

const time = (value) => (value ? new Date(value).getTime() : null);

async function feedHealth() {
	const [rows] = await pool.query(
		`SELECT last_ok_at, last_error, consecutive_failures, outage_notified_at, last_attempt_at, hot_until, blocked_at
		 FROM athena_incident_feed WHERE id = 1`
	);
	const row = rows[0] || {};
	const failures = Number(row.consecutive_failures) || 0;
	return {
		lastOkAt: row.last_ok_at || null,
		lastError: row.last_error || null,
		consecutiveFailures: failures,
		blocked: !!row.blocked_at,
		blockedAt: row.blocked_at || null,
		down: !!row.blocked_at || failures >= OUTAGE_AFTER_FAILURES,
		outageNotifiedAt: row.outage_notified_at || null,
		lastAttemptAt: row.last_attempt_at || null,
		hotUntil: row.hot_until || null,
	};
}

/** How often to read right now, and why — the answer `--status` prints. */
function rhythmFor(health, now = Date.now()) {
	if (health.blocked) return { everyMs: BLOCKED_EVERY_MS, why: "PulsePoint is blocking automated readers" };
	const hot = time(health.hotUntil);
	if (hot && hot > now) return { everyMs: HOT_EVERY_MS, why: "something is happening nearby" };
	return { everyMs: CALM_EVERY_MS, why: "all quiet" };
}

/** Is this scheduler tick one that should actually read? */
function isDue(health, now = Date.now()) {
	const last = time(health.lastAttemptAt);
	const { everyMs, why } = rhythmFor(health, now);
	if (!last) return { due: true, everyMs, why };
	const waited = now - last;
	return { due: waited >= everyMs - TICK_SLACK_MS, everyMs, why, nextInMs: Math.max(0, everyMs - waited) };
}

async function recordAttempt() {
	await pool.query(
		`INSERT INTO athena_incident_feed (id, last_attempt_at) VALUES (1, NOW())
		 ON DUPLICATE KEY UPDATE last_attempt_at = NOW()`
	);
}

/** Something came up: read every 5 minutes for the next hour. */
async function heatUp() {
	await pool.query("UPDATE athena_incident_feed SET hot_until = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = 1", [
		HOT_FOR_MS / 1000,
	]);
}

async function recordFeedOk() {
	await pool.query(
		`INSERT INTO athena_incident_feed (id, last_ok_at, consecutive_failures, last_error, outage_notified_at, blocked_at)
		 VALUES (1, NOW(), 0, NULL, NULL, NULL)
		 ON DUPLICATE KEY UPDATE last_ok_at = NOW(), consecutive_failures = 0, last_error = NULL,
		   outage_notified_at = NULL, blocked_at = NULL`
	);
}

/**
 * Record a miss; once it is an outage, tell every watched person — once per
 * outage. A block is an outage on the first miss: it is a decision on their
 * side, not a blip that the next read might clear.
 */
async function recordFeedFailure(error) {
	await pool.query(
		`INSERT INTO athena_incident_feed (id, consecutive_failures, last_error, blocked_at) VALUES (1, 1, ?, ?)
		 ON DUPLICATE KEY UPDATE consecutive_failures = consecutive_failures + 1, last_error = VALUES(last_error),
		   blocked_at = IF(VALUES(blocked_at) IS NULL, NULL, COALESCE(blocked_at, VALUES(blocked_at)))`,
		[String(error?.message || error).slice(0, 500), error?.blocked ? new Date() : null]
	);
	const health = await feedHealth();
	if (!health.down || health.outageNotifiedAt) return health;
	await pool.query("UPDATE athena_incident_feed SET outage_notified_at = NOW() WHERE id = 1");
	const text = health.blocked
		? "Heads up: PulsePoint has started blocking automated readers, so I can't see the county 911 dispatch board or warn you about emergencies nearby. I'll check again every few hours. The PulsePoint Respond app can still notify you directly."
		: "Heads up: I can't read the county 911 dispatch board right now, so I can't warn you about emergencies nearby until it's back. I'll keep trying.";
	for (const profileId of await watchedProfiles()) {
		await tell(profileId, {
			dedupeKey: `pp-outage:${Date.now()}`,
			text,
			urgent: false,
			facts: { agency: AGENCY, outage: true, blocked: health.blocked, error: health.lastError },
		}).catch(() => undefined);
	}
	return health;
}

/**
 * One scheduler tick. Reads only when the rhythm says it is due (or `force`),
 * then passes over everyone. Never throws for one profile's failure; a block
 * is recorded and reported as `blocked`, not thrown, because it is a known
 * state and not a crash.
 */
async function runOnce({ dryRun = false, generate, force = false } = {}) {
	const health = await feedHealth();
	const due = isDue(health);
	if (!force && !dryRun && !due.due) {
		return { agency: AGENCY, skipped: true, why: due.why, everyMs: due.everyMs, nextInMs: due.nextInMs, results: [] };
	}
	if (!dryRun) await recordAttempt();

	let list;
	try {
		list = await board();
	} catch (error) {
		if (!dryRun) await recordFeedFailure(error).catch(() => undefined);
		if (error?.blocked) return { agency: AGENCY, blocked: true, error: error.message, results: [] };
		throw error;
	}
	if (!dryRun) await recordFeedOk().catch(() => undefined);
	const countyActive = list.filter((i) => i.status === "active").length;
	const results = [];
	for (const profileId of await watchedProfiles()) {
		try {
			results.push(await checkProfile(profileId, { dryRun, list, countyActive, generate }));
		} catch (error) {
			results.push({ profileId, error: error.message });
		}
	}
	// A new call anywhere — or a situation escalating — is "something came up".
	if (!dryRun && results.some((r) => r.told > 0 || r.escalated)) await heatUp().catch(() => undefined);
	const after = rhythmFor(dryRun ? health : await feedHealth().catch(() => health));
	return { agency: AGENCY, active: countyActive, results, everyMs: after.everyMs, why: after.why };
}

/** For the in-app banner: the situation plus whether the feed can be trusted. */
async function alertFor(profileId) {
	const [situation, health, places] = await Promise.all([
		getSituation(profileId),
		feedHealth().catch(() => null),
		placesFor(profileId).catch(() => []),
	]);
	return {
		places: publicPlaces(places),
		level: situation.level,
		headline: situation.headline,
		body: situation.body,
		incidents: situation.incidents,
		key: situation.key,
		startedAt: situation.startedAt || null,
		updatedAt: situation.updatedAt || null,
		assessedBy: situation.assessedBy || null,
		feed: health
			? { ok: !health.down, blocked: health.blocked, lastOkAt: health.lastOkAt, error: health.down ? health.lastError : null }
			: { ok: false, lastOkAt: null, error: "unknown" },
	};
}

/**
 * For Athena's prompt. Read from the stored situation — no fetch, no model —
 * so it costs one indexed query per message. When it is urgent it is written
 * to take over the conversation, because the owner asked for exactly that:
 * "it should be all Athena wants to talk about".
 */
async function promptBlock(profileId) {
	if (!profileId) return null;
	const [situation, health] = await Promise.all([getSituation(profileId), feedHealth().catch(() => null)]);
	const lines = [];
	if (health?.down) {
		lines.push(
			"# You cannot see the county 911 dispatch board right now",
			"",
			health.blocked
				? "PulsePoint has started blocking automated readers, so you cannot see 911 calls near them. " +
					"You will not try to get around that. If they ask about sirens or anything nearby, say so " +
					"plainly, and mention the PulsePoint Respond app can notify them directly."
				: "Your emergency feed has been failing, so you cannot currently warn them about emergencies " +
					"nearby. If they ask about sirens or anything happening near home, say so plainly.",
			""
		);
	}
	if (situation.level === "none" || !situation.incidents.length) return lines.length ? lines.join("\n") : null;

	const list = situation.incidents.slice(0, 10).map((i) => {
		const mins = i.receivedAt ? minutesAgo(new Date(i.receivedAt)) : null;
		const ago = mins === null ? "" : `, dispatched ${mins} min ago`;
		const units = i.units > 1 ? `, ${i.units} units` : "";
		return `- ${i.what} — ${i.where}, ${i.miles} miles from ${i.place}${units}${ago}${i.serious ? " [serious]" : ""}`;
	});
	if (situation.level === "urgent") {
		lines.push(
			"# URGENT — ongoing emergencies near their home",
			"",
			"This outranks everything else in this conversation.",
			`Your assessment: ${situation.headline}. ${situation.body}`,
			"",
			"- If you have not already raised this in this conversation, OPEN your reply with it,",
			"  whatever they asked — then answer their question.",
			"- Keep it at the front until they have acknowledged it. After that, answer them normally",
			"  but mention any change (new calls, calls closing).",
			"- Be specific and calm: what, where, how close, one practical suggestion.",
			"- Only what is listed below. Do not invent injuries, causes or closures.",
			"",
			"Live from the county dispatch board (PulsePoint, Iredell County):",
			...list
		);
	} else {
		lines.push(
			"# An emergency call near them",
			"",
			"From the county 911 dispatch board. If they have not heard about it, mention it briefly;",
			"if they ask about sirens or anything nearby, this is what you know. Do not speculate.",
			"",
			...list
		);
	}
	return lines.join("\n");
}

module.exports = {
	TRIGGER_ID,
	runOnce,
	checkProfile,
	nearbyFor,
	assess,
	checkAnswer,
	floorLevel,
	alertFor,
	getSituation,
	feedHealth,
	isDue,
	rhythmFor,
	isDue,
	rhythmFor,
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
