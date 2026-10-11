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
const wakeups = require("./reminderWakeups");

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
/**
 * Once a condition is met ("you were at the gym"), how long the reminder
 * waits for the place it fires at before it expires and they're asked about it.
 */
const AFTER_MET_HOURS = 12;
/** Arrivals inside this window after the last one are the same visit. */
const SAME_VISIT_HOURS = 8;
/** A position older than this is where they were, not where they are. */
const ARRIVAL_FRESH_MS = 15 * 60_000;
/** Slack on top of the fence for GPS error; accuracy is capped so a 5 km fix can't count. */
const MAX_ACCURACY_M = 250;
const SLACK_M = 50;
/** The "still want it?" card after a conditional reminder expires. */
const EXPIRED_NUDGE_TTL_S = 12 * 60 * 60;
/** The in-app card stays this long if the push didn't reach them. */
const NUDGE_TTL_S = 2 * 60 * 60;
const METERS_PER_MILE = 1609.344;

const invalid = (message) => Object.assign(new Error(message), { status: 400, code: "invalid_action_params" });
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const trim = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
/** "Missy's house" and "missys  house" are the same name; punctuation and case aren't. */
const HOME_WORDS = new Set(["home", "my house", "our house", "the house", "my home", "house"]);
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
		// "When I get home FROM THE GYM": what has to happen first, and whether it has.
		condition: row.after_kind
			? {
					kind: row.after_kind,
					label: row.after_label || null,
					after: row.after_at || null,
					metAt: row.condition_met_at || null,
				}
			: null,
		expiresAt: row.expires_at || null,
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
		const found =
			places.find((p) => p.uuid === placeRef) ||
			places.find((p) => nameKey(p.name) === wanted) ||
			// "When I get home": the point of interest marked as home, whatever it's called.
			(HOME_WORDS.has(wanted) ? places.find((p) => p.kind === "home") : null);
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
		"SELECT COUNT(*) AS n FROM athena_place_reminder WHERE profile_id = ? AND status IN ('armed', 'waiting')",
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
	const after = params.after || null;
	await pool.query(
		`INSERT INTO athena_place_reminder
			(uuid, profile_id, place_uuid, place_name, address, latitude, longitude, radius_m, text, repeats, action_uuid,
			 status, after_kind, after_label, after_latitude, after_longitude, after_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			after ? "waiting" : "armed",
			after?.kind || null,
			after?.label || null,
			after?.latitude ?? null,
			after?.longitude ?? null,
			after?.at ? new Date(after.at) : null,
			after?.expires_at ? new Date(after.expires_at) : null,
		]
	);
	// The "still want it?" check, booked for the moment the window closes.
	if (after?.expires_at) await wakeups.wakeAt(after.expires_at);
	const pref = await location.getPref(profileId).catch(() => ({ enabled: false }));
	return { uuid, locationSharing: !!pref.enabled };
}

/** Armed reminders, then the last fortnight's finished ones, for the Community page. */
async function list(profileId) {
	const [rows] = await pool.query(
		`SELECT * FROM athena_place_reminder
		 WHERE profile_id = ? AND (status IN ('armed', 'waiting')
		   OR (status IN ('done', 'expired') AND COALESCE(done_at, expires_at) >= NOW() - INTERVAL 14 DAY))
		 ORDER BY status IN ('armed', 'waiting') DESC, created_at DESC LIMIT 100`,
		[profileId]
	);
	return rows.map(toReminder);
}

async function cancel(profileId, uuid) {
	const [result] = await pool.query(
		"UPDATE athena_place_reminder SET status = 'cancelled' WHERE profile_id = ? AND uuid = ? AND status IN ('armed', 'waiting')",
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
		`SELECT uuid, status, latitude, longitude, radius_m, after_kind, after_latitude, after_longitude
		 FROM athena_place_reminder
		 WHERE profile_id = ? AND status IN ('armed', 'waiting') ORDER BY created_at LIMIT ?`,
		[profileId, MAX_ARMED]
	);
	const fences = [];
	for (const r of rows) {
		fences.push({ id: r.uuid, latitude: Number(r.latitude), longitude: Number(r.longitude), radius_m: radiusOf(r) });
		// The condition's own fence ("the gym"), held from the start so the
		// phone needn't re-sync when it is met. It reports only "was there";
		// the server decides what that means (arrived()).
		if (r.status === "waiting" && r.after_kind === "place" && r.after_latitude != null) {
			fences.push({
				id: `${r.uuid}:after`,
				latitude: Number(r.after_latitude),
				longitude: Number(r.after_longitude),
				radius_m: ARRIVAL_RADIUS_M,
			});
		}
	}
	// Android allows 100 per app.
	return { enabled: true, fences: fences.slice(0, 2 * MAX_ARMED) };
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
		"SELECT * FROM athena_place_reminder WHERE profile_id = ? AND status IN ('armed', 'waiting')",
		[profileId]
	);
	const at = new Date(now);
	/** Metres from here to a point, or null when it is outside the fence. */
	const inside = (latitude, longitude, radius) => {
		const miles = geo.milesBetween(here, { latitude: Number(latitude), longitude: Number(longitude) });
		if (miles === null) return null;
		const meters = miles * METERS_PER_MILE;
		return meters > radius + accuracy + SLACK_M ? null : meters;
	};
	const fired = [];
	const met = [];
	for (const row of rows) {
		// Past its window: the expiry sweep asks them about it; it never fires late.
		if (row.expires_at && new Date(row.expires_at) <= at) continue;

		// "From the gym": being at the condition's place meets the condition and
		// nothing more. Home must still come after it.
		if (row.status === "waiting" && row.after_kind === "place" && row.after_latitude != null) {
			if (inside(row.after_latitude, row.after_longitude, ARRIVAL_RADIUS_M) !== null) {
				const [claim] = await pool.query(
					`UPDATE athena_place_reminder SET status = 'armed', condition_met_at = ?, expires_at = ?
					 WHERE id = ? AND status = 'waiting'`,
					[at, new Date(now + AFTER_MET_HOURS * 3600_000), row.id]
				);
				if (claim.affectedRows) {
					met.push({ uuid: row.uuid });
					await wakeups.wakeAt(new Date(now + AFTER_MET_HOURS * 3600_000));
				}
			}
			continue;
		}

		const meters = inside(row.latitude, row.longitude, radiusOf(row));
		if (meters === null) continue;

		// "After the last game": a time condition is checked on arrival.
		if (row.status === "waiting") {
			if (!(row.after_kind === "time" && row.after_at && new Date(row.after_at) <= at)) continue;
			await pool.query(
				"UPDATE athena_place_reminder SET status = 'armed', condition_met_at = ? WHERE id = ? AND status = 'waiting'",
				[at, row.id]
			);
		}

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
	return { fired, met };
}

/**
 * Conditional reminders whose window closed before they could fire. Never
 * dropped silently (owner's choice, 2026-10-10): each becomes 'expired' and
 * the person is asked once whether they still want it. Run by the
 * athena-reminders job (woken for each deadline) and the hourly backstop;
 * safe to run concurrently with itself.
 */
async function expireDue({ now = new Date() } = {}) {
	const [rows] = await pool.query(
		`SELECT * FROM athena_place_reminder
		 WHERE status IN ('armed', 'waiting') AND expires_at IS NOT NULL AND expires_at <= ? LIMIT 100`,
		[now]
	);
	const push = require("./push");
	let asked = 0;
	for (const row of rows) {
		const [claim] = await pool.query(
			`UPDATE athena_place_reminder SET status = 'expired', expiry_asked_at = ?
			 WHERE id = ? AND status IN ('armed', 'waiting')`,
			[now, row.id]
		);
		if (!claim.affectedRows) continue;
		const why =
			row.status === "waiting"
				? `it looks like you didn't make it to ${row.after_label || "the first place"}`
				: `you didn't get to ${row.place_name} in time`;
		const text = `I didn't get to remind you to "${row.text}" — ${why}. Still want it? Just tell me and I'll set it again.`.slice(0, 500);
		const uuid = randomUUID();
		await pool.query(
			`INSERT IGNORE INTO athena_nudge
				(uuid, profile_id, trigger_id, dedupe_key, urgency, text, facts, expires_at)
			 VALUES (?, ?, ?, ?, 'normal', ?, ?, ?)`,
			[
				uuid,
				row.profile_id,
				TRIGGER_ID,
				`${row.uuid}:expired`,
				text,
				JSON.stringify({ reminderUuid: row.uuid, expired: true, placeName: row.place_name, after: row.after_label }),
				new Date(now.getTime() + EXPIRED_NUDGE_TTL_S * 1000),
			]
		);
		await push
			.deliverNudge(row.profile_id, { uuid, text, trigger_id: TRIGGER_ID })
			.catch((error) => ({ sent: 0, error: error.message }));
		asked += 1;
	}
	return { asked };
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
			`SELECT place_name, address, text, repeats, status, after_kind, after_label, expires_at
			 FROM athena_place_reminder
			 WHERE profile_id = ? AND (status IN ('armed', 'waiting')
			   OR (status = 'expired' AND expiry_asked_at >= NOW() - INTERVAL 1 DAY))
			 ORDER BY created_at LIMIT 20`,
			[profileId]
		),
		location.getPref(profileId).catch(() => ({ enabled: false })),
	]);
	const lines = [];
	if (rows.length) {
		lines.push("# Place reminders they've set", "");
		for (const r of rows) {
			const where = r.address ? `${r.place_name} (${r.address})` : r.place_name;
			if (r.status === "expired") {
				lines.push(`- EXPIRED (you asked them if they still want it): at ${where}, after ${r.after_label || "a condition"}: "${r.text}" — if they say yes, propose it again`);
				continue;
			}
			const first = r.after_kind ? `, only after ${r.after_label || "a condition"}${r.status === "armed" ? " (that's happened)" : ""}` : "";
			lines.push(`- At ${where}${first}: "${r.text}" — ${r.repeats ? "every visit" : "next visit only"}`);
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
	AFTER_MET_HOURS,
	resolvePlace,
	create,
	expireDue,
	list,
	cancel,
	geofences,
	arrived,
	promptBlock,
};
