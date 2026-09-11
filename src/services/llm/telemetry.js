/**
 * Per-call LLM telemetry.
 *
 * Every routed call — success, error, invalid output, or fallback — is kept in
 * a small in-memory ring (for /llm/status) and written best-effort to the
 * `llm_call_log` table, which the nightly self-review reads. Logging must never
 * slow down or break a reply: inserts are fire-and-forget, and if the table
 * doesn't exist yet (migration not applied) DB logging switches itself off.
 */

const RING_SIZE = 200;
const ring = [];
let dbEnabled = process.env.LLM_TELEMETRY_DB !== "false";

function pool() {
	return require("../../helpers/db");
}

function recordCall(entry) {
	const row = {
		at: Date.now(),
		task: entry.task,
		endpointId: entry.endpointId,
		tier: entry.tier,
		model: entry.model || null,
		outcome: entry.outcome, // ok | error | invalid
		latencyMs: Math.round(entry.latencyMs || 0),
		attempt: entry.attempt || 0,
		inputChars: entry.inputChars || 0,
		outputChars: entry.outputChars || 0,
		error: entry.error ? String(entry.error).slice(0, 300) : null,
		audience: entry.audience || null,
	};
	ring.push(row);
	if (ring.length > RING_SIZE) ring.shift();

	if (!dbEnabled) return;
	pool()
		.query(
			`INSERT INTO llm_call_log
         (task, endpoint_id, tier, model, outcome, latency_ms, attempt, input_chars, output_chars, error, audience)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				row.task,
				row.endpointId,
				row.tier,
				row.model,
				row.outcome,
				row.latencyMs,
				row.attempt,
				row.inputChars,
				row.outputChars,
				row.error,
				row.audience,
			]
		)
		.catch((err) => {
			if (err?.code === "ER_NO_SUCH_TABLE") {
				dbEnabled = false;
				console.warn("[llm] llm_call_log missing — run migrations; DB telemetry disabled.");
			}
		});
}

function recent(limit = 50) {
	return ring.slice(-limit);
}

module.exports = { recordCall, recent, _disableDb: () => (dbEnabled = false) };
