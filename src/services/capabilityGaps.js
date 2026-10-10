/**
 * Capability gaps — the times Athena reached for something and it wasn't there.
 *
 * Written when a proposal she made was turned down (controllers/gemini.js),
 * with what happened next: she fixed it ("repaired"), offered the nearest
 * thing that works ("offered"), or ran out of options ("failed"). The nightly
 * review reads the week's counts by action and reason, so "three people asked
 * for a reminder at a time this week" becomes a finding instead of three
 * forgotten apologies.
 *
 * A record, never a gate: nothing reads this to decide what she may do, and
 * building anything it points at stays the owner's decision.
 *
 * Never throws and never awaited by the reply: an unmigrated database
 * (0058_capability_gap) costs the record, not the conversation.
 */
const pool = require("../helpers/db");

const STAGES = new Set(["params", "unavailable", "unknown", "execute", "error", "shape"]);
const OUTCOMES = new Set(["repaired", "offered", "failed"]);

const clip = (value, n) => (typeof value === "string" && value.trim() ? value.trim().slice(0, n) : null);

function record({ profileId, sessionId = null, message, actionId = null, stage, reason, outcome }) {
	if (!profileId || !STAGES.has(stage) || !OUTCOMES.has(outcome)) return Promise.resolve(false);
	return pool
		.query(
			`INSERT INTO athena_capability_gap (profile_id, session_id, action_id, stage, reason, outcome, asked)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				profileId,
				sessionId,
				clip(actionId, 64),
				stage,
				clip(reason, 300) || "(no reason given)",
				outcome,
				clip(message, 300),
			]
		)
		.then(() => true)
		.catch((err) => {
			console.warn("[capabilityGaps] not recorded:", err.message);
			return false;
		});
}

/**
 * The week, for the nightly review: counts by action, stage, reason and
 * outcome. Reasons and counts only — never what anyone said.
 */
async function weekSummary() {
	const [rows] = await pool.query(
		`SELECT action_id, stage, reason, outcome, COUNT(*) AS n
		 FROM athena_capability_gap
		 WHERE created_at >= NOW() - INTERVAL 7 DAY
		 GROUP BY action_id, stage, reason, outcome
		 ORDER BY n DESC
		 LIMIT 25`
	);
	const byOutcome = { repaired: 0, offered: 0, failed: 0 };
	for (const r of rows) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + Number(r.n);
	return {
		total7d: Object.values(byOutcome).reduce((a, b) => a + b, 0),
		byOutcome,
		top: rows.map((r) => ({
			actionId: r.action_id,
			stage: r.stage,
			reason: r.reason,
			outcome: r.outcome,
			count: Number(r.n),
		})),
	};
}

module.exports = { record, weekSummary };
