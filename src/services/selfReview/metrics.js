/**
 * Performance metrics for the nightly self-review.
 *
 * Every section degrades independently: a missing table (migration not yet
 * applied) or a failed query yields { available: false, reason } for that
 * section instead of failing the whole review.
 */
const pool = require("../../helpers/db");
const { SMOKE_PREFIX } = require("../llm/telemetry");

function percentile(sorted, p) {
	if (!sorted.length) return null;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx];
}

async function section(fn) {
	try {
		return { available: true, ...(await fn()) };
	} catch (err) {
		return {
			available: false,
			reason: err?.code === "ER_NO_SUCH_TABLE" ? "table missing — apply migrations" : String(err?.message || err).slice(0, 200),
		};
	}
}

/** Aggregate llm_call_log rows into per-task and per-endpoint stats. */
function summarizeCalls(rows) {
	const byTask = {};
	const byEndpoint = {};
	let smokeCalls = 0;
	for (const r of rows) {
		if (r.task === "eval") continue; // nightly evals never skew production metrics
		// Deliberate post-deploy testing is real traffic but not a health signal;
		// counted and reported, never silently dropped (see llm/telemetry.js).
		if (typeof r.task === "string" && r.task.startsWith(SMOKE_PREFIX)) {
			smokeCalls += 1;
			continue;
		}
		const t = (byTask[r.task] ||= { calls: 0, ok: 0, errors: 0, invalid: 0, fallbackServed: 0, latencies: [], tiers: {} });
		t.calls += 1;
		if (r.outcome === "ok") {
			t.ok += 1;
			t.latencies.push(Number(r.latency_ms));
			t.tiers[r.tier] = (t.tiers[r.tier] || 0) + 1;
			if (Number(r.attempt) > 0) t.fallbackServed += 1;
		} else if (r.outcome === "invalid") t.invalid += 1;
		else t.errors += 1;

		const e = (byEndpoint[r.endpoint_id] ||= { tier: r.tier, calls: 0, errors: 0, invalid: 0, latencies: [] });
		e.calls += 1;
		if (r.outcome === "error") e.errors += 1;
		if (r.outcome === "invalid") e.invalid += 1;
		if (r.outcome === "ok") e.latencies.push(Number(r.latency_ms));
	}
	const finish = (o) => {
		const lat = o.latencies.sort((a, b) => a - b);
		delete o.latencies;
		o.p50Ms = percentile(lat, 50);
		o.p95Ms = percentile(lat, 95);
		o.errorRate = o.calls ? +(o.errors / o.calls).toFixed(3) : 0;
		o.invalidRate = o.calls ? +(o.invalid / o.calls).toFixed(3) : 0;
		return o;
	};
	for (const k of Object.keys(byTask)) {
		const t = finish(byTask[k]);
		const served = Object.values(t.tiers).reduce((a, b) => a + b, 0);
		t.localShare = served ? +(((t.tiers.orcwood || 0) + (t.tiers.device || 0)) / served).toFixed(3) : 0;
		t.fallbackRate = t.ok ? +(t.fallbackServed / t.ok).toFixed(3) : 0;
	}
	for (const k of Object.keys(byEndpoint)) finish(byEndpoint[k]);
	const counted = (r) => r.task !== "eval" && !String(r.task).startsWith(SMOKE_PREFIX);
	return { byTask, byEndpoint, totalCalls: rows.filter(counted).length, smokeCalls };
}

async function modelMetrics(fromHoursAgo, toHoursAgo = 0) {
	return section(async () => {
		const [rows] = await pool.query(
			`SELECT task, endpoint_id, tier, outcome, latency_ms, attempt FROM llm_call_log
       WHERE created_at >= NOW() - INTERVAL ? HOUR AND created_at < NOW() - INTERVAL ? HOUR;`,
			[fromHoursAgo, toHoursAgo]
		);
		return summarizeCalls(rows);
	});
}

async function chatMetrics() {
	return section(async () => {
		const [[totals]] = await pool.query(
			`SELECT COUNT(*) AS messages, COALESCE(SUM(is_human), 0) AS human,
              COUNT(DISTINCT session_id) AS sessions
       FROM message WHERE created_at >= NOW() - INTERVAL 24 HOUR;`
		);
		// A session whose latest message is the person's, sitting unanswered for
		// 5+ minutes, is a dropped reply (model failure, validation, rate limit).
		const [[dropped]] = await pool.query(
			`SELECT COUNT(*) AS dropped FROM (
         SELECT m.session_id,
                SUBSTRING_INDEX(GROUP_CONCAT(m.is_human ORDER BY m.created_at DESC), ',', 1) AS last_is_human,
                MAX(m.created_at) AS last_at
         FROM message m WHERE m.created_at >= NOW() - INTERVAL 24 HOUR
         GROUP BY m.session_id
       ) t WHERE t.last_is_human = '1' AND t.last_at < NOW() - INTERVAL 5 MINUTE;`
		);
		const [modes] = await pool.query(
			`SELECT COALESCE(mode, 'unknown') AS mode, COUNT(*) AS n FROM message
       WHERE created_at >= NOW() - INTERVAL 24 HOUR AND is_human = 1 GROUP BY mode;`
		);
		return {
			messages: Number(totals.messages),
			humanMessages: Number(totals.human),
			sessions: Number(totals.sessions),
			droppedReplies: Number(dropped.dropped),
			byMode: Object.fromEntries(modes.map((m) => [m.mode, Number(m.n)])),
		};
	});
}

async function memoryMetrics(space) {
	return section(async () => {
		const [kinds] = await pool.query(
			`SELECT kind, COUNT(*) AS n FROM memory_event
       WHERE created_at >= NOW() - INTERVAL 24 HOUR AND deleted_at IS NULL GROUP BY kind;`
		);
		const [[facts]] = await pool.query(
			`SELECT COUNT(*) AS n FROM user_memory
       WHERE updated_at >= NOW() - INTERVAL 24 HOUR AND source = 'ai' AND deleted_at IS NULL;`
		);
		// Embedding happens in the background right after a memory is written, so
		// anything newer than a few minutes is in flight rather than missing.
		const [[coverage]] = await pool.query(
			`SELECT COUNT(*) AS total, COALESCE(SUM(m.id IS NOT NULL), 0) AS embedded
       FROM memory_event e
       LEFT JOIN memory_embedding m ON m.memory_type = 'event' AND m.memory_id = e.id AND m.space = ?
       WHERE e.deleted_at IS NULL AND e.created_at < NOW() - INTERVAL 10 MINUTE;`,
			[space]
		);
		const [[recalled]] = await pool.query(
			`SELECT COUNT(*) AS n FROM memory_event WHERE last_recalled_at >= NOW() - INTERVAL 24 HOUR;`
		);
		const [[quietDays]] = await pool.query(
			`SELECT COUNT(*) AS n FROM memory_event
       WHERE kind = 'conversation' AND created_at >= NOW() - INTERVAL 72 HOUR;`
		);
		const total = Number(coverage.total);
		return {
			newEventsByKind: Object.fromEntries(kinds.map((k) => [k.kind, Number(k.n)])),
			newAiFacts: Number(facts.n),
			totalEvents: total,
			embeddingCoverage: total ? +(Number(coverage.embedded) / total).toFixed(3) : 1,
			eventsRecalled24h: Number(recalled.n),
			conversationMoments72h: Number(quietDays.n),
		};
	});
}

async function collectMetrics({ embeddingSpace }) {
	const [last24h, baseline7d, chat, memory] = await Promise.all([
		modelMetrics(24, 0),
		modelMetrics(24 * 8, 24),
		chatMetrics(),
		memoryMetrics(embeddingSpace),
	]);
	return { models: { last24h, baseline7d }, chat, memory };
}

module.exports = { collectMetrics, summarizeCalls, percentile };
