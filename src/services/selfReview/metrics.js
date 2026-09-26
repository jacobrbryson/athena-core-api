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
			extraction72h: await extractionMetrics(72),
		};
	});
}

/**
 * What extraction proposed versus wrote, from both the chat path and the
 * nightly sweep. Writes alone can't separate "nothing new was said" from "the
 * extractor is broken": from 09-20 the model kept re-stating known facts, the
 * duplicate check skipped every one, and the report only ever saw zeros.
 * Its own section so a missing table (0045 not applied) doesn't take the rest
 * of the memory metrics down with it.
 */
async function extractionMetrics(hours) {
	return section(async () => {
		const [[r]] = await pool.query(
			`SELECT COUNT(*) AS runs, COUNT(DISTINCT DATE(created_at)) AS days,
				COALESCE(SUM(human_lines), 0) AS humanLines,
				COALESCE(SUM(proposed_facts), 0) AS proposedFacts, COALESCE(SUM(proposed_moments), 0) AS proposedMoments,
				COALESCE(SUM(written_facts), 0) AS writtenFacts, COALESCE(SUM(written_moments), 0) AS writtenMoments,
				COALESCE(SUM(dropped_duplicate), 0) AS duplicate, COALESCE(SUM(dropped_low_confidence), 0) AS lowConfidence,
				COALESCE(SUM(dropped_locked), 0) AS locked, COALESCE(SUM(dropped_malformed), 0) AS malformed,
				COALESCE(SUM(dropped_over_cap), 0) AS overCap
			 FROM memory_extraction_log WHERE created_at >= NOW() - INTERVAL ? HOUR;`,
			[hours]
		);
		return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
	});
}

/**
 * Did Athena's interruptions earn their place?
 *
 * The measurement that matters is per TRIGGER, not overall: one bad rule
 * hidden inside a good average is exactly the thing that makes people switch
 * the whole feature off. Acceptance is engaged / (engaged + dismissed), and
 * a nudge nobody ever saw is excluded from both — it was never an
 * interruption, and counting it as a tolerated one would flatter a trigger
 * that only looks harmless because it fires while people are asleep.
 *
 * A mute is tracked separately and weighted far more heavily in the findings:
 * dismissing is "not now", muting is "never again".
 */
async function initiativeMetrics() {
	return section(async () => {
		const [rows] = await pool.query(
			`SELECT trigger_id,
				COUNT(*) AS sent,
				COALESCE(SUM(delivered_at IS NOT NULL), 0) AS seen,
				COALESCE(SUM(status = 'engaged'), 0) AS engaged,
				COALESCE(SUM(status = 'dismissed'), 0) AS dismissed,
				COALESCE(SUM(pushed_at IS NOT NULL), 0) AS pushed,
				-- Unseen means nobody could have seen it by ANY route. A nudge
				-- that was pushed reached a lock screen even if the app was
				-- never opened, so counting it as unseen would understate her
				-- reach and teach the review the wrong lesson about TTLs.
				COALESCE(SUM(status = 'expired' AND delivered_at IS NULL AND pushed_at IS NULL), 0) AS unseen,
				-- The other half of expired: it reached someone and got silence.
				-- Same reading as the nudgeAppraisal sweep's "ignored".
				COALESCE(SUM(status = 'expired' AND (delivered_at IS NOT NULL OR pushed_at IS NOT NULL)), 0) AS ignored
			 FROM athena_nudge
			 WHERE created_at >= NOW() - INTERVAL 7 DAY
			 GROUP BY trigger_id;`
		);
		// What she has taught herself. A trigger she suppressed is one that
		// stopped firing without anyone editing code, which is exactly the kind
		// of change a nightly report exists to surface.
		const [learned] = await pool.query(
			`SELECT trigger_id,
				COUNT(*) AS people,
				COALESCE(SUM(suppressed_at IS NOT NULL), 0) AS suppressed,
				AVG(score) AS avg_score
			 FROM athena_trigger_score GROUP BY trigger_id;`
		);
		const [mutes] = await pool.query(
			`SELECT trigger_id, COUNT(*) AS n FROM athena_trigger_mute GROUP BY trigger_id;`
		);
		const [[people]] = await pool.query(
			`SELECT COALESCE(SUM(enabled), 0) AS enabled, COUNT(*) AS known
			 FROM athena_initiative_pref;`
		);
		const mutedBy = Object.fromEntries(mutes.map((m) => [m.trigger_id, Number(m.n)]));
		const learnedBy = Object.fromEntries(
			learned.map((l) => [
				l.trigger_id,
				{
					people: Number(l.people),
					suppressed: Number(l.suppressed),
					avgScore: l.avg_score === null ? null : +Number(l.avg_score).toFixed(2),
				},
			])
		);
		const byTrigger = {};
		let sent = 0;
		for (const r of rows) {
			const engaged = Number(r.engaged);
			const dismissed = Number(r.dismissed);
			const answered = engaged + dismissed;
			sent += Number(r.sent);
			byTrigger[r.trigger_id] = {
				sent: Number(r.sent),
				seen: Number(r.seen),
				pushed: Number(r.pushed),
				engaged,
				dismissed,
				unseen: Number(r.unseen),
				ignored: Number(r.ignored),
				mutedBy: mutedBy[r.trigger_id] || 0,
				learned: learnedBy[r.trigger_id] || null,
				// null, not 0: "nobody has reacted yet" and "everybody hated it"
				// are different facts and must not produce the same finding.
				acceptance: answered ? +(engaged / answered).toFixed(2) : null,
			};
		}
		return {
			sent7d: sent,
			enabledProfiles: Number(people.enabled),
			byTrigger,
		};
	});
}

/**
 * Is anything reading the news? The nightly step only catches up memories for
 * headlines the athena-news job already stored, so with that job down it finds
 * nothing and looks healthy. Asked of the sources themselves instead.
 */
async function newsMetrics() {
	return section(async () => {
		const health = await require("../news/store").worldPollHealth();
		const [[items]] = await pool.query(
			`SELECT COUNT(*) AS n FROM news_item WHERE first_seen_at >= NOW() - INTERVAL 24 HOUR;`
		);
		return { ...health, items24h: Number(items.n) };
	});
}

async function collectMetrics({ embeddingSpace }) {
	const [last24h, baseline7d, chat, memory, initiative, news] = await Promise.all([
		modelMetrics(24, 0),
		modelMetrics(24 * 8, 24),
		chatMetrics(),
		memoryMetrics(embeddingSpace),
		initiativeMetrics(),
		newsMetrics(),
	]);
	return { models: { last24h, baseline7d }, chat, memory, initiative, news };
}

module.exports = { collectMetrics, summarizeCalls, percentile };
