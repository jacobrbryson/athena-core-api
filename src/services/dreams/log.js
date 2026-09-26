/**
 * Reading the Dreams log for the companion app — the dashboard's "Last
 * night's dream" and the Dreams history page. Read-only; every step leaves
 * through redact.js.
 */
const pool = require("../../helpers/db");
const { redactStep } = require("./redact");

const json = (v) => {
	if (v == null) return null;
	if (typeof v !== "string") return v;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
};
const day = (v) => (v instanceof Date ? v.toISOString() : String(v || "")).slice(0, 10);

function publicNight(r) {
	return {
		uuid: r.uuid,
		date: day(r.dream_date),
		status: r.status,
		summary: r.summary || null,
		narrative: r.narrative || null,
		// Served by GET /dreams/:uuid/image; the bucket path never leaves the API.
		hasImage: Boolean(r.image_path),
		stats: json(r.stats) || {},
		startedAt: r.started_at,
		finishedAt: r.finished_at,
	};
}

const COLUMNS = "uuid, dream_date, status, summary, narrative, image_path, stats, started_at, finished_at";

async function list({ days = 30 } = {}) {
	const [rows] = await pool.query(
		`SELECT ${COLUMNS} FROM athena_dream WHERE started_at >= DATE_SUB(NOW(), INTERVAL ? DAY) ORDER BY started_at DESC LIMIT 100`,
		[days]
	);
	return rows.map(publicNight);
}

/** The most recent night that actually dreamed (not skipped, not still running). */
async function latest() {
	const [[row]] = await pool.query(
		`SELECT ${COLUMNS} FROM athena_dream WHERE status IN ('ok', 'partial', 'failed') ORDER BY started_at DESC LIMIT 1`
	);
	return row ? publicNight(row) : null;
}

async function night(uuid, { viewerProfileId }) {
	const [[row]] = await pool.query(`SELECT id, ${COLUMNS} FROM athena_dream WHERE uuid = ? LIMIT 1`, [uuid]);
	if (!row) return null;
	const [steps] = await pool.query(
		`SELECT seq, round, kind, statement, why, ok, error, affected_rows, ms, created_at
     FROM athena_dream_step WHERE dream_id = ? ORDER BY seq`,
		[row.id]
	);
	return {
		...publicNight(row),
		steps: steps.map((s) => {
			const r = redactStep(s, { viewerProfileId });
			return {
				seq: r.seq,
				round: r.round,
				kind: r.kind,
				statement: r.statement,
				why: r.why,
				ok: Boolean(r.ok),
				error: r.error,
				affectedRows: r.affected_rows,
				ms: r.ms,
			};
		}),
	};
}

/** The stored picture's gs:// path, or null. */
async function imagePath(uuid) {
	const [[row]] = await pool.query(`SELECT image_path FROM athena_dream WHERE uuid = ? LIMIT 1`, [uuid]);
	return row?.image_path || null;
}

/** Only the viewer's own questions — the others are someone else's memories. */
async function questionsFor(profileId) {
	const [rows] = await pool.query(
		`SELECT uuid, question, status, answer, created_at, answered_at FROM athena_dream_question
     WHERE profile_id = ? AND (status = 'pending' OR created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY))
     ORDER BY created_at DESC LIMIT 50`,
		[profileId]
	);
	return rows.map((r) => ({
		uuid: r.uuid,
		question: r.question,
		status: r.status,
		answer: r.answer,
		askedAt: r.created_at,
		answeredAt: r.answered_at,
	}));
}

module.exports = { list, latest, night, questionsFor, imagePath };
