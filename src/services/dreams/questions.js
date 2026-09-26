/**
 * Questions Athena wants to ask after a dream — the things she couldn't settle
 * from the data alone ("Is the Emma in Denver your sister Emma?").
 *
 * They reach the person two ways, and both are allowed to happen:
 *   - in conversation: pending questions ride in the chat prompt and she asks
 *     at a natural moment ("Can I ask you something?"). Each time one is put
 *     in front of her, `offered_session_id/offered_at` records where.
 *   - as a nudge: the `dream_question` initiative trigger, for people who
 *     opted in to initiative. Opt-in, mute and quiet hours apply as for any
 *     other trigger.
 *
 * Nothing here decides what an answer MEANS. The next dream reads what was
 * said after the question was offered and records her reading of it; the
 * answer then feeds her tables through the `_clarification` mirror.
 */
const { v4: uuidv4 } = require("uuid");
const pool = require("../../helpers/db");

const QUESTION_TTL_DAYS = 14;
const MAX_PENDING_PER_PROFILE = 10;

async function create({ profileId, dreamId, question, context }) {
	const text = String(question || "").replace(/\s+/g, " ").trim().slice(0, 500);
	if (!text) throw new Error("empty question");
	const [[{ n }]] = await pool.query(
		`SELECT COUNT(*) AS n FROM athena_dream_question WHERE profile_id = ? AND status = 'pending' AND expires_at > NOW()`,
		[profileId]
	);
	if (n >= MAX_PENDING_PER_PROFILE) throw new Error(`already ${n} questions waiting for this person`);
	const [[dup]] = await pool.query(
		`SELECT id FROM athena_dream_question WHERE profile_id = ? AND status = 'pending' AND question = ? LIMIT 1`,
		[profileId, text]
	);
	if (dup) throw new Error("that question is already waiting");
	const uuid = uuidv4();
	const [res] = await pool.query(
		`INSERT INTO athena_dream_question (uuid, profile_id, dream_id, question, context, expires_at)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
		[uuid, profileId, dreamId || null, text, context ? JSON.stringify(context) : null, QUESTION_TTL_DAYS]
	);
	return { id: res.insertId, uuid };
}

async function pendingFor(profileId, limit = 3) {
	const [rows] = await pool.query(
		`SELECT id, uuid, dream_id, question, created_at, offered_at FROM athena_dream_question
     WHERE profile_id = ? AND status = 'pending' AND expires_at > NOW()
     ORDER BY created_at ASC LIMIT ?`,
		[profileId, limit]
	);
	return rows;
}

/**
 * Record that these questions were put in front of her in this session. The
 * clock only restarts when the session changes, so the next dream reads the
 * whole stretch of conversation since she first could have asked.
 */
async function markOffered(ids, sessionId) {
	if (!ids.length || !sessionId) return;
	await pool.query(
		`UPDATE athena_dream_question
     SET offered_at = CASE WHEN offered_session_id <=> ? THEN offered_at ELSE NOW() END,
         offered_session_id = ?
     WHERE id IN (?) AND status = 'pending'`,
		[sessionId, sessionId, ids]
	);
}

/** Offered, still-pending questions with what was said since — for the dream to read. */
async function offeredWithTranscripts(limitPerQuestion = 24) {
	const [questions] = await pool.query(
		`SELECT id, profile_id, question, offered_session_id, offered_at FROM athena_dream_question
     WHERE status = 'pending' AND offered_session_id IS NOT NULL AND expires_at > NOW()`
	);
	for (const q of questions) {
		// Only the person's own words and Athena's replies — another participant's
		// lines are not this person's answer.
		const [lines] = await pool.query(
			`SELECT is_human, text, created_at FROM message
       WHERE session_id = ? AND created_at >= DATE_SUB(?, INTERVAL 2 MINUTE)
         AND (is_human = 0 OR profile_id = ?)
       ORDER BY created_at ASC LIMIT ?`,
			[q.offered_session_id, q.offered_at, q.profile_id, limitPerQuestion]
		);
		q.transcript = lines.map((l) => `${l.is_human ? "person" : "athena"}: ${String(l.text).replace(/\s+/g, " ").slice(0, 400)}`);
	}
	return questions;
}

/** Her reading of the answer, or her decision to let the question go. */
async function resolve(id, { status, answer }) {
	if (!["answered", "dismissed"].includes(status)) throw new Error("status must be answered or dismissed");
	const [res] = await pool.query(
		`UPDATE athena_dream_question SET status = ?, answer = ?, answered_at = NOW()
     WHERE id = ? AND status = 'pending'`,
		[status, answer ? String(answer).slice(0, 2000) : null, id]
	);
	if (!res.affectedRows) throw new Error(`question ${id} is not pending`);
	return { affectedRows: res.affectedRows };
}

async function answeredFor(profileIds) {
	if (!profileIds.length) return [];
	const [rows] = await pool.query(
		`SELECT id, profile_id, question, answer, answered_at FROM athena_dream_question
     WHERE status = 'answered' AND profile_id IN (?)`,
		[profileIds]
	);
	return rows;
}

async function expireStale() {
	const [res] = await pool.query(
		`UPDATE athena_dream_question SET status = 'expired' WHERE status = 'pending' AND expires_at <= NOW()`
	);
	return res.affectedRows || 0;
}

/** Answers are data and stay; unanswered questions older than 30 days are just clutter. */
async function prune(days = 30) {
	const [res] = await pool.query(
		`DELETE FROM athena_dream_question WHERE status IN ('expired', 'dismissed') AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
		[days]
	);
	return res.affectedRows || 0;
}

module.exports = {
	QUESTION_TTL_DAYS,
	create,
	pendingFor,
	markOffered,
	offeredWithTranscripts,
	resolve,
	answeredFor,
	expireStale,
	prune,
};
