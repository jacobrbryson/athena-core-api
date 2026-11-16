/**
 * The latest capability-eval scores per endpoint, model and suite — the
 * evidence the router uses to let a local model answer first (preference.js).
 *
 * Written by every eval run (the nightly job, and "Run evals now" in the
 * Models tab), to memory and best-effort to `llm_eval_result` (migration
 * 0118). Read synchronously by the router from a cache that refreshes itself
 * from the table when it is older than REFRESH_MS — lazily, on the next read,
 * never on a timer.
 *
 * Missing table or no rows simply means "no evidence": the local tier then
 * stays a fallback, which is the safe default.
 */
const REFRESH_MS = 10 * 60_000;
// Evidence older than this doesn't count: models, prompts and Ollama change.
const MAX_AGE_MS = 8 * 24 * 60 * 60_000;

let cache = new Map(); // `${endpointId}|${suite}` -> { endpointId, tier, model, suite, passed, total, avgLatencyMs, at }
let loadedAt = 0;
let loading = null;
let dbEnabled = process.env.LLM_TELEMETRY_DB !== "false";

const key = (endpointId, suite) => `${endpointId}|${suite}`;

function pool() {
	return require("../../helpers/db");
}

function put(row) {
	const k = key(row.endpointId, row.suite);
	const have = cache.get(k);
	if (!have || have.at <= row.at) cache.set(k, row);
}

/**
 * Store one eval run: the shape runEvals() returns
 * ({ endpoints: { id: { tier, bySuite: { suite: { passed, total, model } }, avgLatencyMs } } }).
 */
function record(run, { source = "eval", now = Date.now() } = {}) {
	const rows = [];
	for (const [endpointId, r] of Object.entries(run?.endpoints || {})) {
		for (const [suite, s] of Object.entries(r.bySuite || {})) {
			if (!s.total) continue;
			rows.push({ endpointId, tier: r.tier, model: s.model || null, suite, passed: s.passed, total: s.total, avgLatencyMs: r.avgLatencyMs ?? null, at: now });
		}
	}
	rows.forEach(put);
	if (!dbEnabled || !rows.length) return rows;
	pool()
		.query(
			`INSERT INTO llm_eval_result (endpoint_id, tier, model, suite, passed, total, avg_latency_ms, source)
       VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
			rows.flatMap((r) => [r.endpointId, r.tier, r.model, r.suite, r.passed, r.total, r.avgLatencyMs, source])
		)
		.catch((err) => {
			if (err?.code === "ER_NO_SUCH_TABLE") dbEnabled = false;
			else console.warn("[llm] eval result insert failed:", err?.message || err);
		});
	return rows;
}

async function refresh() {
	if (!dbEnabled) return;
	if (loading) return loading;
	loading = (async () => {
		try {
			const [rows] = await pool().query(
				`SELECT r.endpoint_id, r.tier, r.model, r.suite, r.passed, r.total, r.avg_latency_ms, r.created_at
           FROM llm_eval_result r
           JOIN (SELECT endpoint_id, suite, MAX(id) AS id FROM llm_eval_result
                  WHERE created_at > NOW() - INTERVAL 8 DAY GROUP BY endpoint_id, suite) last
             ON last.id = r.id`
			);
			for (const r of rows || []) {
				put({
					endpointId: r.endpoint_id, tier: r.tier, model: r.model, suite: r.suite,
					passed: Number(r.passed), total: Number(r.total),
					avgLatencyMs: r.avg_latency_ms == null ? null : Number(r.avg_latency_ms),
					at: new Date(r.created_at).getTime(),
				});
			}
		} catch (err) {
			if (err?.code === "ER_NO_SUCH_TABLE") dbEnabled = false;
		} finally {
			loadedAt = Date.now();
			loading = null;
		}
	})();
	return loading;
}

/**
 * The latest score for an endpoint's suite, or null. Only counts when it was
 * measured on the model the endpoint is configured with now, and recently.
 */
function score(endpointId, suite, { model, now = Date.now() } = {}) {
	if (now - loadedAt > REFRESH_MS) refresh().catch(() => undefined);
	const row = cache.get(key(endpointId, suite));
	if (!row || now - row.at > MAX_AGE_MS) return null;
	if (model && row.model && row.model !== model) return null;
	return row;
}

/** Every cached row, newest first (the Models tab's scorecard). */
function all() {
	return [...cache.values()].sort((a, b) => b.at - a.at);
}

/** Scores over time for the scorecard trend (DB only; [] without the table). */
async function history({ days = 30 } = {}) {
	if (!dbEnabled) return [];
	try {
		const [rows] = await pool().query(
			`SELECT endpoint_id, model, suite, passed, total, source, created_at
         FROM llm_eval_result WHERE created_at > NOW() - INTERVAL ? DAY ORDER BY created_at`,
			[Math.min(90, Math.max(1, Number(days) || 30))]
		);
		return (rows || []).map((r) => ({
			endpointId: r.endpoint_id, model: r.model, suite: r.suite, passed: Number(r.passed),
			total: Number(r.total), source: r.source, at: new Date(r.created_at).getTime(),
		}));
	} catch (err) {
		if (err?.code === "ER_NO_SUCH_TABLE") dbEnabled = false;
		return [];
	}
}

function reset() {
	cache = new Map();
	loadedAt = 0;
	loading = null;
}

module.exports = { record, refresh, score, all, history, reset, MAX_AGE_MS, _setLoaded: (t = Date.now()) => (loadedAt = t), _disableDb: () => (dbEnabled = false) };
