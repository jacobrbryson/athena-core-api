/**
 * A capability's track record from its test results, and the status that
 * record earns: "porch light: 12 tests, 11 passed, average delay 0.5s".
 *
 * Status is arithmetic over results, never a model's opinion:
 *   untested  no results
 *   broken    the last BROKEN_RUN results all failed
 *   working   at least WORKING_RATE of the recent window passed
 *   flaky     anything else
 *
 * Staleness: a capability or a person's skill last tested more than
 * STALE_DAYS ago is due a retest. This module gives the dashboard counts for
 * Athena's capabilities only; the kids' levels and skill percents, which the
 * owner chose on 2026-10-30, are worked out in team.js.
 */

const WINDOW = 20;
const BROKEN_RUN = 3;
const WORKING_RATE = 0.9;
const STALE_DAYS = 30;

/** results: newest first, each { passed, latency_ms, stage, created_at }. */
function summarize(results = []) {
	const total = results.length;
	const passed = results.filter((r) => r.passed === 1 || r.passed === true).length;
	const latencies = results.map((r) => Number(r.latency_ms)).filter((n) => Number.isFinite(n) && n >= 0);
	const avgLatencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;

	const stages = {};
	for (const r of results) {
		const key = r.stage || "run";
		stages[key] ||= { total: 0, passed: 0 };
		stages[key].total += 1;
		if (r.passed === 1 || r.passed === true) stages[key].passed += 1;
	}
	return { total, passed, avgLatencyMs, stages, status: statusOf(results), lastTestedAt: results[0]?.created_at || null };
}

function statusOf(results = []) {
	if (!results.length) return "untested";
	const ok = (r) => r.passed === 1 || r.passed === true;
	const head = results.slice(0, BROKEN_RUN);
	if (head.length === BROKEN_RUN && head.every((r) => !ok(r))) return "broken";
	const recent = results.slice(0, WINDOW);
	const rate = recent.filter(ok).length / recent.length;
	return rate >= WORKING_RATE ? "working" : "flaky";
}

function isStale(lastTestedAt, now = new Date()) {
	if (!lastTestedAt) return true;
	return now.getTime() - new Date(lastTestedAt).getTime() > STALE_DAYS * 24 * 3600 * 1000;
}

/** "12 tests, 11 passed, average delay 0.5s" */
function describe(summary) {
	if (!summary?.total) return "Not tested yet";
	const parts = [`${summary.total} test${summary.total === 1 ? "" : "s"}`, `${summary.passed} passed`];
	if (summary.avgLatencyMs != null) parts.push(`average delay ${(summary.avgLatencyMs / 1000).toFixed(1)}s`);
	return parts.join(", ");
}

module.exports = { summarize, statusOf, isStale, describe, STALE_DAYS, WINDOW };
