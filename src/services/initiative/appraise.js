/**
 * Was that interruption wanted?
 *
 * 0027 recorded how each nudge landed and left a human to read it in the
 * nightly review. That is a report, not a correction — a trigger nobody wants
 * keeps firing until somebody notices the report and edits code. This module
 * is the correction: it judges each outcome and moves a per-person, per-trigger
 * score that decides whether she keeps raising that kind of thing.
 *
 * ## What the model is asked, and what it is not
 *
 * The model reads the person's reply and says what it signalled. That is a
 * language judgement and exactly what it is good at — "yeah good shout" and
 * "please stop sending me these" are both short, and no keyword list gets
 * them right.
 *
 * It is NOT asked whether to interrupt (that is triggers.js, deterministic),
 * and it is NOT asked to change a setting. It returns a reading; the arithmetic
 * that moves the score is here, in code, bounded and auditable.
 *
 * ## The hard rule
 *
 * Every outcome may only make her QUIETER or leave her where she is. The score
 * redistributes a FIXED interruption budget between triggers and can suppress
 * one outright; it can never raise a daily cap, shorten spacing, pierce quiet
 * hours, or undo a mute the person set. Learning that redistributes a budget is
 * a different thing from learning that enlarges it, and only the first is hers.
 *
 * ## Why a rejection is handled immediately
 *
 * "Stop sending me this" is the strongest signal short of muting, and the one
 * thing a person will never forgive being slow. It suppresses the trigger on
 * the spot rather than waiting for the nightly pass, because the second
 * unwanted nudge after you asked her to stop is the one that loses you the
 * person.
 */

const pool = require("../../helpers/db");
const llm = require("../llm");
const triggers = require("./triggers");

/**
 * How each reading moves the score, and why these numbers.
 *
 * Negative evidence is weighted harder than positive on purpose. A welcomed
 * nudge is pleasant; an unwanted one costs trust, and the asymmetry in how
 * people experience those should be the asymmetry in how she learns. Being
 * ignored is the weakest signal here — people are busy, and a single unread
 * notification is not a verdict.
 */
const OUTCOME_WEIGHTS = {
	welcomed: +1.0, //  replied, and the reply was glad of it
	tolerated: +0.1, //  replied, neutrally — it did not cost anything
	unhelpful: -0.6, //  replied, but it was noise to them
	rejected: -1.0, //  asked her not to do that
	dismissed: -0.4, //  tapped "not now"
	ignored: -0.15, //  delivered or pushed, never answered
};

/** How fast the score moves. Recent reactions dominate; old opinions decay. */
const ALPHA = 0.25;

/** Below this, with enough evidence, she stops raising it herself. */
const SUPPRESS_BELOW = 0.25;
const SUPPRESS_MIN_SAMPLES = 4;

/** A rejection suppresses immediately, whatever the running average says. */
const REJECTION_SUPPRESSES = true;

const clamp = (n) => Math.max(0, Math.min(1, n));

// ---------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------

/** Current score for one trigger. A missing row is "no opinion yet". */
async function scoreFor(profileId, triggerId) {
	const [rows] = await pool.query(
		`SELECT score, samples, last_reason, suppressed_at
		 FROM athena_trigger_score WHERE profile_id = ? AND trigger_id = ? LIMIT 1`,
		[profileId, triggerId]
	);
	if (!rows[0]) return { score: 0.5, samples: 0, suppressed: false, last_reason: null };
	return {
		score: Number(rows[0].score),
		samples: Number(rows[0].samples),
		suppressed: !!rows[0].suppressed_at,
		last_reason: rows[0].last_reason,
	};
}

/** Every score this person has, keyed by trigger. One query for the evaluator. */
async function scoresFor(profileId) {
	const [rows] = await pool.query(
		`SELECT trigger_id, score, samples, last_reason, suppressed_at
		 FROM athena_trigger_score WHERE profile_id = ?`,
		[profileId]
	);
	const out = {};
	for (const r of rows) {
		out[r.trigger_id] = {
			score: Number(r.score),
			samples: Number(r.samples),
			suppressed: !!r.suppressed_at,
			last_reason: r.last_reason,
		};
	}
	return out;
}

/**
 * Fold one outcome into the running score.
 *
 * The update is an EWMA toward the outcome's own target, so a run of good
 * reactions recovers a trigger that had a bad week, and a trigger that is
 * consistently unwanted converges down rather than oscillating.
 *
 * Suppression is applied here and never anywhere else, so there is exactly one
 * place that can make her go quiet by herself.
 */
async function applyOutcome(profileId, triggerId, outcome, { reason = null } = {}) {
	const weight = OUTCOME_WEIGHTS[outcome];
	if (weight === undefined) return null;
	if (!triggers.get(triggerId)) return null;

	const current = await scoreFor(profileId, triggerId);
	// Map the weight onto a target in [0,1]: +1 -> 1, -1 -> 0, 0 -> 0.5.
	const target = clamp(0.5 + weight / 2);
	const next = clamp(current.score + ALPHA * (target - current.score));
	const samples = current.samples + 1;

	const suppress =
		(REJECTION_SUPPRESSES && outcome === "rejected") ||
		(next < SUPPRESS_BELOW && samples >= SUPPRESS_MIN_SAMPLES);

	await pool.query(
		`INSERT INTO athena_trigger_score
			(profile_id, trigger_id, score, samples, last_reason, suppressed_at)
		 VALUES (?, ?, ?, ?, ?, ${suppress ? "NOW()" : "NULL"})
		 ON DUPLICATE KEY UPDATE score = VALUES(score), samples = VALUES(samples),
		   last_reason = VALUES(last_reason),
		   -- Never un-suppress implicitly. Coming back is a deliberate act:
		   -- either the person asks for it, or resume() decides it has earned
		   -- its way back. A merely-improving average must not reopen a door
		   -- somebody was glad to see closed.
		   suppressed_at = ${suppress ? "NOW()" : "suppressed_at"}`,
		[profileId, triggerId, next.toFixed(3), samples, reason ? String(reason).slice(0, 300) : null]
	);

	if (suppress && !current.suppressed) {
		console.log(
			`[initiative] suppressing ${triggerId} for profile ${profileId} — ${reason || outcome}`
		);
	}
	return { score: next, samples, suppressed: suppress || current.suppressed };
}

/**
 * Let a suppressed trigger back in.
 *
 * Only ever called for the person asking — from the settings panel. There is
 * deliberately no automatic path: she suppressed it because someone did not
 * want it, and deciding on their behalf that they have changed their mind is
 * the exact behaviour that makes people stop trusting a system like this.
 */
async function resume(profileId, triggerId) {
	await pool.query(
		`INSERT INTO athena_trigger_score (profile_id, trigger_id, score, samples, suppressed_at)
		 VALUES (?, ?, 0.500, 0, NULL)
		 ON DUPLICATE KEY UPDATE suppressed_at = NULL, score = GREATEST(score, 0.500),
		   samples = 0, last_reason = NULL`,
		[profileId, triggerId]
	);
	return scoreFor(profileId, triggerId);
}

// ---------------------------------------------------------------------------
// Judging a reply
// ---------------------------------------------------------------------------

const READINGS = new Set(["welcomed", "tolerated", "unhelpful", "rejected"]);

/**
 * What did the person's reply say about the interruption?
 *
 * Deliberately a small, single-purpose call on the local-first `json` task —
 * this runs once per answered nudge and must not be an expensive habit.
 *
 * Returns null when the model is unavailable or answers unusably. Null means
 * "no evidence", not "neutral evidence": recording a tolerated outcome because
 * a model was down would move a real person's score on the strength of an
 * outage.
 */
async function judgeReply(nudgeText, replyText) {
	const reply = String(replyText || "").trim().slice(0, 600);
	if (!reply) return null;

	const prompt =
		`Athena said this to someone without being asked:\n"${nudgeText}"\n\n` +
		`They replied:\n"${reply}"\n\n` +
		`What does their reply say about whether that interruption was WANTED? ` +
		`Judge only the interruption, not whether they were happy about the news ` +
		`itself — someone can be annoyed about a meeting clash and still glad she ` +
		`flagged it.\n\n` +
		`One of:\n` +
		`  welcomed  — glad she raised it\n` +
		`  tolerated — fine, no signal either way\n` +
		`  unhelpful — it was noise to them, or they had to correct it\n` +
		`  rejected  — they asked her not to send this kind of thing again\n\n` +
		`Reply as JSON: {"reading": "...", "why": "under 15 words"}`;

	try {
		const { data } = await llm.generateJson({
			task: "json",
			contents: [{ role: "user", parts: [{ text: prompt }] }],
			check: (parsed) =>
				READINGS.has(parsed?.reading) ? true : "reading must be one of the four",
		});
		return {
			reading: data.reading,
			why: typeof data.why === "string" ? data.why.slice(0, 300) : null,
		};
	} catch (err) {
		console.warn("[initiative] reply appraisal failed:", err.message);
		return null;
	}
}

/**
 * Appraise one reply and move the score. The fast path.
 *
 * Called in the background right after a person answers something she raised,
 * because "stop sending me this" must take effect on the spot — the second
 * unwanted nudge after you asked her to stop is the one that loses the person.
 *
 * Never throws: this runs off the back of a conversation turn and must not be
 * able to affect the reply.
 */
async function appraiseReply(profileId, nudge, replyText) {
	try {
		const judged = await judgeReply(nudge.text, replyText);
		if (!judged) return null;
		await pool
			.query(
				`UPDATE athena_nudge SET appraisal = ?, appraised_at = NOW() WHERE uuid = ?`,
				[JSON.stringify({ source: "reply", ...judged }), nudge.uuid]
			)
			.catch(() => undefined);
		const applied = await applyOutcome(profileId, nudge.trigger_id, judged.reading, {
			reason: judged.why || `reply read as ${judged.reading}`,
		});
		return { ...judged, ...applied };
	} catch (err) {
		console.warn("[initiative] appraiseReply failed:", err.message);
		return null;
	}
}

// ---------------------------------------------------------------------------
// The nightly sweep
// ---------------------------------------------------------------------------

/**
 * Fold in everything the fast path did not see: nudges that were dismissed,
 * and nudges that reached someone and were never answered.
 *
 * Deliberately excludes nudges that expired UNDELIVERED. Nobody saw those, so
 * they are evidence about delivery, not about whether the trigger was wanted —
 * counting them would teach her to stop raising things that are only invisible
 * because her push was not set up.
 */
async function sweep({ limit = 500 } = {}) {
	const [rows] = await pool.query(
		`SELECT uuid, profile_id, trigger_id, status
		 FROM athena_nudge
		 WHERE appraised_at IS NULL
		   AND status IN ('dismissed', 'expired', 'engaged')
		   AND (delivered_at IS NOT NULL OR pushed_at IS NOT NULL)
		   AND created_at >= NOW() - INTERVAL 14 DAY
		 ORDER BY created_at ASC LIMIT ?`,
		[Math.max(1, Math.min(Number(limit) || 500, 2000))]
	);

	const counts = { dismissed: 0, ignored: 0, engaged: 0 };
	for (const row of rows) {
		// `engaged` reaching the sweep means they replied but the fast path
		// never judged it (a model outage, or a restart mid-turn). Treated as
		// tolerated: they did answer, and we no longer have the words.
		const outcome =
			row.status === "dismissed" ? "dismissed" : row.status === "engaged" ? "tolerated" : "ignored";
		counts[row.status === "expired" ? "ignored" : row.status] += 1;
		await applyOutcome(Number(row.profile_id), row.trigger_id, outcome, {
			reason: row.status === "expired" ? "nobody answered it" : `marked ${row.status}`,
		}).catch(() => undefined);
		await pool
			.query(
				`UPDATE athena_nudge SET appraisal = ?, appraised_at = NOW() WHERE uuid = ?`,
				[JSON.stringify({ source: "sweep", reading: outcome }), row.uuid]
			)
			.catch(() => undefined);
	}
	return { appraised: rows.length, ...counts };
}

module.exports = {
	OUTCOME_WEIGHTS,
	ALPHA,
	SUPPRESS_BELOW,
	SUPPRESS_MIN_SAMPLES,
	scoreFor,
	scoresFor,
	applyOutcome,
	resume,
	judgeReply,
	appraiseReply,
	sweep,
};
