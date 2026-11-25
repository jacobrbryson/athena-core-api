/**
 * Signal Relay (owner, 2026-11-24): the kids' Morse-code game, played on the
 * tablet with no network. A run is finished there and posted here later, so
 * this only records what the tablet says happened — it is a game score, not
 * proof of anything, and nothing reads it but the kid's own points.
 *
 * A kid can play as much as they like; only RELAY_RUNS_PER_DAY runs a day
 * count toward points, so a long drive doesn't outweigh real missions.
 */
const pool = require("../../helpers/db");

const RELAY_RUNS_PER_DAY = 2;
const MAX_RUNS_PER_POST = 50;
const MAX_AGE_DAYS = 30;
const MAX_MESSAGES = 20;

/** A posted run, or null when it can't be one. Times are clamped, never trusted. */
function cleanRun(run, now = new Date()) {
	if (!run || typeof run !== "object") return null;
	const id = typeof run.id === "string" ? run.id.trim() : "";
	if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return null;
	const at = new Date(run.at);
	if (Number.isNaN(at.getTime())) return null;
	const oldest = now.getTime() - MAX_AGE_DAYS * 86_400_000;
	if (at.getTime() < oldest) return null;
	const finishedAt = new Date(Math.min(at.getTime(), now.getTime()));
	const messages = Math.max(0, Math.min(MAX_MESSAGES, Math.round(Number(run.messages) || 0)));
	if (!messages) return null;
	const wpm = Number.isFinite(Number(run.wpm)) ? Math.max(0, Math.min(99, Math.round(Number(run.wpm)))) : null;
	return { id, finishedAt, messages, wpm };
}

/** Record a kid's runs. A run already recorded (same id) is skipped. */
async function record(actor, runs, now = new Date()) {
	const clean = (Array.isArray(runs) ? runs : []).slice(0, MAX_RUNS_PER_POST).map((r) => cleanRun(r, now)).filter(Boolean);
	if (!clean.length) return { saved: 0 };
	const [res] = await pool.query(
		"INSERT IGNORE INTO athena_gm_relay_run (actor_id, client_id, finished_at, messages, wpm) VALUES ?",
		[clean.map((r) => [actor.id, r.id, r.finishedAt, r.messages, r.wpm])]
	);
	return { saved: Number(res?.affectedRows) || 0 };
}

/** Runs that count toward points, per kid actor id: at most RELAY_RUNS_PER_DAY a day. */
async function countedRuns(actorIds) {
	const ids = [...new Set((actorIds || []).map(Number).filter(Boolean))];
	if (!ids.length) return new Map();
	const [rows] = await pool
		.query(
			`SELECT actor_id, SUM(LEAST(n, ?)) AS runs FROM (
			   SELECT actor_id, DATE(finished_at) AS d, COUNT(*) AS n FROM athena_gm_relay_run WHERE actor_id IN (?) GROUP BY actor_id, d
			 ) days GROUP BY actor_id`,
			[RELAY_RUNS_PER_DAY, ids]
		)
		// Before migration 0128 is applied the table isn't there: no runs yet.
		.catch(() => [[]]);
	return new Map(rows.map((r) => [Number(r.actor_id), Number(r.runs) || 0]));
}

module.exports = { record, countedRuns, cleanRun, RELAY_RUNS_PER_DAY };
