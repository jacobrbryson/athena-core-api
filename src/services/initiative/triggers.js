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
 *   urgency      low | normal | high — feeds the budget's gap rules

 *   ttlMs        how long the observation stays worth saying
 *   describe     one line for the settings panel
 *   evaluate(profileId, ctx) -> null | { dedupeKey, facts, ttlMs?, urgency? }
 *                deterministic; no model call; must be cheap and must never
 *                throw for an ordinary "nothing to say"
 *   brief(facts) -> the sentence fragment the model is asked to word
 */

const googleCalendar = require("../connectors/googleCalendar");
const whoop = require("../connectors/whoop");
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
				return mins >= 10 && mins <= 25;
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
					time_zone: zone,
				},
			};
		},

		brief(f) {
			return (
				`"${f.title}" starts at ${f.at}, about ${f.minutes} minutes from now` +
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
];

const BY_ID = new Map(TRIGGERS.map((t) => [t.id, t]));

/** The descriptor, or null. A null must be treated as "do not fire". */
function get(id) {
	return (typeof id === "string" && BY_ID.get(id)) || null;
}

module.exports = { TRIGGERS, get };
