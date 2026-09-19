/**
 * Initiative: Athena speaking first.
 *
 * Every word she said before this was a reply. This is the part that starts
 * a conversation.
 *
 * ## The split
 *
 *   RULES decide WHETHER to speak      (triggers.js — deterministic)
 *   the MODEL decides only HOW to word it (one short call, here)
 *
 * See triggers.js for why. The consequence worth stating here is that
 * `facts` on the row is the real reason she spoke, independent of anything
 * the model said about itself.
 *
 * ## There is no interruption budget
 *
 * There used to be one: a daily cap, a ninety-minute gap between anything she
 * said, a per-trigger cooldown, one nudge per pass, and a learned score that
 * could suppress a trigger outright. It was built on the view that a system
 * which interrupts people is only tolerable if interrupting is expensive.
 *
 * The owner removed it on 2026-09-19, for a reason the old design had no
 * answer to: every one of those limits worked by DISCARDING a true
 * observation. Not deferring it — dropping it. The fourth thing worth saying
 * on a busy day was never said, and nothing anywhere recorded that it had
 * been thrown away, so the failure was invisible from both sides. "I don't
 * want to miss anything because of a budget" is the whole specification.
 *
 * What remains is everything that costs nothing to keep, because none of it
 * can lose an observation:
 *
 *   opt-in       no athena_initiative_pref row means silence. Still the
 *                default for every person who has never been asked.
 *   mutes        an explicit instruction to stop raising one kind of thing.
 *   dedupe       one nudge per occurrence, ever, enforced by a unique key
 *                rather than by this code remembering to check. This prevents
 *                REPETITION, which is not the same as missing something.
 *   TTL          each trigger says how long its own observation stays worth
 *                saying. "Your 2pm is in fifteen minutes" is not worth
 *                delivering at four o'clock.
 *   quiet hours  now a DEFERRAL, not a refusal — see below.
 *
 * The dedupe key being a database constraint is deliberate: it makes the
 * evaluator safe to run from the scheduled job and in-process at the same
 * time, because a duplicate is a failed INSERT rather than a second nudge.
 *
 * ## Quiet hours hold, they do not drop
 *
 * The old behaviour skipped the pass entirely, so anything true at 3am was
 * lost. Now the nudge is still written and still waiting in the morning; only
 * the PUSH is held, so nobody is woken. `releaseHeld` pushes them once the
 * quiet window ends. A nudge whose own TTL expires overnight still expires —
 * that is the trigger's statement about its own shelf life, not a budget.
 *
 * Setting quiet_from === quiet_to turns the window off entirely.
 *
 * ## The feedback loop still runs, but it no longer silences
 *
 * Every nudge still records how it landed and the nightly review still rolls
 * those up per trigger (selfReview/metrics.js), because knowing which kinds
 * of thing land badly is worth having. What that score may no longer do is
 * suppress a trigger by itself: a suppression is a miss, and misses are the
 * thing that was removed. It orders and it informs; it does not gag. Muting
 * is still available and is a person's own decision.
 */

const { randomUUID } = require("node:crypto");
const pool = require("../../helpers/db");
const access = require("../../security/access");
const consent = require("../consent");
const credentials = require("../credentials");
const llm = require("../llm");
const { DEFAULT_TZ, startOfDayIn } = require("../clock");
const triggers = require("./triggers");
const appraise = require("./appraise");
const push = require("../push");

const MINUTE = 60_000;

/** Longest a nudge may sit unseen, whatever its trigger asked for. */
const MAX_TTL_MS = 6 * 60 * MINUTE;

// `facts` is deliberately absent: it is the audit record of what the trigger
// observed, not something a client needs, and some of it (a calendar title, a
// recovery score) is more than the nudge itself chose to reveal.
const PUBLIC_COLUMNS = `uuid, trigger_id, urgency, text, status,
	created_at, expires_at, delivered_at`;

function failure(message, status, code) {
	return Object.assign(new Error(message), { status, code });
}

function publicNudge(row) {
	return {
		uuid: row.uuid,
		trigger_id: row.trigger_id,
		label: triggers.get(row.trigger_id)?.label || row.trigger_id,
		urgency: row.urgency,
		text: row.text,
		status: row.status,
		created_at: row.created_at,
		expires_at: row.expires_at,
	};
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

const DEFAULT_PREF = {
	enabled: false,
	push_enabled: false,
	timezone: null,
	quiet_from: 22,
	quiet_to: 7,
	daily_cap: 3,
};

/** This person's settings. No row means off, which is the default for everyone. */
async function getPref(profileId) {
	const [rows] = await pool.query(
		`SELECT enabled, push_enabled, timezone, quiet_from, quiet_to, daily_cap
		 FROM athena_initiative_pref WHERE profile_id = ? LIMIT 1`,
		[profileId]
	);
	if (!rows[0]) return { ...DEFAULT_PREF };
	return {
		enabled: rows[0].enabled === 1,
		push_enabled: rows[0].push_enabled === 1,
		timezone: rows[0].timezone || null,
		quiet_from: Number(rows[0].quiet_from),
		quiet_to: Number(rows[0].quiet_to),
		daily_cap: Number(rows[0].daily_cap),
	};
}

const hour = (value, fallback) => {
	const n = Number(value);
	return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
};

/**
 * Save settings. Only ever for the caller's own profile.
 *
 * Turning initiative ON requires the action consent — the same switch that
 * lets her propose changes. Speaking unprompted and acting unprompted are
 * both "Athena does something you did not ask for in this moment", and
 * splitting them into two switches would mean a person could end up with one
 * without having considered the other.
 */
async function setPref(profileId, patch = {}) {
	const current = await getPref(profileId);
	const enabled = typeof patch.enabled === "boolean" ? patch.enabled : current.enabled;
	if (enabled && !(await consent.hasConsentForProfile(profileId, "action_authority"))) {
		throw failure(
			"That needs to be turned on in your consent settings first",
			403,
			"consent_required"
		);
	}
	const next = {
		enabled,
		// Push is its own opt-in and cannot outlive initiative: agreeing she
		// may start a conversation in an app you have open is not agreeing she
		// may light up your phone, and turning initiative off must not leave a
		// switch behind that still buzzes.
		push_enabled:
			enabled &&
			(typeof patch.push_enabled === "boolean" ? patch.push_enabled : current.push_enabled),
		// The app sends the device's own zone. Without it quiet hours are
		// guesswork, so an unset zone falls back to the server default rather
		// than to "any hour is fine".
		timezone:
			typeof patch.timezone === "string" && patch.timezone.trim()
				? patch.timezone.trim().slice(0, 64)
				: current.timezone,
		quiet_from: hour(patch.quiet_from, current.quiet_from),
		quiet_to: hour(patch.quiet_to, current.quiet_to),
		daily_cap: Math.max(0, Math.min(Number(patch.daily_cap) || current.daily_cap, 10)),
	};
	await pool.query(
		`INSERT INTO athena_initiative_pref
			(profile_id, enabled, push_enabled, timezone, quiet_from, quiet_to, daily_cap)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE enabled = VALUES(enabled),
		   push_enabled = VALUES(push_enabled), timezone = VALUES(timezone),
		   quiet_from = VALUES(quiet_from), quiet_to = VALUES(quiet_to),
		   daily_cap = VALUES(daily_cap)`,
		[
			profileId,
			next.enabled ? 1 : 0,
			next.push_enabled ? 1 : 0,
			next.timezone,
			next.quiet_from,
			next.quiet_to,
			next.daily_cap,
		]
	);
	return next;
}

async function listMutes(profileId) {
	const [rows] = await pool.query(
		"SELECT trigger_id FROM athena_trigger_mute WHERE profile_id = ?",
		[profileId]
	);
	return rows.map((r) => r.trigger_id);
}

async function mute(profileId, triggerId) {
	if (!triggers.get(triggerId)) throw failure("No such trigger", 404, "unknown_trigger");
	await pool.query(
		`INSERT INTO athena_trigger_mute (profile_id, trigger_id) VALUES (?, ?)
		 ON DUPLICATE KEY UPDATE created_at = created_at`,
		[profileId, triggerId]
	);
	return listMutes(profileId);
}

async function unmute(profileId, triggerId) {
	await pool.query(
		"DELETE FROM athena_trigger_mute WHERE profile_id = ? AND trigger_id = ?",
		[profileId, triggerId]
	);
	return listMutes(profileId);
}

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

/** The hour of the day, 0-23, where this person actually is. */
function localHour(timeZone, now = new Date()) {
	try {
		return Number(
			new Intl.DateTimeFormat("en-GB", {
				hour: "numeric",
				hour12: false,
				timeZone: timeZone || DEFAULT_TZ,
			}).format(now)
		);
	} catch {
		return Number(
			new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "UTC" }).format(now)
		);
	}
}

/**
 * Is this local hour inside the quiet window?
 *
 * The window normally wraps midnight (22 -> 7), so it is NOT a simple range
 * test; getting that backwards would make her silent all day and chatty all
 * night, which is the exact inversion of what was asked for.
 */
function inQuietHours(pref, now = new Date()) {
	const h = localHour(pref.timezone, now);
	const { quiet_from: from, quiet_to: to } = pref;
	if (from === to) return false; // no quiet window at all
	return from > to ? h >= from || h < to : h >= from && h < to;
}

/**
 * How much she has said today, and when she last did.
 *
 * Nothing gates on either number any more — they are reporting, for the
 * diagnostics panel and the nightly review. Kept counting the LOCAL day
 * rather than the last 24 hours, because that is what a person means by
 * "today".
 *
 * The day boundary is computed in JS and passed in as a UTC instant rather
 * than with MySQL's CONVERT_TZ, which needs named-timezone tables loaded into
 * the server and returns NULL when they are not — silently matching nothing.
 * That used to be able to disable the daily cap; now it would merely misreport
 * a count, but a number that is wrong in a way nobody can see is still worth
 * not having.
 */
async function recentActivity(profileId, pref, now = new Date()) {
	const dayStart = startOfDayIn(now, pref.timezone || DEFAULT_TZ);
	const [[row]] = await pool.query(
		`SELECT COUNT(*) AS today, MAX(created_at) AS last_at
		 FROM athena_nudge WHERE profile_id = ? AND created_at >= ?`,
		[profileId, dayStart]
	);
	return { today: Number(row?.today || 0), lastAt: row?.last_at ? new Date(row.last_at) : null };
}

/** Written but not yet pushed, and still inside its own TTL. */
async function heldCount(profileId) {
	const [[row]] = await pool.query(
		`SELECT COUNT(*) AS held FROM athena_nudge
		 WHERE profile_id = ? AND pushed_at IS NULL AND expires_at > NOW()
		   AND status IN ('pending', 'delivered')`,
		[profileId]
	);
	return Number(row?.held || 0);
}

/** When did THIS trigger last fire for this person? Reporting only. */
async function lastFired(profileId, triggerId) {
	const [[row]] = await pool.query(
		"SELECT MAX(created_at) AS last_at FROM athena_nudge WHERE profile_id = ? AND trigger_id = ?",
		[profileId, triggerId]
	);
	return row?.last_at ? new Date(row.last_at) : null;
}

/**
 * May Athena speak to this person at all? Returns a reason string when not.
 *
 * One question now, where there were five. Consent is the only thing left
 * that can refuse outright, because it is the only one that was never about
 * rationing: somebody who has not opted in has not agreed to be spoken to,
 * which is a different statement from "you have had enough for today".
 *
 * Quiet hours are deliberately NOT here. They hold the push; they do not stop
 * the pass, or the nudge would be lost rather than delayed.
 */
async function budgetCheck(profileId, pref) {
	if (!pref.enabled) return "not enabled";
	return null;
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

/**
 * Ask the model for one sentence. The decision is already made by the time we
 * get here; this only chooses words.
 *
 * Runs on the `json` task so it stays local-first — a nudge is frequent and
 * low-stakes, and paying frontier prices to phrase "your 2pm is soon" would
 * make the whole feature something you would want to turn off for cost.
 *
 * A model failure falls back to the trigger's own plain sentence rather than
 * dropping the nudge. The observation was true either way, and a slightly
 * stiff sentence beats silence.
 */
async function word(trigger, facts) {
	const fallback = trigger.brief(facts);
	const prompt =
		`You are Athena. Say ONE short sentence to the person you look after, ` +
		`starting the conversation yourself — they did not ask you anything.\n\n` +
		`What you noticed: ${fallback}\n\n` +
		`Rules: under 25 words. Speak to them directly. Do not greet them, do ` +
		`not apologise for interrupting, do not offer a list of options, do not ` +
		`ask more than one question. Say the useful thing.\n\n` +
		`Reply as JSON: {"text": "..."}`;

	try {
		const { data } = await llm.generateJson({
			task: "json",
			contents: [{ role: "user", parts: [{ text: prompt }] }],
			check: (parsed) =>
				typeof parsed?.text === "string" && parsed.text.trim().length > 0
					? true
					: "missing text",
		});
		const text = String(data.text).trim();
		return text.length > 300 ? fallback : text;
	} catch (err) {
		console.warn(`[initiative] wording failed for ${trigger.id}:`, err.message);
		return fallback;
	}
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Providers this person has live, for skipping triggers that need them. */
async function linkedProviders(profileId) {
	try {
		const rows = await credentials.list(profileId);
		return new Set((rows || []).filter((r) => r.status === "active").map((r) => r.provider));
	} catch (err) {
		console.warn("[initiative] credential list failed:", err.message);
		return new Set();
	}
}

/**
 * Evaluate every trigger for one person and write a nudge for EVERY one that
 * fired.
 *
 * It used to write exactly one — the most urgent — on the reasoning that if
 * her calendar is a mess she should say the most important thing rather than
 * deliver a briefing, and that the rest would still be true next run. The
 * second half of that was the flaw: with a ninety-minute gap and a daily cap
 * behind it, "still true next run" usually meant never. Two things starting
 * in the same twenty minutes is exactly when you least want to be told about
 * only one of them.
 *
 * Ordering still matters even though nothing is dropped, because it decides
 * what a person reads first.
 *
 * Returns { nudges: [...] }, or { skipped } with the reason none were written.
 */
async function evaluateProfile(profileId, { now = new Date() } = {}) {
	const pref = await getPref(profileId);
	const blocked = await budgetCheck(profileId, pref);
	if (blocked) return { skipped: blocked, nudges: [] };

	// The same live check every other model-consuming path makes. A background
	// run is charged to ATHENA_BACKGROUND_GOOGLE_ID; without a valid identity
	// this throws and the job records it rather than speaking anyway.
	await access.assertModelAccess();

	const [linked, muted, scores] = await Promise.all([
		linkedProviders(profileId),
		listMutes(profileId),
		appraise.scoresFor(profileId).catch(() => ({})),
	]);
	const mutedSet = new Set(muted);

	const candidates = [];
	for (const trigger of triggers.TRIGGERS) {
		// A mute is a person's own instruction and still refuses. A learned
		// suppression no longer does: it was the last mechanism that could
		// silently drop a true observation, which is the thing being removed.
		if (mutedSet.has(trigger.id)) continue;
		if (trigger.sources.some((s) => !linked.has(s))) continue;

		let hit = null;
		try {
			hit = await trigger.evaluate(profileId, { now });
		} catch (err) {
			// A provider being down is not a reason to fail the run for every
			// other trigger, and it is certainly not a reason to say something.
			console.warn(`[initiative] ${trigger.id} evaluation failed:`, err.message);
			continue;
		}
		if (hit && hit.dedupeKey) candidates.push({ trigger, hit });
	}
	if (!candidates.length) return { skipped: "nothing to say", nudges: [] };

	// Urgency first, then how well this trigger has been received by this
	// person. The score no longer decides WHETHER she speaks, only what lands
	// at the top of the list.
	const RANK = { high: 3, normal: 2, low: 1 };
	candidates.sort((a, b) => {
		const byUrgency =
			RANK[b.hit.urgency || b.trigger.urgency] - RANK[a.hit.urgency || a.trigger.urgency];
		if (byUrgency !== 0) return byUrgency;
		return (scores[b.trigger.id]?.score ?? 0.5) - (scores[a.trigger.id]?.score ?? 0.5);
	});

	// Held rather than skipped: the nudge is written and waiting in the
	// morning, and only the push is withheld so nobody is woken.
	const quiet = inQuietHours(pref, now);
	const written = [];
	let deduped = 0;

	for (const { trigger, hit } of candidates) {
		const text = await word(trigger, hit.facts);
		const ttl = Math.min(hit.ttlMs || trigger.ttlMs, MAX_TTL_MS);
		const uuid = randomUUID();

		const [result] = await pool.query(
			`INSERT IGNORE INTO athena_nudge
				(uuid, profile_id, trigger_id, dedupe_key, urgency, text, facts, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
			[
				uuid,
				profileId,
				trigger.id,
				String(hit.dedupeKey).slice(0, 190),
				hit.urgency || trigger.urgency,
				text.slice(0, 500),
				JSON.stringify(hit.facts || {}),
				Math.round(ttl / 1000),
			]
		);
		// INSERT IGNORE rather than a read-then-write: the unique key is what
		// actually guarantees one nudge per occurrence, and losing that race is
		// a correct outcome, not an error.
		if (!result.affectedRows) {
			deduped += 1;
			continue;
		}
		written.push({ uuid, trigger_id: trigger.id, text });
	}

	if (!written.length) {
		return { skipped: deduped ? "already said (deduped)" : "nothing to say", nudges: [] };
	}

	let pushed = 0;
	if (!quiet) {
		for (const nudge of written) {
			// Best-effort by design: a nudge that was written and could not be
			// pushed is still a nudge, and they will see it next time they open
			// the app — exactly as before push existed.
			const delivery = await push.deliverNudge(profileId, nudge).catch((err) => {
				console.warn("[initiative] push failed:", err.message);
				return { sent: 0 };
			});
			if (delivery.sent > 0) pushed += 1;
		}
	}

	return { nudges: written, pushed, held: quiet ? written.length : 0 };
}

/**
 * Push anything that was written during quiet hours once the window has
 * passed.
 *
 * Without this, holding the push would be indistinguishable from dropping it
 * for anyone who does not open the app of their own accord — which is the
 * population push exists for. Called at the top of every pass.
 *
 * Only nudges still inside their own TTL are released: something whose shelf
 * life ran out overnight has genuinely stopped being worth saying, and that
 * is the trigger's judgement rather than a budget's.
 */
async function releaseHeld(profileId, pref, now = new Date()) {
	if (!pref.enabled || inQuietHours(pref, now)) return { released: 0 };
	const [rows] = await pool.query(
		`SELECT uuid, trigger_id, text FROM athena_nudge
		 WHERE profile_id = ? AND pushed_at IS NULL AND expires_at > NOW()
		   AND status IN ('pending', 'delivered')
		 ORDER BY created_at ASC LIMIT 20`,
		[profileId]
	);
	let released = 0;
	for (const nudge of rows) {
		const delivery = await push
			.deliverNudge(profileId, nudge)
			.catch(() => ({ sent: 0 }));
		if (delivery.sent > 0) released += 1;
	}
	return { released };
}

/**
 * Why she is quiet — every gate between an observation and a sentence, in one
 * answer.
 *
 * This is the question initiative actually gets asked, and until now the only
 * way to answer it was to read a log from a scheduled job nobody watches. Six
 * limits can each refuse alone and three of them are invisible from outside
 * (a suppression she applied to herself, a provider that quietly went stale, a
 * cooldown with hours left), so "she hasn't said anything" has always had a
 * dozen indistinguishable causes.
 *
 * Reports, never writes. `evaluate` runs the real trigger evaluators — the
 * expensive, failure-prone part — so `would_fire` means what it says rather
 * than "nothing is obviously wrong"; it is off by default because a settings
 * panel that opens should not call three providers.
 */
async function diagnose(profileId, { now = new Date(), evaluate = false } = {}) {
	const pref = await getPref(profileId);
	const [blocked, activity, linked, muted, scores, modelAccess] = await Promise.all([
		budgetCheck(profileId, pref),
		recentActivity(profileId, pref, now),
		linkedProviders(profileId),
		listMutes(profileId),
		appraise.scoresFor(profileId).catch(() => ({})),
		// The same check the evaluator makes before it is allowed to word
		// anything. A background identity that has lost access is a total,
		// silent outage, and it looks exactly like "nothing to say".
		access
			.assertModelAccess()
			.then(() => ({ ok: true, reason: null }))
			.catch((err) => ({ ok: false, reason: err.message })),
	]);
	const mutedSet = new Set(muted);

	const triggerReports = [];
	for (const trigger of triggers.TRIGGERS) {
		const missing = trigger.sources.filter((s) => !linked.has(s));
		const since = await lastFired(profileId, trigger.id);

		// Two things can still refuse, and only two. `suppressed` is reported
		// because it is worth knowing what she has noticed, but it no longer
		// appears here — it stopped being able to silence anything.
		let blocking = null;
		if (mutedSet.has(trigger.id)) blocking = "you muted it";
		else if (missing.length) blocking = `not connected: ${missing.join(", ")}`;

		const report = {
			id: trigger.id,
			label: trigger.label,
			describe: trigger.describe,
			urgency: trigger.urgency,
			sources: trigger.sources,
			missing_sources: missing,
			muted: mutedSet.has(trigger.id),
			suppressed: scores[trigger.id]?.suppressed === true,
			score: scores[trigger.id]?.score ?? null,
			last_fired_at: since,
			cooldown_minutes_left: 0,
			blocked_by: blocking,
		};

		if (evaluate && !blocking) {
			try {
				const hit = await trigger.evaluate(profileId, { now });
				report.would_fire = Boolean(hit && hit.dedupeKey);
				// The brief, not the wording: this is the observation itself,
				// before any model saw it, which is the thing worth checking.
				if (report.would_fire) report.brief = trigger.brief(hit.facts);
			} catch (err) {
				report.would_fire = false;
				report.evaluation_error = err.message;
			}
		}
		triggerReports.push(report);
	}

	return {
		pref,
		model_access: modelAccess,
		budget: {
			blocked_by: blocked,
			// True means a push would be HELD until the window ends, not that
			// the observation is lost. The distinction is the whole point.
			in_quiet_hours: inQuietHours(pref, now),
			today: activity.today,
			// No ceiling any more. Reported so the panel can still say how
			// talkative she has actually been, which is the useful half of
			// what the cap used to provide.
			daily_cap: null,
			last_nudge_at: activity.lastAt,
			minutes_until_next_allowed: 0,
		},
		held: await heldCount(profileId),
		linked_providers: [...linked],
		triggers: triggerReports,
		evaluated: evaluate,
	};
}

/** Profiles that have opted in. The only people the evaluator looks at. */
async function enabledProfiles() {
	const [rows] = await pool.query(
		"SELECT profile_id FROM athena_initiative_pref WHERE enabled = 1"
	);
	return rows.map((r) => Number(r.profile_id));
}

/** One full pass. Safe to run concurrently with itself — see the unique key. */
async function runOnce({ now = new Date() } = {}) {
	const profiles = await enabledProfiles();
	const results = { profiles: profiles.length, sent: 0, released: 0, held: 0, skipped: {} };
	for (const profileId of profiles) {
		// First: anything written overnight that nobody has been told about
		// yet. Before the evaluation, so a morning pass delivers what is
		// already waiting even if nothing new has happened.
		try {
			const pref = await getPref(profileId);
			results.released += (await releaseHeld(profileId, pref, now)).released;
		} catch (err) {
			console.warn("[initiative] releasing held nudges failed:", err.message);
		}

		let outcome;
		try {
			outcome = await evaluateProfile(profileId, { now });
		} catch (err) {
			outcome = { skipped: `error: ${err.message}`, nudges: [] };
		}
		if (outcome.nudges?.length) {
			results.sent += outcome.nudges.length;
			results.held += outcome.held || 0;
		} else {
			results.skipped[outcome.skipped] = (results.skipped[outcome.skipped] || 0) + 1;
		}
	}
	return results;
}

// ---------------------------------------------------------------------------
// Delivery and reactions
// ---------------------------------------------------------------------------

/**
 * Nudges this person has not seen yet, marked delivered as they go out.
 *
 * Marking on read is what keeps "she said it twice" from happening across two
 * open tabs, and it is what makes `delivered_at` mean something in the
 * nightly review: a nudge that expired undelivered was never an interruption
 * at all and should not count as one.
 */
async function pendingFor(profileId) {
	const [rows] = await pool.query(
		`SELECT ${PUBLIC_COLUMNS} FROM athena_nudge
		 WHERE profile_id = ? AND status = 'pending' AND expires_at > NOW()
		 ORDER BY FIELD(urgency, 'high', 'normal', 'low'), created_at ASC LIMIT 3`,
		[profileId]
	);
	if (!rows.length) return [];
	await pool.query(
		`UPDATE athena_nudge SET status = 'delivered', delivered_at = NOW()
		 WHERE profile_id = ? AND status = 'pending' AND uuid IN (${rows.map(() => "?").join(",")})`,
		[profileId, ...rows.map((r) => r.uuid)]
	);
	return rows.map((r) => publicNudge({ ...r, status: "delivered" }));
}

/** Recent history, for the settings panel and for "what have you told me?". */
async function recentFor(profileId, limit = 20) {
	const [rows] = await pool.query(
		`SELECT ${PUBLIC_COLUMNS} FROM athena_nudge
		 WHERE profile_id = ? ORDER BY created_at DESC LIMIT ?`,
		[profileId, Math.min(Math.max(Number(limit) || 20, 1), 100)]
	);
	return rows.map(publicNudge);
}

const REACTIONS = new Set(["engaged", "dismissed"]);

/**
 * How it landed. The only measurement that tells the nightly review whether
 * a trigger is earning its interruptions.
 */
async function react(profileId, uuid, reaction) {
	if (!REACTIONS.has(reaction)) throw failure("Unknown reaction", 400, "bad_reaction");
	const [result] = await pool.query(
		`UPDATE athena_nudge SET status = ?, reacted_at = NOW()
		 WHERE uuid = ? AND profile_id = ? AND status IN ('pending', 'delivered')`,
		[reaction, uuid, profileId]
	);
	if (!result.affectedRows) throw failure("No such nudge", 409, "not_open");
	return { uuid, status: reaction };
}

/**
 * The thing she raised that a reply is most likely answering.
 *
 * Attribution is by recency inside a short window, which is a guess — but a
 * well-bounded one. She raises at most one thing every ninety minutes, so
 * within half an hour of a nudge there is only ever one candidate, and past
 * that window a reply is almost certainly about something else. Guessing
 * wrong in the other direction would be worse: crediting an unrelated "ok
 * thanks" to a trigger teaches her the wrong lesson about it.
 *
 * Only unappraised nudges are returned, so one reply moves one score once.
 */
async function openNudgeFor(profileId, { withinMinutes = 30 } = {}) {
	if (!profileId) return null;
	const [rows] = await pool.query(
		`SELECT uuid, trigger_id, text FROM athena_nudge
		 WHERE profile_id = ? AND appraised_at IS NULL
		   AND (delivered_at IS NOT NULL OR pushed_at IS NOT NULL)
		   AND status IN ('delivered', 'engaged')
		   AND created_at >= NOW() - INTERVAL ? MINUTE
		 ORDER BY created_at DESC LIMIT 1`,
		[profileId, Math.max(1, Math.min(Number(withinMinutes) || 30, 240))]
	);
	return rows[0] || null;
}

/** Retire what nobody saw in time. Run from the nightly job. */
async function expireStale() {
	const [result] = await pool.query(
		`UPDATE athena_nudge SET status = 'expired'
		 WHERE status IN ('pending', 'delivered') AND expires_at <= NOW()`
	);
	return result.affectedRows || 0;
}

/**
 * What she has already said unprompted, for her own prompt.
 *
 * Without this she raises something, the person replies "how long is it?",
 * and she has no idea what they mean — which reads as her having forgotten
 * a thing she said sixty seconds ago, and is the fastest way to make
 * initiative feel like a notification robot bolted to a chatbot.
 */
async function promptBlock(profileId) {
	if (!profileId) return null;
	const [rows] = await pool.query(
		`SELECT text, created_at FROM athena_nudge
		 WHERE profile_id = ? AND status IN ('delivered', 'engaged')
		   AND created_at >= NOW() - INTERVAL 6 HOUR
		 ORDER BY created_at DESC LIMIT 3`,
		[profileId]
	);
	if (!rows.length) return null;
	return [
		"# Things you brought up yourself",
		"",
		"You said these to them unprompted, recently. They may be replying to one",
		"of them, so treat them as part of the conversation — and do not repeat",
		"them.",
		"",
		...rows.map((r) => `- "${r.text}"`),
	].join("\n");
}

module.exports = {
	// Learning: how well each trigger has been received, and the judgement
	// that moves it. Re-exported so callers have one initiative entry point.
	scoresFor: appraise.scoresFor,
	applyOutcome: appraise.applyOutcome,
	appraiseReply: appraise.appraiseReply,
	resumeTrigger: appraise.resume,
	sweepAppraisals: appraise.sweep,
	openNudgeFor,
	getPref,
	setPref,
	listMutes,
	mute,
	unmute,
	inQuietHours,
	budgetCheck,
	diagnose,
	evaluateProfile,
	releaseHeld,
	enabledProfiles,
	runOnce,
	pendingFor,
	recentFor,
	react,
	expireStale,
	promptBlock,
};
