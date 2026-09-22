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
const nws = require("./nws");
const phoneAlerts = require("./phoneAlerts");
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
const isSerious = (item) => (item?.serious ?? item?.incident?.alertable) === true;

function floorLevel(hits = [], weather = []) {
	const items = [...(hits || []), ...(weather || [])];
	if (!items.length) return "none";
	if (items.length >= 2 || items.some(isSerious)) return "urgent";
	return "watch";
}

const minutesAgo = (date) =>
	date instanceof Date && !Number.isNaN(date.getTime())
		? Math.max(0, Math.round((Date.now() - date.getTime()) / 60000))
		: null;

/** What the model is shown: the calls, as facts, and nothing it could mistake for an instruction. */
function sheet(hits, countyActive, weather = []) {
	const call = (item) =>
		item.incident
			? {
					what: item.incident.what,
					category: item.incident.category,
					where: street(item.incident.address),
					milesAway: Math.round(item.nearest.miles * 10) / 10,
					nearestWatchedPlace: placeName(item.nearest.place),
					unitsResponding: item.incident.units,
					dispatchedMinutesAgo: minutesAgo(item.incident.receivedAt),
					seriousByDispatchStandards: item.incident.alertable,
				}
			: {
					what: item.what,
					where: item.where,
					milesAway: item.miles,
					nearestWatchedPlace: item.place,
					unitsResponding: item.units,
					dispatchedMinutesAgo: item.receivedAt ? minutesAgo(new Date(item.receivedAt)) : null,
					seriousByDispatchStandards: item.serious,
				};
	return {
		countyWideActiveCalls: countyActive,
		nearbyActiveCalls: (hits || []).map(call),
		weatherAlerts: (weather || []).map((w) => ({
			alert: w.event,
			severity: w.severity,
			urgency: w.urgency,
			covers: w.area,
			forWatchedPlace: w.place,
			officialAdvice: w.instruction,
		})),
	};
}

const PROMPT = (facts, floor) =>
	"You are Athena, looking after the person you live with. Below is what the county 911 " +
	"dispatch board and the National Weather Service say is happening near their home and the " +
	"places they asked you to watch, " +
	"right now.\n\n" +
	JSON.stringify(facts, null, 1) +
	"\n\nDecide how loudly to tell them, then write it.\n" +
	`- level: "none", "watch" or "urgent". It must be at least "${floor}". Ongoing emergencies ` +
	"close to home are a big deal to this person: they would rather be told too loudly than " +
	"find out later that they had no clue.\n" +
	"- headline: at most 8 words. Plain, specific, no exclamation marks.\n" +
	"- body: at most 45 words, spoken to them directly. Say what is happening and how close. " +
	"With three calls or fewer, mention every one by what and street; with more, give the count " +
	"and the nearest. Cover the weather alerts too, briefly, in the weather service's own terms; " +
	"its advice line may be quoted. If several calls share a cause you can see in the list " +
	"(e.g. many trees down during a storm warning), say so plainly. " +
	"You may add one practical suggestion only if it follows directly " +
	"from the list (e.g. avoid a named street with a call on it). Do not invent anything that is " +
	"not in the list — no injuries, causes, advice about other roads, or closures it does not state.\n\n" +
	'Reply as JSON: {"level":"...","headline":"...","body":"..."}';

function fallbackAssessment(hits = [], weather = []) {
	const level = floorLevel(hits, weather);
	if (level === "none") return { level, headline: null, body: null, assessedBy: "rules" };
	const calls = hits || [];
	const place = calls.length ? placeName(calls[0].nearest?.place || { name: calls[0].place }) : weather[0].place;
	const headline = calls.length
		? calls.length === 1
			? `${calls[0].incident?.what || calls[0].what} near ${place}`
			: `${calls.length} emergencies near ${place}`
		: weather.length === 1
			? `${weather[0].event} where you are`
			: `${weather.length} weather alerts near ${place}`;
	const lines = [];
	if (calls.length) lines.push(wording(calls));
	for (const w of weather.slice(0, 3)) lines.push(`${w.event}${w.instruction ? `. ${w.instruction}` : ""}`);
	return { level, headline, body: lines.join(" ").slice(0, 1000), assessedBy: "rules" };
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
async function assess(hits, { countyActive = null, generate = generateWithModel, weather = [] } = {}) {
	const fallback = fallbackAssessment(hits, weather);
	if (!hits?.length && !weather.length) return fallback;
	const floor = floorLevel(hits, weather);
	let timer;
	try {
		const result = await Promise.race([
			generate(PROMPT(sheet(hits, countyActive, weather), floor), streetMarks(hits || [])),
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
		`SELECT level, headline, body, incidents, weather, incident_key, assessed_by, started_at, updated_at
		 FROM athena_incident_situation WHERE profile_id = ?`,
		[profileId]
	);
	const row = rows[0];
	if (!row) return { level: "none", headline: null, body: null, incidents: [], weather: [], key: null };
	return {
		level: row.level,
		headline: row.headline,
		body: row.body,
		incidents: parseJson(row.incidents) || [],
		weather: parseJson(row.weather) || [],
		key: row.incident_key,
		assessedBy: row.assessed_by,
		startedAt: row.started_at,
		updatedAt: row.updated_at,
	};
}

/** The nearby calls as the clients see them. Street names, never raw codes. */
function publicIncidents(hits) {
	return (hits || []).map(({ incident, nearest }) => ({
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

/**
 * Store the judgement and what it was made of.
 *
 * `calls` is already in public shape here, because when PulsePoint cannot be
 * read the calls being carried forward are the ones already stored — see
 * checkProfile.
 */
async function saveSituation(profileId, assessment, calls, weather, key, previous) {
	const continuing = previous.level !== "none" && previous.startedAt;
	const startedAt = assessment.level === "none" ? null : continuing ? previous.startedAt : new Date();
	await pool.query(
		`INSERT INTO athena_incident_situation
			(profile_id, level, headline, body, incidents, weather, incident_key, assessed_by, started_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE level = VALUES(level), headline = VALUES(headline), body = VALUES(body),
		   incidents = VALUES(incidents), weather = VALUES(weather), incident_key = VALUES(incident_key),
		   assessed_by = VALUES(assessed_by), started_at = VALUES(started_at)`,
		[
			profileId,
			assessment.level,
			assessment.headline,
			assessment.body,
			JSON.stringify(calls || []),
			JSON.stringify(weather || []),
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
 * One profile, over both sources: re-judge when what is happening changes,
 * tell them about anything they have not heard, and say when it is over.
 *
 * ## "Could not read" is not "nothing is happening"
 *
 * `list` is null when PulsePoint was not read this tick — not due, or blocked.
 * The calls already known are then carried forward untouched: declaring an
 * all-clear because a source went dark would be the worst lie this thing
 * could tell. Only a source we actually read can clear its own half.
 *
 * `dryRun` computes everything and writes/sends nothing.
 */
async function checkProfile(
	profileId,
	{ dryRun = false, list = null, countyActive = null, generate, weather = null } = {}
) {
	const places = await placesFor(profileId);
	const previous = await getSituation(profileId);

	// Calls: read now, or carried forward in the shape they were stored in.
	// Anything the PHONE told us about is kept across a feed read and expires
	// on its own clock — the feed will never mention it, and nothing will ever
	// say it is over. See phoneAlerts.js.
	const kept = (previous.incidents || []).filter((i) => i.via === "phone" && !phoneAlerts.expired(i));
	const hits = list ? await nearbyFor(profileId, { list, places }) : null;
	const calls = hits ? [...publicIncidents(hits), ...kept] : (previous.incidents || []).filter((i) => !phoneAlerts.expired(i));
	// Weather: same rule.
	const alerts = weather ?? previous.weather ?? [];

	const key =
		calls.length || alerts.length
			? keyOf([...calls.map((c) => c.id), ...alerts.map((a) => `w:${a.id}`)].sort())
			: null;
	const changed = key !== previous.key;
	// The model is asked once per development, not once per tick.
	const situation = changed
		? { ...(await assess(hits || calls, { countyActive, generate, weather: alerts })), key }
		: previous;

	const seen = await alreadyTold(profileId);
	const freshCalls = hits ? calls.filter((c) => !seen.has(c.id)) : [];
	const freshWeather = weather ? alerts.filter((a) => !seen.has(`w:${a.id}`)) : [];
	const urgent = situation.level === "urgent";
	const out = {
		profileId,
		nearby: calls.length,
		weather: alerts.length,
		level: situation.level,
		told: 0,
		headline: situation.headline,
	};

	if (dryRun) {
		return { ...out, told: freshCalls.length + freshWeather.length, text: situation.body || null, dryRun: true };
	}
	if (changed) await saveSituation(profileId, situation, calls, alerts, key, previous);
	// Same things, fresher details: units arriving, positions for the map. The
	// judgement is kept; only the list under it is rewritten.
	else if (hits?.length)
		await pool.query("UPDATE athena_incident_situation SET incidents = ? WHERE profile_id = ?", [
			JSON.stringify(calls),
			profileId,
		]);

	if (freshCalls.length || freshWeather.length) {
		const text = urgent
			? `🚨 ${situation.headline}. ${situation.body}`
			: situation.body || wording(hits || []);
		const told = await tell(profileId, {
			dedupeKey: `pp:${keyOf([...freshCalls.map((c) => c.id), ...freshWeather.map((a) => `w:${a.id}`)].sort())}`,
			text,
			urgent,
			facts: {
				agency: AGENCY,
				level: situation.level,
				incidentIds: [...freshCalls.map((c) => c.id), ...freshWeather.map((a) => `w:${a.id}`)],
				incidents: freshCalls,
				weather: freshWeather,
				places: publicPlaces(places),
			},
		});
		return { ...out, told: told.written ? freshCalls.length + freshWeather.length : 0, text, pushed: told.pushed };
	}

	// Escalation with nothing new: things they already heard about, one at a
	// time, now add up to something urgent. That is news in itself.
	if (changed && urgent && previous.level !== "urgent") {
		const text = `🚨 ${situation.headline}. ${situation.body}`;
		const told = await tell(profileId, {
			dedupeKey: `pp-escalate:${key}`,
			text,
			urgent: true,
			facts: {
				agency: AGENCY,
				level: "urgent",
				escalation: true,
				incidentIds: [],
				incidents: calls,
				weather: alerts,
				places: publicPlaces(places),
			},
		});
		return { ...out, told: told.written ? calls.length + alerts.length : 0, text, pushed: told.pushed, escalated: true };
	}

	// The all-clear — only when everything that could have been read WAS read,
	// so a blocked source can never produce one.
	if (changed && !calls.length && !alerts.length && previous.level === "urgent") {
		const text = "All clear near home — the emergencies I told you about have ended.";
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

/**
 * A notification PulsePoint's own app put on the owner's phone, forwarded by
 * the Athena app. Placed against the watched places and folded into the same
 * situation as everything else; nothing unrecognised or unplaceable is guessed
 * at.
 *
 * Returns why it was ignored rather than throwing: the phone forwards whatever
 * it sees, and most of it will not be for us.
 */
async function recordPhoneAlert(profileId, { title, text, postedAt, generate } = {}) {
	const places = await placesFor(profileId);
	if (!places.length) return { ignored: "no watched places" };
	// A town for the geocoder, taken from a saved place's own address.
	const region = (places.find((p) => p.address)?.address || "").split(",").slice(-2).join(",").trim() || null;

	const parsed = phoneAlerts.parse({ title, text, region });
	if (!parsed.ok) return { ignored: parsed.why, text: parsed.text };

	const point = await phoneAlerts.place(parsed.query);
	if (!point) return { ignored: "could not place the address", what: parsed.what, address: parsed.address };

	const matches = geo.placesNear(point, places, DEFAULT_RADIUS_MILES);
	if (!matches.length) return { ignored: "not near a watched place", what: parsed.what, address: parsed.address };

	const incident = phoneAlerts.incidentFrom(parsed, point, matches[0], postedAt);
	const previous = await getSituation(profileId);
	if ((previous.incidents || []).some((i) => i.id === incident.id)) {
		return { ignored: "already known", what: parsed.what, address: parsed.address };
	}

	const calls = [...(previous.incidents || []).filter((i) => !phoneAlerts.expired(i)), incident].sort(
		(a, b) => a.miles - b.miles
	);
	const alerts = previous.weather || [];
	const key = keyOf([...calls.map((c) => c.id), ...alerts.map((a) => `w:${a.id}`)].sort());
	const situation = { ...(await assess(calls, { weather: alerts, generate })), key };
	await saveSituation(profileId, situation, calls, alerts, key, previous);

	const urgent = situation.level === "urgent";
	const told = await tell(profileId, {
		dedupeKey: `ph:${incident.id}`,
		text: urgent
			? `🚨 ${situation.headline}. ${situation.body}`
			: situation.body || `${incident.what} near ${incident.place}.`,
		urgent,
		facts: {
			source: "pulsepoint-app",
			level: situation.level,
			incidentIds: [incident.id],
			incidents: [incident],
			places: publicPlaces(places),
		},
	});
	await heatUp().catch(() => undefined);
	return { told: told.written, level: situation.level, incident, pushed: told.pushed };
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

/** The two sources behind "what is happening near me". */
const SOURCES = { calls: "pulsepoint", weather: "nws" };
const SOURCE_LABEL = { pulsepoint: "the county 911 dispatch board", nws: "the weather service" };

/**
 * How fast the situation is moving, which both sources share.
 *
 * Returned as SECONDS FROM NOW, measured by the database, not as a timestamp
 * compared against this process's clock. The job runs in a container and the
 * database keeps its own time; comparing the two directly was off by the
 * timezone difference, which is the kind of bug that shows up as "why did it
 * not check for four hours".
 */
async function hotUntil() {
	const [rows] = await pool.query(
		"SELECT hot_until, TIMESTAMPDIFF(SECOND, NOW(), hot_until) AS hot_in_s FROM athena_incident_feed WHERE id = 1"
	);
	return { at: rows[0]?.hot_until || null, inSeconds: rows[0]?.hot_in_s ?? null };
}

/** One source's health, plus the shared rhythm, in the shape isDue wants. */
async function sourceHealth(source, hotValue = undefined) {
	const [rows] = await pool.query(
		`SELECT last_attempt_at, last_ok_at, last_error, consecutive_failures, blocked_at, outage_notified_at,
		        TIMESTAMPDIFF(SECOND, last_attempt_at, NOW()) AS since_attempt_s
		 FROM athena_incident_source WHERE source = ?`,
		[source]
	);
	const row = rows[0] || {};
	const failures = Number(row.consecutive_failures) || 0;
	const hot = hotValue === undefined ? await hotUntil() : hotValue;
	return {
		source,
		lastOkAt: row.last_ok_at || null,
		lastError: row.last_error || null,
		consecutiveFailures: failures,
		blocked: !!row.blocked_at,
		blockedAt: row.blocked_at || null,
		down: !!row.blocked_at || failures >= OUTAGE_AFTER_FAILURES,
		outageNotifiedAt: row.outage_notified_at || null,
		lastAttemptAt: row.last_attempt_at || null,
		// Both measured by the database — see hotUntil().
		sinceAttemptSeconds: row.since_attempt_s ?? null,
		hotUntil: hot.at,
		hotInSeconds: hot.inSeconds,
	};
}

/** The 911 board's health — what the banner, the prompt and --status read. */
async function feedHealth() {
	return sourceHealth(SOURCES.calls);
}

/** Every source, for the banner: one being blocked says nothing about the other. */
async function sourcesHealth() {
	const hot = await hotUntil();
	const [calls, weather] = await Promise.all([
		sourceHealth(SOURCES.calls, hot),
		sourceHealth(SOURCES.weather, hot),
	]);
	return { calls, weather };
}

/** How often to read right now, and why — the answer `--status` prints. */
function rhythmFor(health, now = Date.now()) {
	if (health.blocked) {
		return {
			everyMs: BLOCKED_EVERY_MS,
			why: `${SOURCE_LABEL[health.source] || "the source"} is blocking automated readers`,
		};
	}
	if (health.hotInSeconds > 0) return { everyMs: HOT_EVERY_MS, why: "something is happening nearby" };
	return { everyMs: CALM_EVERY_MS, why: "all quiet" };
}

/** Is this scheduler tick one that should actually read? */
function isDue(health, now = Date.now()) {
	const { everyMs, why } = rhythmFor(health, now);
	if (health.sinceAttemptSeconds === null || health.sinceAttemptSeconds === undefined) {
		return { due: true, everyMs, why, nextInMs: 0 };
	}
	const waited = health.sinceAttemptSeconds * 1000;
	return { due: waited >= everyMs - TICK_SLACK_MS, everyMs, why, nextInMs: Math.max(0, everyMs - waited) };
}

async function recordAttempt(source) {
	await pool.query(
		`INSERT INTO athena_incident_source (source, last_attempt_at) VALUES (?, NOW())
		 ON DUPLICATE KEY UPDATE last_attempt_at = NOW()`,
		[source]
	);
}

/** Something came up: read every 5 minutes for the next hour. */
async function heatUp() {
	await pool.query("UPDATE athena_incident_feed SET hot_until = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = 1", [
		HOT_FOR_MS / 1000,
	]);
}

async function recordFeedOk(source) {
	await pool.query(
		`INSERT INTO athena_incident_source (source, last_ok_at, consecutive_failures, last_error, outage_notified_at, blocked_at)
		 VALUES (?, NOW(), 0, NULL, NULL, NULL)
		 ON DUPLICATE KEY UPDATE last_ok_at = NOW(), consecutive_failures = 0, last_error = NULL,
		   outage_notified_at = NULL, blocked_at = NULL`,
		[source]
	);
}

/**
 * Record a miss; once it is an outage, tell every watched person — once per
 * outage. A block is an outage on the first miss: it is a decision on their
 * side, not a blip that the next read might clear.
 */
async function recordFeedFailure(source, error) {
	await pool.query(
		`INSERT INTO athena_incident_source (source, consecutive_failures, last_error, blocked_at) VALUES (?, 1, ?, ?)
		 ON DUPLICATE KEY UPDATE consecutive_failures = consecutive_failures + 1, last_error = VALUES(last_error),
		   blocked_at = IF(VALUES(blocked_at) IS NULL, blocked_at, COALESCE(blocked_at, VALUES(blocked_at)))`,
		[source, String(error?.message || error).slice(0, 500), error?.blocked ? new Date() : null]
	);
	const health = await sourceHealth(source);
	if (!health.down || health.outageNotifiedAt) return health;
	await pool.query("UPDATE athena_incident_source SET outage_notified_at = NOW() WHERE source = ?", [source]);
	const what = SOURCE_LABEL[source] || source;
	const text = health.blocked
		? `Heads up: ${what} has started blocking automated readers, so I can't see it or warn you about what it covers. I'll check again every few hours. The PulsePoint Respond app can still notify you directly.`
		: `Heads up: I can't read ${what} right now, so I can't warn you about what it covers until it's back. I'll keep trying.`;
	for (const profileId of await watchedProfiles()) {
		await tell(profileId, {
			dedupeKey: `pp-outage:${Date.now()}`,
			text,
			urgent: false,
			facts: { agency: AGENCY, source, outage: true, blocked: health.blocked, error: health.lastError },
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
	const hot = await hotUntil();
	const health = { calls: await sourceHealth(SOURCES.calls, hot), weather: await sourceHealth(SOURCES.weather, hot) };
	const due = { calls: isDue(health.calls), weather: isDue(health.weather) };
	const read = {
		calls: force || dryRun || due.calls.due,
		weather: force || dryRun || due.weather.due,
	};
	if (!read.calls && !read.weather) {
		const soonest = due.calls.nextInMs <= due.weather.nextInMs ? due.calls : due.weather;
		return { agency: AGENCY, skipped: true, why: soonest.why, everyMs: soonest.everyMs, nextInMs: soonest.nextInMs, results: [] };
	}

	// The 911 board. A block is a state, not a crash: recorded, reported, and
	// the pass carries on — the weather half still works.
	let list = null;
	let blocked = false;
	if (read.calls) {
		if (!dryRun) await recordAttempt(SOURCES.calls);
		try {
			list = await board();
			if (!dryRun) await recordFeedOk(SOURCES.calls).catch(() => undefined);
		} catch (error) {
			if (!dryRun) await recordFeedFailure(SOURCES.calls, error).catch(() => undefined);
			if (!error?.blocked) console.warn("[pulsepoint] could not read the board:", error.message);
			blocked = !!error?.blocked;
		}
	}
	const countyActive = list ? list.filter((i) => i.status === "active").length : null;

	// The weather service, per profile, because alerts are per point.
	let weatherOk = null;
	if (read.weather && !dryRun) await recordAttempt(SOURCES.weather);

	const results = [];
	for (const profileId of await watchedProfiles()) {
		let weather = null;
		if (read.weather) {
			try {
				weather = await nws.alertsForPlaces(await placesFor(profileId));
				weatherOk = weatherOk !== false;
			} catch (error) {
				weatherOk = false;
				console.warn("[nws] could not read alerts:", error.message);
			}
		}
		try {
			results.push(await checkProfile(profileId, { dryRun, list, countyActive, generate, weather }));
		} catch (error) {
			results.push({ profileId, error: error.message });
		}
	}
	if (read.weather && !dryRun && weatherOk !== null) {
		if (weatherOk) await recordFeedOk(SOURCES.weather).catch(() => undefined);
		else await recordFeedFailure(SOURCES.weather, new Error("The weather service could not be read.")).catch(() => undefined);
	}

	// Anything new — or a situation escalating — is "something came up".
	if (!dryRun && results.some((r) => r.told > 0 || r.escalated)) await heatUp().catch(() => undefined);
	// Each source has its own next read: a blocked 911 board says nothing about
	// when the weather is next looked at.
	const fresh = dryRun ? health : { calls: await sourceHealth(SOURCES.calls), weather: await sourceHealth(SOURCES.weather) };
	const next = { calls: rhythmFor(fresh.calls), weather: rhythmFor(fresh.weather) };
	return {
		agency: AGENCY,
		active: countyActive,
		blocked,
		read,
		results,
		next,
		everyMs: Math.min(next.calls.everyMs, next.weather.everyMs),
		why: next.calls.everyMs <= next.weather.everyMs ? next.calls.why : next.weather.why,
	};
}

/** For the in-app banner: the situation plus whether the feed can be trusted. */
async function alertFor(profileId) {
	const [situation, health, places] = await Promise.all([
		getSituation(profileId),
		sourcesHealth().catch(() => null),
		placesFor(profileId).catch(() => []),
	]);
	const status = (h) =>
		h
			? { ok: !h.down, blocked: h.blocked, lastOkAt: h.lastOkAt, error: h.down ? h.lastError : null }
			: { ok: false, blocked: false, lastOkAt: null, error: "unknown" };
	return {
		places: publicPlaces(places),
		weather: situation.weather || [],
		sources: { calls: status(health?.calls), weather: status(health?.weather) },
		level: situation.level,
		headline: situation.headline,
		body: situation.body,
		incidents: situation.incidents,
		key: situation.key,
		startedAt: situation.startedAt || null,
		updatedAt: situation.updatedAt || null,
		assessedBy: situation.assessedBy || null,
		// Kept for any client that predates `sources`: the 911 board's status.
		feed: status(health?.calls),
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
	const [situation, sources] = await Promise.all([getSituation(profileId), sourcesHealth().catch(() => null)]);
	const health = sources?.calls;
	const lines = [];
	if (sources?.weather?.down) {
		lines.push(
			"# You cannot see weather alerts right now",
			"",
			"The National Weather Service feed has been failing, so you cannot warn them about storms.",
			""
		);
	}
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
	const alerts = situation.weather || [];
	if (situation.level === "none" || (!situation.incidents.length && !alerts.length)) {
		return lines.length ? lines.join("\n") : null;
	}
	const weatherLines = alerts.map(
		(a) =>
			`- ${a.event} (${a.severity}${a.urgency ? `, ${a.urgency.toLowerCase()}` : ""}) over ${a.area}` +
			`${a.instruction ? ` — official advice: ${a.instruction}` : ""}`
	);

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
			...list,
			...(weatherLines.length ? ["", "From the National Weather Service, for their area:", ...weatherLines] : [])
		);
	} else {
		lines.push(
			"# An emergency call near them",
			"",
			"From the county 911 dispatch board and the National Weather Service. If they have not",
			"heard about it, mention it briefly; if they ask about sirens, the weather or anything",
			"nearby, this is what you know. Do not speculate.",
			"",
			...list,
			...(weatherLines.length ? ["", "Weather alerts for their area:", ...weatherLines] : [])
		);
	}
	return lines.join("\n");
}

module.exports = {
	TRIGGER_ID,
	PULSEPOINT_PACKAGE: phoneAlerts.PULSEPOINT_PACKAGE,
	runOnce,
	checkProfile,
	recordPhoneAlert,
	nearbyFor,
	assess,
	checkAnswer,
	floorLevel,
	alertFor,
	getSituation,
	feedHealth,
	sourcesHealth,
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
