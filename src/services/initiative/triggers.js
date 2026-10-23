/**
 * Trigger registry — the conditions that justify Athena speaking first.
 *
 * The division of labour here is the whole design:
 *
 *   RULES decide WHETHER to interrupt.   (this file, deterministic)
 *   The MODEL decides only HOW to word it. (index.js, one short call)
 *
 * It would be easier to hand the model a pile of context and ask "is
 * anything worth mentioning?". We don't, for three reasons. It is expensive
 * to run every few minutes per person. Its judgement about what deserves an
 * interruption is not stable, so the same situation gets raised on Tuesday
 * and ignored on Wednesday. And it makes the honest answer to "why did she
 * bring that up?" unavailable — there is nothing to point at but a prompt.
 *
 * With rules, `facts` on the nudge row IS the reason, and a trigger that
 * fires too often is a threshold somebody can change.
 *
 * Triggers used to carry a `cooldownMs` — a per-trigger minimum gap. It was
 * removed with the rest of the interruption budget (see index.js): it worked
 * by discarding observations, and it was doing nothing that `dedupeKey` was
 * not already doing correctly. Every dedupe key here is per-occurrence — an
 * event id, a sorted clash pair, a local date — so the same thing is raised
 * exactly once without any need for a clock.
 *
 * Descriptor fields:
 *   id           stored in athena_nudge.trigger_id
 *   label        how the settings panel names it
 *   sources      which links must be live for this to be worth evaluating
 *   urgency      low | normal | high — orders a pass's nudges
 *   piercesQuiet true only where the owner chose it (freeze_risk): the push
 *                goes out during quiet hours instead of being held

 *   ttlMs        how long the observation stays worth saying
 *   describe     one line for the settings panel
 *   evaluate(profileId, ctx) -> null | { dedupeKey, facts, ttlMs?, urgency? }
 *                deterministic; no model call; must be cheap and must never
 *                throw for an ordinary "nothing to say"
 *   brief(facts) -> the sentence fragment the model is asked to word
 */

const { createHash } = require("crypto");
const googleCalendar = require("../connectors/googleCalendar");
const whoop = require("../connectors/whoop");
const nest = require("../connectors/nest");
const familyHealth = require("../familyHealth");
const dreamQuestions = require("../dreams/questions");

const MINUTE = 60_000;

/** Minutes until an ISO instant, negative if it has passed. */
function minutesUntil(iso, now = Date.now()) {
	return (new Date(iso).getTime() - now) / MINUTE;
}

/** "2:00 pm", in the event's own zone rather than the server's. */
function clockTime(iso, timeZone) {
	try {
		return new Intl.DateTimeFormat("en-GB", {
			hour: "numeric",
			minute: "2-digit",
			hour12: true,
			...(timeZone ? { timeZone } : {}),
		}).format(new Date(iso));
	} catch {
		return iso;
	}
}

/** Events that have a real start instant, soonest first. */
function timedEvents(events) {
	return (events || [])
		.filter((e) => e && e.start && !e.allDay)
		.sort((a, b) => new Date(a.start) - new Date(b.start));
}

const TRIGGERS = [
	{
		id: "calendar_next_up",
		label: "Something starting soon",
		sources: ["google_calendar"],
		urgency: "high",
		ttlMs: 20 * MINUTE,
		describe: "Tell me when something on my calendar is about to start.",

		async evaluate(profileId) {
			const { events, calendars } = await googleCalendar.collectEvents(profileId, { days: 1 });
			const zone = googleCalendar.displayTimeZone(calendars);
			const now = Date.now();
			// The window is narrow on purpose. Earlier than 25 minutes and it is
			// not yet useful; later than 10 and it is too late to act on.
			const next = timedEvents(events).find((e) => {
				const mins = minutesUntil(e.start, now);
				// A flight on a non-primary calendar may belong to another traveller.
				// Calendar timing cannot establish whether anyone boarded or missed it.
				return mins >= 10 && mins <= 25 && !(e.shared && /\b(flight|fly|airline|airport)\b/i.test(e.title || ""));
			});
			if (!next) return null;
			// An event id, so the same meeting is announced exactly once even
			// though the evaluator sees it on several consecutive runs.
			return {
				dedupeKey: `event:${next.id || next.start}`,
				facts: {
					title: next.title || next.summary || "something",
					start: next.start,
					at: clockTime(next.start, zone),
					minutes: Math.round(minutesUntil(next.start, now)),
					location: next.location || null,
					calendar: next.calendar || null,
					shared: !!next.shared,
					time_zone: zone,
				},
			};
		},

		brief(f) {
			return (
				`"${f.title}" ${f.shared ? `on the ${f.calendar || "shared"} calendar ` : ""}starts at ${f.at}, about ${f.minutes} minutes from now` +
				(f.location ? `, at ${f.location}` : "") +
				"."
			);
		},
	},

	{
		id: "calendar_conflict",
		label: "Two things booked at once",
		sources: ["google_calendar"],
		urgency: "normal",
		ttlMs: 3 * 60 * MINUTE,
		describe: "Point out when two things on my calendar overlap.",

		async evaluate(profileId) {
			const { events, calendars } = await googleCalendar.collectEvents(profileId, { days: 2 });
			const zone = googleCalendar.displayTimeZone(calendars);
			const now = Date.now();
			const upcoming = timedEvents(events).filter((e) => minutesUntil(e.start, now) > 0);

			for (let i = 0; i < upcoming.length - 1; i += 1) {
				const a = upcoming[i];
				const b = upcoming[i + 1];
				if (!a.end) continue;
				if (new Date(b.start) >= new Date(a.end)) continue;
				// Only worth raising while there is still time to fix it.
				if (minutesUntil(a.start, now) < 60) continue;
				// Sorted pair, so the same clash keys identically however the
				// provider happens to order the two events on a later run.
				const key = [a.id || a.start, b.id || b.start].sort().join("|");
				return {
					dedupeKey: `clash:${key}`,
					facts: {
						first: { title: a.title || a.summary || "something", at: clockTime(a.start, zone) },
						second: { title: b.title || b.summary || "something", at: clockTime(b.start, zone) },
						overlap_minutes: Math.max(
							1,
							Math.round((new Date(a.end) - new Date(b.start)) / MINUTE)
						),
						time_zone: zone,
					},
				};
			}
			return null;
		},

		brief(f) {
			return (
				`"${f.first.title}" at ${f.first.at} overlaps "${f.second.title}" at ` +
				`${f.second.at} by about ${f.overlap_minutes} minutes.`
			);
		},
	},

	{
		id: "recovery_vs_day",
		label: "A hard day on a bad night's sleep",
		// The one that needs both links. It is also the only one here that says
		// something neither source knows on its own, which is the whole reason
		// initiative is worth building rather than just notifications.
		sources: ["whoop", "google_calendar"],
		urgency: "normal",
		ttlMs: 4 * 60 * MINUTE,
		describe: "Mention it when my day looks heavy and my recovery is low.",

		async evaluate(profileId) {
			const [recovery, calendar] = await Promise.all([
				whoop.listRecovery(profileId, { days: 2 }),
				googleCalendar.collectEvents(profileId, { days: 1 }),
			]);
			const latest = (recovery || []).find((r) => r.recovery_score !== null);
			if (!latest || latest.recovery_score > 40) return null;

			const now = Date.now();
			const ahead = timedEvents(calendar.events).filter((e) => minutesUntil(e.start, now) > 0);
			if (ahead.length < 4) return null;

			return {
				// Per local date: this is a "today looks like this" observation,
				// and it is worth making at most once a day.
				dedupeKey: `day:${latest.date}`,
				facts: {
					recovery: latest.recovery_score,
					date: latest.date,
					meetings_left: ahead.length,
					first: ahead[0].title || ahead[0].summary || null,
				},
			};
		},

		brief(f) {
			return (
				`Their Whoop recovery is ${f.recovery}% today and they still have ` +
				`${f.meetings_left} things booked.`
			);
		},
	},

	{
		id: "family_illness_precaution",
		label: "Someone in the family is under the weather",
		// Athena's own family data, not an external connector — always
		// worth evaluating.
		sources: [],
		urgency: "normal",
		ttlMs: 12 * 60 * MINUTE,
		describe: "Remind the household about basic precautions while someone is sick.",

		async evaluate(profileId, { now = new Date() } = {}) {
			const active = await familyHealth.activeFor(profileId).catch(() => []);
			if (!active.length) return null;
			// The longest-running case leads — the one most worth a reminder about.
			const worst = [...active].sort((a, b) => b.daysActive - a.daysActive)[0];
			const day = new Date(now).toISOString().slice(0, 10);
			return {
				// One reminder per person per day while their status stays active —
				// an illness that runs a week is still worth repeating on day five.
				dedupeKey: `illness:${worst.uuid}:${day}`,
				facts: {
					personName: worst.personName,
					symptom: worst.symptom,
					severity: worst.severity,
					daysActive: worst.daysActive,
					householdCount: active.length,
				},
			};
		},

		brief(f) {
			return (
				`${f.personName} has had ${f.symptom} for ${f.daysActive} day${f.daysActive === 1 ? "" : "s"} — ` +
				`worth reminding the household about handwashing, not sharing cups or towels, and wiping down shared surfaces to keep it from spreading.`
			);
		},
	},

	{
		id: "family_health_check_in",
		label: "An update is due on someone who's unwell",
		// Added on the owner's instruction (2026-10-11): a health watch can ask
		// for updates every few hours — a fever logged hourly, pain medicine
		// every 8 hours. Athena's own family data; opt-in, mutes and quiet hours
		// apply exactly as for every trigger.
		sources: [],
		urgency: "normal",
		ttlMs: 60 * MINUTE,
		describe: "Ask for an update on someone who's unwell when one is due.",

		async evaluate(profileId) {
			const active = await familyHealth.activeFor(profileId).catch(() => []);
			const due = active.filter((a) => a.updateDue).sort((a, b) => Date.parse(a.nextUpdateAt) - Date.parse(b.nextUpdateAt));
			if (!due.length) return null;
			return {
				// Every due case and the update it is waiting after. One nudge names
				// all of them; a case falling due later changes the key, so nobody is
				// left out behind whoever fell due first, and logging an update moves
				// that case on to its next check-in.
				dedupeKey: `checkin:${createHash("sha1").update(due.map((a) => `${a.uuid}@${a.lastUpdateAt}`).sort().join("|")).digest("hex")}`,
				// Worth saying until the next check-in would come round anyway, so a
				// nudge held overnight by quiet hours still reaches them in the morning.
				ttlMs: Math.min(...due.map((a) => a.checkInHours)) * 60 * MINUTE,
				facts: {
					people: due.map((a) => ({ personName: a.personName, symptom: a.symptom, everyHours: a.checkInHours })),
				},
			};
		},

		brief(f) {
			const who = f.people.map((p) => `${p.personName} (${p.symptom}, every ${p.everyHours}h)`).join(" and ");
			return `It's time for the update they asked to log on ${who}. Ask how it's going — you can log what they tell you.`;
		},
	},

	{
		id: "nest_offline",
		label: "A thermostat went offline",
		// Added on the owner's instruction (2026-10-16): "alert me next time
		// [the downstairs Nest] is offline". The source is the person's own
		// Nest link, so it is only evaluated once they have connected it;
		// opt-in, mutes and quiet hours apply exactly as for every trigger.
		// The Pub/Sub push (controllers/nestWebhook.js) runs this person's pass
		// the moment a device reports offline; the scheduled pass is the
		// backstop, and re-reads Google at most hourly.
		sources: ["nest"],
		urgency: "high",
		ttlMs: 6 * 60 * MINUTE,
		describe: "Tell me when a Nest thermostat loses its connection.",

		async evaluate(profileId, { now = new Date() } = {}) {
			await nest.refreshIfStale(profileId, { now }).catch((err) =>
				console.warn("[initiative] nest refresh failed:", err.message));
			const offline = await nest.offlineDevices(profileId);
			if (!offline.length) return null;
			return {
				// Each device and the instant it went offline: one nudge per
				// outage, however long it lasts, and a second device dropping
				// later is a new occurrence that names both.
				dedupeKey: `nest:${createHash("sha1").update(offline.map((d) => `${d.name}@${d.offlineSince}`).sort().join("|")).digest("hex")}`,
				facts: {
					devices: offline.map((d) => ({
						title: nest.deviceTitle(d),
						room: d.room,
						since: d.offlineSince,
						at: nest.clockTime(d.offlineSince),
						notReporting: d.notReporting === true,
						minutes: Math.max(0, Math.round((now.getTime() - Date.parse(d.offlineSince)) / MINUTE)),
					})),
				},
			};
		},

		brief(f) {
			const list = f.devices.map((d) => d.notReporting
				? `the ${d.title} (not reporting since ${d.at} — Google still lists it as online, but it is sending no readings)`
				: `the ${d.title} (offline since ${d.at})`).join(" and ");
			return (
				`${list.charAt(0).toUpperCase()}${list.slice(1)}, so it can't be read or controlled right now. ` +
				`Don't guess why — power, Wi-Fi or the thermostat itself are all possible.`
			);
		},
	},

	{
		id: "hvac_struggling",
		label: "The heating or cooling isn't keeping up",
		// Added on the owner's instruction (2026-10-20). Measured from the
		// person's own thermostat history (services/hvacHealth.js): a long run
		// that has barely moved the room, or runs far slower than that
		// thermostat's own usual. What was seen, never a diagnosis. The source
		// is their Nest link; opt-in, mutes, dedupe and quiet hours apply as
		// for every trigger.
		sources: ["nest"],
		urgency: "normal",
		ttlMs: 6 * 60 * MINUTE,
		describe: "Tell me when the heat or air conditioning runs without moving the temperature like it should.",

		async evaluate(profileId, { now = new Date() } = {}) {
			const hvacHealth = require("../hvacHealth");
			const issues = await hvacHealth.assess(profileId, { now });
			if (!issues.length) return null;
			return {
				// Per device, per kind, per day the problem started: a heating run
				// that stays stuck all evening is one occurrence; the same thing
				// starting again tomorrow is another.
				dedupeKey: `hvac:${createHash("sha1").update(issues.map((i) => `${i.device}:${i.kind}:${String(i.since).slice(0, 10)}`).sort().join("|")).digest("hex")}`,
				facts: { issues: issues.map((i) => ({ title: i.title, room: i.room, kind: i.kind, hvac: i.hvac, text: hvacHealth.describe(i) })) },
			};
		},

		brief(f) {
			return (
				`${f.issues.map((i) => i.text).join(" ")} Say what was measured and don't guess a cause — ` +
				`a filter, a door left open or the system itself are all possible. Offer to help report it on the Property page.`
			);
		},
	},

	{
		id: "freeze_risk",
		label: "Pipes could freeze tonight",
		// Added on the owner's instruction (2026-10-20). A freeze or hard freeze
		// forecast at home tonight AND a reason the house may not be heated: a
		// thermostat offline or not reporting, set to off, or already reading
		// 50°F or below. The owner chose to let this one push through quiet
		// hours (piercesQuiet, read in index.js) — frozen pipes happen
		// overnight, and a held push is delivered after the damage. Opt-in,
		// mutes, dedupe and TTL apply exactly as for every trigger.
		sources: ["nest"],
		urgency: "high",
		piercesQuiet: true,
		ttlMs: 6 * 60 * MINUTE,
		describe: "Wake me if it's freezing tonight and the house may not be heating.",

		async evaluate(profileId, { now = new Date() } = {}) {
			await nest.refreshIfStale(profileId, { now }).catch((err) =>
				console.warn("[initiative] nest refresh failed:", err.message));
			const devices = await nest.storedDevices(profileId);
			if (!devices.length) return null;
			const reasons = [];
			for (const d of devices) {
				const r = d.readings || {};
				const title = nest.deviceTitle(d);
				if (d.connectivity === "OFFLINE") reasons.push({ key: `${d.name}:offline`, title, why: d.notReporting ? "not reporting" : "offline" });
				else if (r.mode === "OFF") reasons.push({ key: `${d.name}:off`, title, why: "set to off" });
				else if (Number.isFinite(r.temperatureC) && (r.temperatureC * 9) / 5 + 32 <= 50) {
					reasons.push({ key: `${d.name}:cold`, title, why: `reading ${Math.round((r.temperatureC * 9) / 5 + 32)}°F inside` });
				}
			}
			if (!reasons.length) return null;

			const weatherAlerts = require("../weatherAlerts");
			const weather = require("../weather");
			const place = await weatherAlerts.homePlace(profileId).catch(() => null);
			if (!place) return null;
			const rows = await weather.hourlyRows(place.latitude, place.longitude).catch(() => null);
			if (!rows?.hours?.length) return null;
			const horizon = now.getTime() + 18 * 60 * MINUTE;
			const upcoming = rows.hours.filter((h) => {
				const t = Date.parse(h.start);
				return Number.isFinite(t) && t >= now.getTime() - 60 * MINUTE && t <= horizon;
			});
			const night = weather.nightsOf(upcoming)
				.filter((n) => n.risk === "freeze" || n.risk === "hard_freeze")
				.sort((a, b) => a.lowF - b.lowF)[0];
			if (!night) return null;
			// The server runs in UTC; say the time in the person's own zone.
			const [prefRows] = await require("../../helpers/db")
				.query("SELECT timezone FROM athena_initiative_pref WHERE profile_id = ?", [profileId])
				.catch(() => [[]]);
			const timeZone = prefRows[0]?.timezone || undefined;
			return {
				// The night and the reasons: one push for "the den is offline on a
				// hard-freeze night", and a new one if a second reason appears.
				dedupeKey: `freeze:${night.night}:${createHash("sha1").update(reasons.map((r) => r.key).sort().join("|")).digest("hex")}`,
				facts: {
					place: place.name,
					lowF: night.lowF,
					risk: night.risk,
					coldestAt: clockTime(night.at, timeZone),
					reasons: reasons.map(({ title, why }) => ({ title, why })),
				},
			};
		},

		brief(f) {
			const why = f.reasons.map((r) => `the ${r.title} is ${r.why}`).join(" and ");
			return (
				`It's forecast to drop to ${f.lowF}°F at ${f.place} tonight (${f.risk === "hard_freeze" ? "a hard freeze" : "a freeze"}, coldest around ${f.coldestAt}), ` +
				`and ${why}. If the house isn't heating, pipes can freeze. Say it plainly and urgently, ` +
				`suggest checking the heat now, and don't guess why the thermostat is in that state.`
			);
		},
	},

	{
		id: "dream_question",
		label: "A question after dreaming",
		// Added on the owner's instruction (2026-09-26): questions she couldn't
		// settle while organizing someone's memories overnight. The source is
		// that person's own memories — nothing they haven't already told her.
		// Opt-in, mutes and quiet hours apply exactly as for every trigger.
		sources: [],
		urgency: "low",
		ttlMs: 12 * 60 * MINUTE,
		describe: "Ask me when something you're organizing about my life needs clarifying.",

		async evaluate(profileId) {
			const waiting = await dreamQuestions.pendingFor(profileId, 10).catch(() => []);
			if (!waiting.length) return null;
			// Per night: one nudge carries everything that night raised, and every
			// question stays pending — and in the chat prompt — until answered,
			// so nothing a later night asks is lost behind an earlier nudge.
			const night = Math.max(...waiting.map((w) => Number(w.dream_id) || 0));
			const first = waiting.find((w) => (Number(w.dream_id) || 0) === night) || waiting[0];
			return {
				dedupeKey: `dream:${night}`,
				facts: { count: waiting.length, first: first.question },
			};
		},

		brief(f) {
			return (
				`While organizing what they've told her overnight, Athena came up with ` +
				`${f.count === 1 ? "a question" : `${f.count} questions`} only they can answer. ` +
				`The first: "${f.first}". Ask permission first, like "Can I ask you something?"`
			);
		},
	},

	{
		id: "sighting_alert",
		label: "Someone or something seen on the cameras",
		// Added on the owner's instruction (2026-10-18): "if the dog escapes out
		// the back fence can Athena send me a push notification". The source is
		// the household cameras through the sightings log (services/sightings),
		// and it only ever fires for a rule the person wrote themselves — no
		// rules, no evaluation. The model saw the frame; whether to speak is the
		// rule's match, decided in code. Opt-in, mutes, the per-occurrence
		// dedupe and the quiet-hours hold (the owner chose hold) apply exactly
		// as for every trigger. The bridge webhook runs this person's pass the
		// moment a matching sighting lands; the scheduled pass is the backstop.
		sources: [],
		urgency: "high",
		ttlMs: 2 * 60 * MINUTE,
		describe: "Tell me when someone or something I set an alert for is seen on the cameras.",

		async evaluate(profileId, { now = new Date() } = {}) {
			const sightings = require("../sightings");
			const active = await sightings.activeAlerts(profileId, { now });
			if (!active.length) return null;
			// The server runs in UTC; say the time in the person's own zone.
			const [prefRows] = await require("../../helpers/db")
				.query("SELECT timezone FROM athena_initiative_pref WHERE profile_id = ?", [profileId])
				.catch(() => [[]]);
			const timeZone = prefRows[0]?.timezone || undefined;
			return {
				// One alert per run of sightings per rule: a dog seen three times in
				// ten minutes is one occurrence; out again an hour later is another.
				dedupeKey: `sighting:${createHash("sha1").update(active.map((a) => `${a.rule}@${a.occurrence}`).sort().join("|")).digest("hex")}`,
				facts: {
					seen: active.map((a) => ({
						label: a.latest.label,
						camera: a.latest.device_name,
						zone: a.latest.zone,
						where: a.latest.where_text,
						at: clockTime(new Date(a.latest.seen_at).toISOString(), timeZone),
						unsure: a.latest.confidence != null && Number(a.latest.confidence) < 0.6,
					})),
				},
			};
		},

		brief(f) {
			const list = f.seen.map((s) =>
				`${s.label} ${s.unsure ? "may have been " : "was "}seen${s.camera ? ` on the ${s.camera} camera` : ""}` +
				`${s.where ? `, ${s.where}` : ""}${s.zone ? ` (${s.zone})` : ""} at ${s.at}`).join("; ");
			return `${list}. They asked to be told. Say it plainly and briefly; if it was marked "may have been", say the camera wasn't sure.`;
		},
	},
];

/** The person's own "package" alert rules — the only thing that turns the porch triggers on. */
async function packageRules(profileId) {
	const [rules] = await require("../../helpers/db").query(
		"SELECT * FROM athena_sighting_rule WHERE profile_id = ? AND enabled = 1 AND label = 'package'",
		[profileId]
	);
	return rules;
}

async function prefTimeZone(profileId) {
	const [prefRows] = await require("../../helpers/db")
		.query("SELECT timezone FROM athena_initiative_pref WHERE profile_id = ?", [profileId])
		.catch(() => [[]]);
	return prefRows[0]?.timezone || undefined;
}

TRIGGERS.push(
	{
		id: "package_waiting",
		label: "A package is still at the door",
		// Added on the owner's instruction (2026-10-20). A package the cameras saw
		// left at the door (sightings kind "package") is looked at again with a
		// fresh frame (services/packageWatch.js); this speaks once a re-check
		// finds it still there. Only for someone who set a "package" alert under
		// Property → Security — no rule, no evaluation — and only for the camera
		// and zone that rule names. Opt-in, mutes, dedupe and the quiet-hours
		// hold apply exactly as for every trigger.
		sources: [],
		urgency: "normal",
		ttlMs: 4 * 60 * MINUTE,
		describe: "Tell me when a package left at the door is still sitting there.",

		async evaluate(profileId, { now = new Date() } = {}) {
			const rules = await packageRules(profileId);
			if (!rules.length) return null;
			const sightings = require("../sightings");
			const packageWatch = require("../packageWatch");
			const deliveries = require("../deliveries");
			const waiting = (await packageWatch.stillThere({ now })).filter((w) =>
				rules.some((r) => sightings.matches(r, { label: "package", device_serial: w.device_serial, zone: w.zone })));
			if (!waiting.length) return null;
			const timeZone = await prefTimeZone(profileId);
			const packages = [];
			for (const w of waiting) {
				const order = await deliveries.forPackage(profileId, w.first_seen_at).catch(() => null);
				packages.push({
					camera: w.device_name,
					where: w.where_text,
					zone: w.zone,
					at: clockTime(new Date(w.first_seen_at).toISOString(), timeZone),
					order: order ? order.merchant || order.carrier || null : null,
					items: order?.items_summary || null,
				});
			}
			return {
				// One alert per package: each watch is its own occurrence.
				dedupeKey: `package:${createHash("sha1").update(waiting.map((w) => w.uuid).sort().join("|")).digest("hex")}`,
				facts: { packages },
			};
		},

		brief(f) {
			const list = f.packages.map((p) =>
				`${p.order ? `the ${p.order} delivery${p.items ? ` (${p.items})` : ""}` : "a package"} left at ${p.at}` +
				`${p.camera ? ` on the ${p.camera} camera` : ""}${p.where ? `, ${p.where}` : ""}`).join("; ");
			return `${list.charAt(0).toUpperCase()}${list.slice(1)} — a fresh look from the camera shows it's still there. Say it briefly; don't guess when someone will get it.`;
		},
	},

	{
		id: "delivery_not_seen",
		label: "A delivery email with nothing on camera",
		// Added on the owner's instruction (2026-10-20). Their own Gmail says an
		// order was delivered 2-8 hours ago and no camera saw a package around
		// then (services/deliveries.js). Only for someone with a "package" alert
		// set, so it never speaks for a household without porch cameras. Says
		// what was and wasn't seen — not that anything was stolen.
		sources: ["gmail"],
		urgency: "normal",
		ttlMs: 6 * 60 * MINUTE,
		describe: "Tell me when an email says something was delivered but the cameras didn't see a package.",

		async evaluate(profileId, { now = new Date() } = {}) {
			if (!(await packageRules(profileId)).length) return null;
			const deliveries = require("../deliveries");
			const packageWatch = require("../packageWatch");
			const missing = await deliveries.unseen(profileId, { now, sightingsNear: (at) => packageWatch.sightingsNear(at) });
			if (!missing.length) return null;
			const timeZone = await prefTimeZone(profileId);
			return {
				dedupeKey: `undelivered:${createHash("sha1").update(missing.map((d) => d.uuid).sort().join("|")).digest("hex")}`,
				facts: {
					orders: missing.map((d) => ({
						from: d.merchant || d.carrier || "An order",
						items: d.items_summary || null,
						at: clockTime(new Date(d.delivered_at).toISOString(), timeZone),
					})),
				},
			};
		},

		brief(f) {
			const list = f.orders.map((o) => `${o.from}${o.items ? ` (${o.items})` : ""}, marked delivered at ${o.at}`).join("; ");
			return (
				`Their email says ${list}, but the door cameras didn't see a package around then. ` +
				`Say exactly that. It may have been left somewhere the cameras don't cover, or at the wrong house — don't suggest it was stolen.`
			);
		},
	},
);

TRIGGERS.push({
	id: "vehicle_recall",
	label: "A safety recall for one of your vehicles",
	// Added on the owner's instruction (2026-10-20). NHTSA's public recalls
	// for a vehicle on Property → Vehicles (services/vehicleRecalls.js), new in
	// the last two weeks and not yet marked done or not applicable. The first
	// lookup for a car finds every recall for its model year; they arrive as
	// one occurrence, not one push each. A "don't drive" or "park outside"
	// recall is high urgency. Opt-in, mutes, dedupe and quiet hours as always.
	sources: [],
	urgency: "normal",
	ttlMs: 6 * 60 * MINUTE,
	describe: "Tell me when NHTSA lists a safety recall for one of my vehicles.",

	async evaluate(profileId) {
		const rows = await require("../vehicleRecalls").recentOpen(profileId).catch(() => []);
		if (!rows.length) return null;
		const urgent = rows.some((r) => r.park_it || r.park_outside);
		return {
			dedupeKey: `recall:${createHash("sha1").update(rows.map((r) => `${r.vehicle_uuid}:${r.campaign}`).sort().join("|")).digest("hex")}`,
			urgency: urgent ? "high" : "normal",
			facts: {
				recalls: rows.slice(0, 6).map((r) => ({
					vehicle: r.vehicle_name,
					campaign: r.campaign,
					component: r.component,
					summary: String(r.summary || "").slice(0, 300),
					parkIt: !!r.park_it,
					parkOutside: !!r.park_outside,
				})),
				more: Math.max(0, rows.length - 6),
			},
		};
	},

	brief(f) {
		const list = f.recalls.map((r) =>
			`${r.vehicle}: ${r.component || "recall"} (${r.campaign})${r.parkIt ? " — NHTSA says not to drive it until it's fixed" : r.parkOutside ? " — NHTSA says to park it outside, away from buildings" : ""}`).join("; ");
		return (
			`NHTSA lists ${f.recalls.length + f.more === 1 ? "a safety recall" : `${f.recalls.length + f.more} safety recalls`} for their vehicle model year: ${list}${f.more ? ` and ${f.more} more` : ""}. ` +
			`These are recalls for the model year, not proof this car hasn't been repaired — suggest checking with a dealer and marking each done on Property → Vehicles.`
		);
	},
});

const BY_ID = new Map(TRIGGERS.map((t) => [t.id, t]));

/** The descriptor, or null. A null must be treated as "do not fire". */
function get(id) {
	return (typeof id === "string" && BY_ID.get(id)) || null;
}

module.exports = { TRIGGERS, get };
