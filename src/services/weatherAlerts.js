/**
 * Weather alerts the person sets for themselves.
 *
 *   weatherAlerts.list(profileId)            their rules, each with what the forecast says next
 *   weatherAlerts.save(profileId, input)     add or change one ("34°F or colder at Home")
 *   weatherAlerts.remove(profileId, uuid)
 *   weatherAlerts.checkDue({ now })          the athena-incidents job's pass
 *   weatherAlerts.promptBlock(profileId)     what she has been asked to watch, for chat
 *
 * Built 2026-10-18 at the owner's request ahead of the first frost. A rule is
 * read against the NWS hourly forecast (about six days) for one watched place,
 * and tells once per occurrence — a cold night, a rainy day — when that
 * occurrence comes inside the rule's lead time (24 hours unless they chose
 * otherwise).
 *
 * These are the person's own requests, the same footing as a place reminder:
 * they are not Initiative and do not wait on its opt-in. What they do get is
 * a night hold. A frost rule that first sees Tuesday's freeze at 2 AM Monday
 * says so at 7 AM, not at 2 — unless the weather itself is under six hours
 * away, in which case now is the only useful time. A held alert writes
 * nothing and is re-read on the next pass, so the hold delays and never drops.
 *
 * The forecast moving is not an event. A night that warms after it was told
 * gets no "never mind", and a night that cools further is not told twice.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../helpers/db");
const weather = require("./weather");
const watch = require("./pulsepoint/watch");

const TRIGGER_ID = "weather_alert";
const NUDGE_TTL_S = 36 * 3600;
const MAX_RULES = 20;
/** How often a rule re-reads the forecast. NWS updates hourly; this is half that. */
const RECHECK_MINUTES = 30;
/** The night hold: 10 PM to 7 AM at the place, unless the weather is closer than this. */
const HOLD_FROM = 22;
const HOLD_UNTIL = 7;
const HOLD_UNLESS_WITHIN_H = 6;

/**
 * What each kind watches. `threshold` is required where it has a unit and
 * has a sensible default; the bounds are what a forecast can actually say.
 */
const KINDS = {
	cold: { unit: "°F", fallback: 34, min: -40, max: 60, label: "Cold", test: (h, t) => Number.isFinite(h.temperatureF) && h.temperatureF <= t, value: (h) => h.temperatureF, worst: Math.min },
	heat: { unit: "°F", fallback: 95, min: 60, max: 125, label: "Heat", test: (h, t) => Number.isFinite(h.temperatureF) && h.temperatureF >= t, value: (h) => h.temperatureF, worst: Math.max },
	rain: { unit: "%", fallback: 60, min: 10, max: 100, label: "Rain", test: (h, t) => Number.isFinite(h.precipitationChance) && h.precipitationChance >= t && !/snow|sleet|freezing|ice/i.test(h.shortForecast || ""), value: (h) => h.precipitationChance, worst: Math.max },
	snow: { unit: null, label: "Snow", test: (h) => /snow|flurr|blizzard/i.test(h.shortForecast || ""), value: (h) => h.precipitationChance, worst: Math.max },
	ice: { unit: null, label: "Ice", test: (h) => /sleet|freezing|ice/i.test(h.shortForecast || ""), value: (h) => h.precipitationChance, worst: Math.max },
	storm: { unit: null, label: "Thunderstorms", test: (h) => /thunder/i.test(h.shortForecast || ""), value: (h) => h.precipitationChance, worst: Math.max },
	wind: { unit: "mph", fallback: 35, min: 10, max: 150, label: "Wind", test: (h, t) => Number.isFinite(h.windMph) && h.windMph >= t, value: (h) => h.windMph, worst: Math.max },
};

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function shape(row, place) {
	return {
		uuid: row.uuid,
		kind: row.kind,
		threshold: row.threshold === null ? null : Number(row.threshold),
		unit: KINDS[row.kind]?.unit || null,
		placeUuid: row.place_uuid || null,
		placeName: place?.name || (row.place_uuid ? "a removed place" : "Home"),
		leadHours: Number(row.lead_hours),
		note: row.note || null,
		enabled: row.enabled === 1 || row.enabled === true,
		lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
		lastError: row.last_error || null,
	};
}

/** The rule's place: the one it names, else home, else the first watched place. */
function placeFor(places, placeUuid) {
	const usable = places.filter((p) => p.enabled && Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
	if (placeUuid) return usable.find((p) => p.uuid === placeUuid) || null;
	return usable.find((p) => p.kind === "home") || usable[0] || null;
}

/** "°F 34" -> "34°F"; "wind 35" -> "35 mph". */
function amount(kind, value) {
	if (!Number.isFinite(value)) return null;
	const unit = KINDS[kind]?.unit;
	if (!unit) return `${value}%`;
	return unit === "mph" ? `${value} mph` : `${value}${unit}`;
}

/** What the rule says, in words: "34°F or colder", "rain 60% or more". */
function describe(rule) {
	const t = rule.threshold;
	switch (rule.kind) {
		case "cold": return `${t}°F or colder`;
		case "heat": return `${t}°F or hotter`;
		case "rain": return `rain ${t}% likely or more`;
		case "wind": return `wind or gusts of ${t} mph or more`;
		case "snow": return "any snow";
		case "ice": return "sleet or freezing rain";
		case "storm": return "thunderstorms";
		default: return rule.kind;
	}
}

/**
 * Every occurrence of the rule in the forecast, soonest first, between now
 * and `untilMs`. One per local day — per night for cold, so 11 PM and 6 AM
 * are the same frost — carrying the worst value and when it is.
 */
function occurrences(rule, hours, { now = Date.now(), untilMs = Infinity } = {}) {
	const kind = KINDS[rule.kind];
	if (!kind) return [];
	const found = new Map();
	for (const hour of hours) {
		const at = weather.local(hour.start);
		if (!at || at.ms + 3_600_000 <= now || at.ms > untilMs) continue;
		if (!kind.test(hour, rule.threshold)) continue;
		const key = rule.kind === "cold" ? at.night : at.date;
		const value = kind.value(hour);
		const seen = found.get(key);
		if (!seen) found.set(key, { key, first: at.ms, value, at: hour.start, hour });
		else if (Number.isFinite(value) && (!Number.isFinite(seen.value) || kind.worst(value, seen.value) !== seen.value)) {
			Object.assign(seen, { value, at: hour.start, hour });
		}
	}
	return [...found.values()].sort((a, b) => a.first - b.first);
}

/** "around 6 AM Monday", "around 3 PM today", "tonight around 11 PM". */
function whenText(iso, nowIso) {
	const at = weather.local(iso);
	const today = weather.local(nowIso);
	if (!at) return "";
	const h = at.hour % 12 || 12;
	const clock = `${h} ${at.hour < 12 ? "AM" : "PM"}`;
	const days = today ? Math.round((Date.parse(`${at.date}T00:00:00Z`) - Date.parse(`${today.date}T00:00:00Z`)) / 86_400_000) : null;
	if (days === 0) return at.hour >= 18 ? `tonight around ${clock}` : `around ${clock} today`;
	if (days === 1) return `around ${clock} tomorrow`;
	const weekday = new Date(`${at.date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long" });
	return `around ${clock} ${weekday}`;
}

/** The alert itself. Plain facts, with the person's own note at the end. */
function wording(rule, placeName, occ, nowIso) {
	const when = whenText(occ.at, nowIso);
	const sky = occ.hour?.shortForecast ? ` (${occ.hour.shortForecast.toLowerCase()})` : "";
	let line;
	switch (rule.kind) {
		case "cold": {
			const word = occ.value <= 32 ? "Freeze" : "Frost";
			const risk = weather.frostRisk(occ.value, occ.hour);
			const read = risk === "likely" ? " — clear and still enough for frost" : "";
			line = `${word} alert for ${placeName}: down to ${occ.value}°F ${when}${read}.`;
			break;
		}
		case "heat":
			line = `Heat alert for ${placeName}: up to ${occ.value}°F ${when}.`;
			break;
		case "rain":
			line = `Rain alert for ${placeName}: ${occ.value}% chance ${when}${sky}.`;
			break;
		case "wind":
			line = `Wind alert for ${placeName}: up to ${occ.value} mph ${when}${occ.hour?.windDirection ? ` from the ${occ.hour.windDirection}` : ""}.`;
			break;
		default:
			line = `${KINDS[rule.kind].label} alert for ${placeName}: ${occ.hour?.shortForecast || KINDS[rule.kind].label.toLowerCase()} ${when}.`;
	}
	return `${line}${rule.note ? ` ${rule.note}` : ""}`.slice(0, 500);
}

/** Clean and bound what the panel sends. Throws a 400 whose message is safe to show. */
function normalize(input = {}) {
	const kind = String(input.kind || "").toLowerCase();
	const spec = KINDS[kind];
	if (!spec) throw bad("Pick what to watch for: cold, heat, rain, snow, ice, storms or wind.");
	let threshold = null;
	if (spec.unit) {
		threshold = input.threshold === undefined || input.threshold === null || input.threshold === "" ? spec.fallback : Math.round(Number(input.threshold));
		if (!Number.isFinite(threshold) || threshold < spec.min || threshold > spec.max) {
			throw bad(`${spec.label} needs a number between ${spec.min} and ${spec.max}${spec.unit === "mph" ? " mph" : spec.unit}.`);
		}
	}
	const lead = input.leadHours === undefined || input.leadHours === null || input.leadHours === "" ? 24 : Math.round(Number(input.leadHours));
	if (!Number.isFinite(lead) || lead < 3 || lead > 120) throw bad("Warn me between 3 hours and 5 days ahead.");
	const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 200) : null;
	const placeUuid = typeof input.placeUuid === "string" && input.placeUuid.trim() ? input.placeUuid.trim().slice(0, 36) : null;
	return { kind, threshold, leadHours: lead, note, placeUuid, enabled: input.enabled === false ? 0 : 1 };
}

async function rows(profileId) {
	const [list] = await pool.query("SELECT * FROM athena_weather_alert WHERE profile_id = ? ORDER BY created_at", [profileId]);
	return list;
}

async function recentFires(profileId, days = 14) {
	const [list] = await pool.query(
		`SELECT a.uuid, f.occurrence, f.value, f.weather_at, f.text, f.pushed, f.fired_at
		 FROM athena_weather_alert_fire f JOIN athena_weather_alert a ON a.id = f.alert_id
		 WHERE a.profile_id = ? AND f.fired_at >= NOW() - INTERVAL ? DAY
		 ORDER BY f.fired_at DESC LIMIT 30`,
		[profileId, days]
	);
	return list.map((r) => ({
		alertUuid: r.uuid,
		text: r.text,
		value: r.value === null ? null : Number(r.value),
		weatherAt: r.weather_at ? new Date(r.weather_at).toISOString() : null,
		pushed: r.pushed === 1 || r.pushed === true,
		firedAt: new Date(r.fired_at).toISOString(),
	}));
}

/**
 * Their rules, each with the next time the forecast meets it (looking past
 * the lead time, to the end of what NWS forecasts), and what was sent lately.
 * Reading this never sends anything.
 */
async function list(profileId) {
	const [list, places, fires] = await Promise.all([rows(profileId), watch.listPlaces(profileId), recentFires(profileId)]);
	const forecasts = new Map();
	const read = (place) => {
		const key = `${place.latitude},${place.longitude}`;
		if (!forecasts.has(key)) forecasts.set(key, weather.hourlyRows(place.latitude, place.longitude).catch(() => null));
		return forecasts.get(key);
	};
	const alerts = await Promise.all(
		list.map(async (row) => {
			const place = placeFor(places, row.place_uuid);
			const out = { ...shape(row, place), describe: describe(row), next: null, forecastKnown: false };
			if (!place) return out;
			const sky = await read(place);
			if (!sky) return out;
			out.forecastKnown = true;
			const [next] = occurrences(row, sky.hours);
			if (next) out.next = { at: next.at, value: next.value, when: whenText(next.at, sky.hours[0]?.start), label: amount(row.kind, next.value) };
			return out;
		})
	);
	return { alerts, recent: fires, places: places.filter((p) => p.enabled).map((p) => ({ uuid: p.uuid, name: p.name, kind: p.kind })), kinds: Object.keys(KINDS) };
}

async function save(profileId, input = {}) {
	const clean = normalize(input);
	if (clean.placeUuid) {
		const places = await watch.listPlaces(profileId);
		if (!places.some((p) => p.uuid === clean.placeUuid)) throw bad("That place isn't on your list any more.");
	}
	if (input.uuid) {
		const [result] = await pool.query(
			`UPDATE athena_weather_alert SET kind = ?, threshold = ?, place_uuid = ?, lead_hours = ?, note = ?, enabled = ?,
			   last_checked_at = NULL, last_error = NULL
			 WHERE profile_id = ? AND uuid = ?`,
			[clean.kind, clean.threshold, clean.placeUuid, clean.leadHours, clean.note, clean.enabled, profileId, String(input.uuid)]
		);
		if (!result.affectedRows) throw bad("That alert isn't there any more.", 404);
	} else {
		const [[count]] = await pool.query("SELECT COUNT(*) AS n FROM athena_weather_alert WHERE profile_id = ?", [profileId]);
		if (Number(count.n) >= MAX_RULES) throw bad(`You can have up to ${MAX_RULES} weather alerts.`);
		await pool.query(
			`INSERT INTO athena_weather_alert (uuid, profile_id, kind, threshold, place_uuid, lead_hours, note, enabled)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[randomUUID(), profileId, clean.kind, clean.threshold, clean.placeUuid, clean.leadHours, clean.note, clean.enabled]
		);
	}
	return list(profileId);
}

async function remove(profileId, uuid) {
	const [[row]] = await pool.query("SELECT id FROM athena_weather_alert WHERE profile_id = ? AND uuid = ?", [profileId, String(uuid)]);
	if (!row) throw bad("That alert isn't there any more.", 404);
	await pool.query("DELETE FROM athena_weather_alert_fire WHERE alert_id = ?", [row.id]);
	await pool.query("DELETE FROM athena_weather_alert WHERE id = ?", [row.id]);
	return list(profileId);
}

/** Is it night at the place, by the forecast's own clock? */
function heldForNight(nowIso, occ, now) {
	const here = weather.local(nowIso);
	if (!here) return false;
	const night = here.hour >= HOLD_FROM || here.hour < HOLD_UNTIL;
	return night && occ.first - now > HOLD_UNLESS_WITHIN_H * 3_600_000;
}

/** Local wall-clock ISO for "now" at the place, written in the forecast's offset. */
function nowAt(hours, now) {
	const sample = hours.find((h) => weather.local(h.start)) || null;
	const offset = sample ? /([+-]\d{2}:\d{2})$/.exec(sample.start)?.[1] : null;
	if (!offset) return new Date(now).toISOString();
	const sign = offset.startsWith("-") ? -1 : 1;
	const minutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
	return `${new Date(now + minutes * 60_000).toISOString().slice(0, 19)}${offset}`;
}

/**
 * Send what is due. One pass of the athena-incidents job; safe to run
 * concurrently with itself (the fire row's unique key is the claim).
 * `dryRun` reads and words everything and writes nothing.
 */
async function checkDue({ now = new Date(), dryRun = false, limit = 200 } = {}) {
	const nowMs = now.getTime();
	const [due] = await pool.query(
		`SELECT * FROM athena_weather_alert
		 WHERE enabled = 1 AND (last_checked_at IS NULL OR last_checked_at < ? - INTERVAL ? MINUTE)
		 ORDER BY last_checked_at IS NULL DESC, last_checked_at LIMIT ?`,
		[now, RECHECK_MINUTES, limit]
	);
	const totals = { checked: 0, sent: 0, held: 0, failed: 0, messages: [] };
	const placesByProfile = new Map();
	const forecasts = new Map();
	for (const rule of due) {
		totals.checked += 1;
		try {
			if (!placesByProfile.has(rule.profile_id)) placesByProfile.set(rule.profile_id, await watch.listPlaces(rule.profile_id));
			const place = placeFor(placesByProfile.get(rule.profile_id), rule.place_uuid);
			if (!place) throw new Error(rule.place_uuid ? "Its place was removed or paused." : "There's no watched place to read the weather for.");
			const key = `${place.latitude},${place.longitude}`;
			if (!forecasts.has(key)) forecasts.set(key, await weather.hourlyRows(place.latitude, place.longitude).catch(() => null));
			const sky = forecasts.get(key);
			// No forecast is "I don't know", never "it's fine": the rule is re-read
			// next pass, and the panel shows why it is waiting.
			if (!sky) throw new Error("The weather service didn't answer.");
			const nowIso = nowAt(sky.hours, nowMs);
			for (const occ of occurrences(rule, sky.hours, { now: nowMs, untilMs: nowMs + Number(rule.lead_hours) * 3_600_000 })) {
				const [[already]] = await pool.query("SELECT id FROM athena_weather_alert_fire WHERE alert_id = ? AND occurrence = ?", [rule.id, occ.key]);
				if (already) continue;
				if (heldForNight(nowIso, occ, nowMs)) {
					totals.held += 1;
					continue;
				}
				const text = wording(rule, place.name, occ, nowIso);
				totals.messages.push({ profileId: rule.profile_id, text });
				if (dryRun) continue;
				const [claim] = await pool.query(
					`INSERT IGNORE INTO athena_weather_alert_fire (alert_id, occurrence, value, weather_at, text) VALUES (?, ?, ?, ?, ?)`,
					[rule.id, occ.key, Number.isFinite(occ.value) ? occ.value : null, new Date(occ.at), text]
				);
				if (!claim.affectedRows) continue;
				const uuid = randomUUID();
				await pool.query(
					`INSERT IGNORE INTO athena_nudge
						(uuid, profile_id, trigger_id, dedupe_key, urgency, text, facts, expires_at)
					 VALUES (?, ?, ?, ?, 'normal', ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
					[
						uuid,
						rule.profile_id,
						TRIGGER_ID,
						`${rule.uuid}:${occ.key}`,
						text,
						JSON.stringify({ alertUuid: rule.uuid, kind: rule.kind, place: place.name, value: occ.value, at: occ.at }),
						NUDGE_TTL_S,
					]
				);
				const push = require("./push");
				const pushed = await push
					.deliverNudge(rule.profile_id, { uuid, text, trigger_id: TRIGGER_ID })
					.catch((error) => ({ sent: 0, error: error.message }));
				await pool.query("UPDATE athena_weather_alert_fire SET nudge_uuid = ?, pushed = ? WHERE alert_id = ? AND occurrence = ?", [
					uuid,
					Number(pushed?.sent || 0) > 0 ? 1 : 0,
					rule.id,
					occ.key,
				]);
				totals.sent += 1;
			}
			if (!dryRun) await pool.query("UPDATE athena_weather_alert SET last_checked_at = ?, last_error = NULL WHERE id = ?", [now, rule.id]);
		} catch (error) {
			totals.failed += 1;
			if (!dryRun) {
				await pool
					.query("UPDATE athena_weather_alert SET last_checked_at = ?, last_error = ? WHERE id = ?", [now, String(error.message).slice(0, 190), rule.id])
					.catch(() => undefined);
			}
		}
	}
	return totals;
}

/** What she has been asked to watch, so "will you tell me if it frosts?" has a true answer. */
async function promptBlock(profileId) {
	const list = await rows(profileId);
	const on = list.filter((r) => r.enabled === 1 || r.enabled === true);
	if (!on.length) {
		return "# Weather alerts\n\nNone set. If they want to hear about frost, heat, rain, snow, ice, storms or wind ahead of time, they can add an alert in Community → Weather alerts.";
	}
	const places = await watch.listPlaces(profileId);
	const lines = ["# Weather alerts they've set", ""];
	for (const r of on) {
		const place = placeFor(places, r.place_uuid);
		lines.push(`- ${describe(r)} at ${place?.name || "home"}, up to ${r.lead_hours} h ahead${r.note ? ` — note: "${r.note}"` : ""}`);
	}
	lines.push("", "They manage these in Community → Weather alerts; you cannot change them for them.");
	return lines.join("\n");
}

/**
 * The place a person's home weather is read for: the one they asked for, else
 * their watched place marked home, else their first. Null when they have none
 * with coordinates. Shared by the Weather panel and the freeze-risk trigger.
 */
async function homePlace(profileId, wanted = null) {
	const watch = require("./pulsepoint/watch");
	const places = (await watch.listPlaces(profileId)).filter(
		(p) => p.enabled && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)
	);
	return (wanted && places.find((p) => p.uuid === wanted)) || places.find((p) => p.kind === "home") || places[0] || null;
}

module.exports = { homePlace, list, save, remove, checkDue, promptBlock, occurrences, wording, normalize, describe, whenText, heldForNight, KINDS, TRIGGER_ID };
