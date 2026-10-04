/**
 * Place reminders — "next time I'm at Missy's, remind me to bring back the
 * casserole dish."
 *
 * A reminder that waits for a place instead of a time. Three parts:
 *
 *   - Setting one is an action (`remind_at_place` in actions/registry.js), so
 *     the person approves the exact place and words on a card — or has granted
 *     a standing approval for it. `resolvePlace()` is the untrusted-input half
 *     of that: a model-named place must be one of the person's own points of
 *     interest, or an address the geocoder can find, and the card shows the
 *     address it resolved to so a wrong "Missy's" is caught before it is set.
 *   - The phone holds one geofence per armed reminder (`geofences()`), and
 *     Android tells it when the person has been inside one for a couple of
 *     minutes. Only then does the phone send a position (`arrived()`). There is
 *     no trail: nothing is reported while no reminder is armed, and nothing is
 *     reported between places.
 *   - The server re-checks the distance itself and sends the reminder through
 *     the same nudge + push path as everything else Athena says first.
 *
 * ## Why this ignores Initiative's switch and quiet hours
 *
 * The owner decided it on 2026-10-04: a reminder the person asked for is not
 * Athena speaking first, and a "you're at Missy's" held until 7am is worthless.
 * What still applies: location sharing must be on (athena_location_pref), the
 * phone's own location permission, and "Reach me outside the app" for push —
 * those are the person's switches over whether their position and their phone
 * are used at all.
 *
 * ## Nothing is lost
 *
 * A next-visit reminder is only marked done once a push was accepted. If the
 * phone couldn't be reached it is still written as an in-app card and stays
 * armed for the next visit. One visit is SAME_VISIT_HOURS long, so a geofence
 * re-registered while they are still there does not repeat it.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../helpers/db");
const location = require("./location");
const watch = require("./pulsepoint/watch");
const geocode = require("./pulsepoint/geocode");
const geo = require("./pulsepoint/geo");

const TRIGGER_ID = "place_reminder";
/**
 * Geofence size. Android advises 100–150 m, but the Census geocoder can put a
 * rural house a couple of hundred metres down the road, and on 2026-10-04 the
 * owner stood at Missy's with no reminder. 300 m (owner-approved) covers that
 * error; the server still re-checks the distance on arrival.
 */
const ARRIVAL_RADIUS_M = 300;
/** A stored radius never shrinks a fence below today's size (rows from before 10-04 say 150). */
const radiusOf = (row) => Math.max(Number(row.radius_m) || 0, ARRIVAL_RADIUS_M);
/** Android allows 100 fences per app; leave room and keep the list readable. */
const MAX_ARMED = 50;
/** Arrivals inside this window after the last one are the same visit. */
const SAME_VISIT_HOURS = 8;
/** A position older than this is where they were, not where they are. */
const ARRIVAL_FRESH_MS = 15 * 60_000;
/** Slack on top of the fence for GPS error; accuracy is capped so a 5 km fix can't count. */
const MAX_ACCURACY_M = 250;
const SLACK_M = 50;
/** The in-app card stays this long if the push didn't reach them. */
const NUDGE_TTL_S = 2 * 60 * 60;
const METERS_PER_MILE = 1609.344;

const invalid = (message) => Object.assign(new Error(message), { status: 400, code: "invalid_action_params" });
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const trim = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
/** "Missy's house" and "missys  house" are the same name; punctuation and case aren't. */
const nameKey = (value) => String(value || "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();

function toReminder(row) {
	return {
		uuid: row.uuid,
		placeUuid: row.place_uuid || null,
		placeName: row.place_name,
		address: row.address || null,
		latitude: Number(row.latitude),
		longitude: Number(row.longitude),
		radiusM: radiusOf(row),
		reminder: row.text,
		repeats: row.repeats === 1 || row.repeats === true,
		status: row.status,
		fireCount: Number(row.fire_count || 0),
		lastFiredAt: row.last_fired_at || null,
		doneAt: row.done_at || null,
		createdAt: row.created_at,
	};
}

/**
 * The place a model named, as a point the person can check on a card.
 *
 * `place` must be one of their points of interest — by name, ignoring case and
 * punctuation, or by uuid. Otherwise `address` is geocoded (US street
 * addresses) and the best match is used, named `place_name` or `place`.
 * Anything else is refused: a reminder is never set on a guessed point.
 */
async function resolvePlace(profileId, raw = {}) {
	const placeRef = trim(raw.place, 80);
	const address = trim(raw.address, 200);
	if (placeRef) {
		const places = await watch.listPlaces(profileId);
		const wanted = nameKey(placeRef);
		const found = places.find((p) => p.uuid === placeRef) || places.find((p) => nameKey(p.name) === wanted);
		if (found && geo.isPoint(found)) {
			return {
				place_uuid: found.uuid,
				place_name: found.name.slice(0, 80),
				address: found.address || null,
				latitude: found.latitude,
				longitude: found.longitude,
			};
		}
	}
	if (!address) {
		throw invalid(placeRef ? `"${placeRef}" is not one of their points of interest; give its street address` : "A place reminder needs a place");
	}
	let matches;
	try {
		matches = await geocode.lookup(address);
	} catch (err) {
		throw invalid(`The address could not be looked up: ${err.message}`);
	}
	const best = matches[0];
	if (!best || !geo.isPoint(best)) throw invalid("That address could not be found");
	return {
		place_uuid: null,
		place_name: (trim(raw.place_name, 80) || placeRef || best.label.split(",")[0]).slice(0, 80),
		address: best.label.slice(0, 255),
		latitude: best.latitude,
		longitude: best.longitude,
	};
}

async function armedCount(profileId) {
	const [rows] = await pool.query(
		"SELECT COUNT(*) AS n FROM athena_place_reminder WHERE profile_id = ? AND status = 'armed'",
		[profileId]
	);
	return Number(rows[0]?.n || 0);
}

/** Called only from the remind_at_place action's execute(), with params normalize() vouched for. */
async function create(profileId, params, { actionUuid = null } = {}) {
	if ((await armedCount(profileId)) >= MAX_ARMED) {
		throw bad(`You already have ${MAX_ARMED} place reminders waiting; remove one on the Community page first.`, 409);
	}
	const uuid = randomUUID();
	await pool.query(
		`INSERT INTO athena_place_reminder
			(uuid, profile_id, place_uuid, place_name, address, latitude, longitude, radius_m, text, repeats, action_uuid)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			uuid,
			profileId,
			params.place_uuid || null,
			params.place_name,
			params.address || null,
			params.latitude,
			params.longitude,
			ARRIVAL_RADIUS_M,
			params.reminder,
			params.repeats === "every_visit" ? 1 : 0,
			actionUuid,
		]
	);
	const pref = await location.getPref(profileId).catch(() => ({ enabled: false }));
	return { uuid, locationSharing: !!pref.enabled };
}

/** Armed reminders, then the last fortnight's finished ones, for the Community page. */
async function list(profileId) {
	const [rows] = await pool.query(
		`SELECT * FROM athena_place_reminder
		 WHERE profile_id = ? AND (status = 'armed' OR (status = 'done' AND done_at >= NOW() - INTERVAL 14 DAY))
		 ORDER BY status = 'armed' DESC, created_at DESC LIMIT 100`,
		[profileId]
	);
	return rows.map(toReminder);
}

async function cancel(profileId, uuid) {
	const [result] = await pool.query(
		"UPDATE athena_place_reminder SET status = 'cancelled' WHERE profile_id = ? AND uuid = ? AND status = 'armed'",
		[profileId, String(uuid || "")]
	);
	if (!result.affectedRows) throw bad("That reminder isn't waiting any more.", 404);
	return list(profileId);
}

/**
 * What the phone should watch for. Empty while location sharing is off, so
 * turning it off also stops the phone holding any fences on the next sync.
 */
async function geofences(profileId) {
	const pref = await location.getPref(profileId);
	if (!pref.enabled) return { enabled: false, fences: [] };
	const [rows] = await pool.query(
		`SELECT uuid, latitude, longitude, radius_m FROM athena_place_reminder
		 WHERE profile_id = ? AND status = 'armed' ORDER BY created_at LIMIT ?`,
		[profileId, MAX_ARMED]
	);
	return {
		enabled: true,
		fences: rows.map((r) => ({
			id: r.uuid,
			latitude: Number(r.latitude),
			longitude: Number(r.longitude),
			radius_m: radiusOf(r),
		})),
	};
}

function wording(row) {
	return `You're at ${row.place_name} — you asked me to remind you: ${row.text}`.slice(0, 500);
}

/**
 * The phone says it has been inside a fence for a couple of minutes.
 *
 * The phone's word is not taken for which reminder: the server compares the
 * reported position with every armed reminder itself, so a stale or wrong
 * fence on the handset can only ever fail to fire, never fire the wrong one.
 * The position goes through location.recordSample, which refuses it unless
 * location sharing is on and keeps it only for that pref's retention window.
 */
async function arrived(profileId, deviceId, body = {}, { now = Date.now() } = {}) {
	await location.recordSample({ profileId, deviceId, body });
	const observed = new Date(body.observed_at).getTime();
	if (!(now - observed <= ARRIVAL_FRESH_MS)) return { fired: [], skipped: "stale position" };
	const here = { latitude: Number(body.latitude), longitude: Number(body.longitude) };
	const accuracy = Math.min(Math.max(Number(body.accuracy_m) || 0, 0), MAX_ACCURACY_M);

	const [rows] = await pool.query(
		"SELECT * FROM athena_place_reminder WHERE profile_id = ? AND status = 'armed'",
		[profileId]
	);
	const fired = [];
	for (const row of rows) {
		const miles = geo.milesBetween(here, { latitude: Number(row.latitude), longitude: Number(row.longitude) });
		if (miles === null) continue;
		const meters = miles * METERS_PER_MILE;
		if (meters > (radiusOf(row)) + accuracy + SLACK_M) continue;

		// Claim this visit. A second arrival in the same visit (a fence
		// re-registered while they're still there, two phones) changes nothing.
		const [claim] = await pool.query(
			`UPDATE athena_place_reminder SET fire_count = fire_count + 1, last_fired_at = NOW()
			 WHERE id = ? AND status = 'armed'
			   AND (last_fired_at IS NULL OR last_fired_at < NOW() - INTERVAL ? HOUR)`,
			[row.id, SAME_VISIT_HOURS]
		);
		if (!claim.affectedRows) continue;

		const uuid = randomUUID();
		const text = wording(row);
		await pool.query(
			`INSERT IGNORE INTO athena_nudge
				(uuid, profile_id, trigger_id, dedupe_key, urgency, text, facts, expires_at)
			 VALUES (?, ?, ?, ?, 'normal', ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
			[
				uuid,
				profileId,
				TRIGGER_ID,
				`${row.uuid}:${Number(row.fire_count || 0) + 1}`,
				text,
				JSON.stringify({ reminderUuid: row.uuid, placeName: row.place_name, meters: Math.round(meters) }),
				NUDGE_TTL_S,
			]
		);
		const push = require("./push");
		const pushed = await push
			.deliverNudge(profileId, { uuid, text, trigger_id: TRIGGER_ID })
			.catch((error) => ({ sent: 0, error: error.message }));
		const reached = Number(pushed?.sent || 0) > 0;
		if (reached && !(row.repeats === 1 || row.repeats === true)) {
			await pool.query(
				"UPDATE athena_place_reminder SET status = 'done', done_at = NOW() WHERE id = ? AND status = 'armed'",
				[row.id]
			);
		}
		fired.push({ uuid: row.uuid, pushed: reached });
	}
	return { fired };
}

/**
 * What she has set, for her own prompt — so "what did I ask you to remind me
 * at Missy's?" has an answer, and so she says so when location sharing is off
 * rather than promising a reminder that cannot fire.
 */
async function promptBlock(profileId) {
	if (!profileId) return null;
	const [[rows], pref] = await Promise.all([
		pool.query(
			`SELECT place_name, address, text, repeats FROM athena_place_reminder
			 WHERE profile_id = ? AND status = 'armed' ORDER BY created_at LIMIT 20`,
			[profileId]
		),
		location.getPref(profileId).catch(() => ({ enabled: false })),
	]);
	const lines = [];
	if (rows.length) {
		lines.push("# Place reminders they've set", "");
		for (const r of rows) {
			const where = r.address ? `${r.place_name} (${r.address})` : r.place_name;
			lines.push(`- At ${where}: "${r.text}" — ${r.repeats ? "every visit" : "next visit only"}`);
		}
		lines.push("", "They can remove one on the Community page; you cannot remove one for them.");
	}
	if (!pref.enabled) {
		if (!lines.length) lines.push("# Place reminders", "");
		lines.push(
			"Location sharing is OFF, so a place reminder cannot fire. If they ask for one, still offer it, but say it",
			"needs location sharing on (⋯ menu → Initiative → location context) and Athena allowed location \"all the time\" on the phone."
		);
	}
	return lines.length ? lines.join("\n") : null;
}

module.exports = {
	TRIGGER_ID,
	ARRIVAL_RADIUS_M,
	MAX_ARMED,
	resolvePlace,
	create,
	list,
	cancel,
	geofences,
	arrived,
	promptBlock,
};
