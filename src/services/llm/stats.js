/**
 * Model routing stats for the Models tab, read from `llm_call_log`.
 *
 * Real traffic only: smoke tests (task "smoke:*", which is also where drills
 * and the lab's compare land) and evals (task "eval") are counted apart, so a
 * drill never reads as an outage and an eval never as production traffic.
 *
 * "Fallback" means a call that a later endpoint answered after an earlier one
 * failed (attempt > 0). Everything else that succeeded was a first choice.
 */
const pool = () => require("../../helpers/db");

const num = (name, fallback) => {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v >= 0 ? v : fallback;
};

function percentile(sorted, p) {
	if (!sorted.length) return null;
	const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[i];
}

/**
 * Error bursts: hours where an endpoint failed at least half of its calls
 * (and at least 3), merged into incidents. A cheap stand-in for a state log:
 * the circuit breaker lives in memory and forgets on every deploy.
 */
function incidents(hourly) {
	const byEndpoint = new Map();
	for (const h of hourly) {
		if (!byEndpoint.has(h.endpointId)) byEndpoint.set(h.endpointId, []);
		byEndpoint.get(h.endpointId).push(h);
	}
	const out = [];
	for (const [endpointId, hours] of byEndpoint) {
		let cur = null;
		for (const h of hours.sort((a, b) => a.hour - b.hour)) {
			const bad = h.errors >= 3 && h.errors / h.calls >= 0.5;
			if (bad && cur && h.hour - cur.endsAt <= 3600_000) {
				cur.endsAt = h.hour + 3600_000;
				cur.errors += h.errors;
				cur.quota = cur.quota || h.quota > 0;
			} else if (bad) {
				cur = { endpointId, startsAt: h.hour, endsAt: h.hour + 3600_000, errors: h.errors, quota: h.quota > 0 };
				out.push(cur);
			}
		}
	}
	return out.sort((a, b) => b.startsAt - a.startsAt).slice(0, 20);
}

/**
 * Stats over the last `days` (1–30).
 * Returns { days, totals, byEndpoint[], byTask[], incidents[], savings, tests }.
 */
async function getStats({ days = 1 } = {}) {
	const d = Math.min(30, Math.max(1, Math.round(Number(days) || 1)));
	const db = pool();
	const real = "task NOT LIKE 'smoke:%' AND task <> 'eval'";
	const [[agg], [lat], [hourly], [tests]] = await Promise.all([
		db.query(
			`SELECT endpoint_id, tier, task,
              COUNT(*) AS calls,
              SUM(outcome = 'ok') AS ok,
              SUM(outcome = 'error') AS errors,
              SUM(outcome = 'invalid') AS invalid,
              SUM(outcome = 'ok' AND attempt > 0) AS fallback_ok,
              SUM(CASE WHEN outcome = 'ok' THEN input_chars ELSE 0 END) AS in_chars,
              SUM(CASE WHEN outcome = 'ok' THEN output_chars ELSE 0 END) AS out_chars
         FROM llm_call_log
        WHERE created_at > NOW() - INTERVAL ? DAY AND ${real}
        GROUP BY endpoint_id, tier, task`,
			[d]
		),
		// Latencies for percentiles: successful calls only, capped so a busy
		// week can't make this a heavy read.
		db.query(
			`SELECT endpoint_id, task, latency_ms FROM llm_call_log
        WHERE created_at > NOW() - INTERVAL ? DAY AND ${real} AND outcome = 'ok'
        ORDER BY id DESC LIMIT 20000`,
			[d]
		),
		db.query(
			`SELECT endpoint_id, UNIX_TIMESTAMP(DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00')) * 1000 AS hour,
              COUNT(*) AS calls, SUM(outcome = 'error') AS errors,
              SUM(outcome = 'error' AND (error LIKE '%quota%' OR error LIKE '%RESOURCE_EXHAUSTED%' OR error LIKE '%429%')) AS quota
         FROM llm_call_log
        WHERE created_at > NOW() - INTERVAL ? DAY AND ${real}
        GROUP BY endpoint_id, hour`,
			[Math.max(d, 7)]
		),
		db.query(
			`SELECT SUM(task LIKE 'smoke:%') AS smoke, SUM(task = 'eval') AS evals
         FROM llm_call_log WHERE created_at > NOW() - INTERVAL ? DAY`,
			[d]
		),
	]);

	const latencies = new Map();
	for (const r of lat || []) {
		const k = `${r.endpoint_id}|${r.task}`;
		if (!latencies.has(k)) latencies.set(k, []);
		latencies.get(k).push(Number(r.latency_ms));
	}
	const pct = (list) => {
		const s = [...(list || [])].sort((a, b) => a - b);
		return { p50: percentile(s, 50), p95: percentile(s, 95) };
	};

	const rows = (agg || []).map((r) => ({
		endpointId: r.endpoint_id,
		tier: r.tier,
		task: r.task,
		calls: Number(r.calls),
		ok: Number(r.ok),
		errors: Number(r.errors),
		invalid: Number(r.invalid),
		fallbackOk: Number(r.fallback_ok),
		inChars: Number(r.in_chars),
		outChars: Number(r.out_chars),
		...pct(latencies.get(`${r.endpoint_id}|${r.task}`)),
	}));

	const roll = (keyOf) => {
		const m = new Map();
		for (const r of rows) {
			const k = keyOf(r);
			const t = m.get(k) || { key: k, tier: r.tier, calls: 0, ok: 0, errors: 0, invalid: 0, fallbackOk: 0, latency: [] };
			t.calls += r.calls; t.ok += r.ok; t.errors += r.errors; t.invalid += r.invalid; t.fallbackOk += r.fallbackOk;
			t.latency.push(...(latencies.get(`${r.endpointId}|${r.task}`) || []));
			m.set(k, t);
		}
		return [...m.values()].map(({ latency, ...t }) => ({ ...t, ...pct(latency) })).sort((a, b) => b.calls - a.calls);
	};

	const totals = rows.reduce((t, r) => {
		t.calls += r.calls; t.ok += r.ok; t.fallbackOk += r.fallbackOk;
		if (r.tier === "orcwood") t.localOk += r.ok;
		return t;
	}, { calls: 0, ok: 0, fallbackOk: 0, localOk: 0 });
	totals.localShare = totals.ok ? +(totals.localOk / totals.ok).toFixed(3) : 0;

	// What the locally answered calls would have cost on the cloud model.
	// An estimate: ~4 characters a token, list prices from env.
	const local = rows.filter((r) => r.tier === "orcwood");
	const inTok = local.reduce((s, r) => s + r.inChars, 0) / 4;
	const outTok = local.reduce((s, r) => s + r.outChars, 0) / 4;
	const usdIn = num("LLM_EST_USD_PER_MTOK_IN", 0.1);
	const usdOut = num("LLM_EST_USD_PER_MTOK_OUT", 0.4);
	const savings = {
		calls: local.reduce((s, r) => s + r.ok, 0),
		tokens: Math.round(inTok + outTok),
		usd: +((inTok / 1e6) * usdIn + (outTok / 1e6) * usdOut).toFixed(4),
		estimate: true,
	};

	return {
		days: d,
		totals,
		byEndpoint: roll((r) => r.endpointId),
		byTask: rows.sort((a, b) => b.calls - a.calls).map(({ inChars, outChars, ...r }) => r),
		incidents: incidents((hourly || []).map((h) => ({ endpointId: h.endpoint_id, hour: Number(h.hour), calls: Number(h.calls), errors: Number(h.errors), quota: Number(h.quota) }))),
		tests: { smoke: Number(tests?.[0]?.smoke || 0), evals: Number(tests?.[0]?.evals || 0) },
	};
}

module.exports = { getStats, incidents, percentile };
