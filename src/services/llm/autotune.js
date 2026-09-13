/** Bounded runtime tuning of existing candidates. Never changes provider policy,
 * grants, model identities, embedding space, or persisted configuration.
 * Only real task outcomes count; a successful /models probe proves no quality.
 */
const WINDOW_MS = 5 * 60_000;
const MIN_SAMPLES = 5;
const SLOW_MS = 8_000;

function assess(endpoint, task, calls, audience, now) {
	const samples = calls.filter((c) => c.endpointId === endpoint.id &&
		c.model === endpoint.models[task] && c.task === task &&
		(c.audience === "child") === (audience === "child") &&
		c.at <= now && c.at > now - WINDOW_MS).slice(-20);
	const failures = samples.filter((c) => c.outcome !== "ok").length;
	const successes = samples.filter((c) => c.outcome === "ok");
	const latencyMs = successes.length
		? Math.round(successes.reduce((sum, c) => sum + c.latencyMs, 0) / successes.length) : null;
	let reason = "learning";
	let penalty = 0;
	if (samples.length >= MIN_SAMPLES) {
		reason = "meeting-target";
		if (failures / samples.length >= 0.4) {
			reason = "repeated-errors-or-invalid-output";
			penalty = 2;
		} else if (latencyMs > SLOW_MS) {
			reason = "slow-responses";
			penalty = 1;
		}
	}
	return { endpointId: endpoint.id, model: endpoint.models[task], samples: samples.length,
		failures, latencyMs, reason, penalty };
}

function tune(candidates, task, calls, { audience, now = Date.now() } = {}) {
	const diagnostics = candidates.map((e) => assess(e, task, calls, audience, now));
	const byId = new Map(diagnostics.map((d) => [d.endpointId, d]));
	// Preserve tier slots exactly; tuning cannot promote a different provider tier.
	const groups = new Map();
	for (const endpoint of candidates) {
		if (!groups.has(endpoint.tier)) groups.set(endpoint.tier, []);
		groups.get(endpoint.tier).push(endpoint);
	}
	for (const group of groups.values()) {
		group.sort((a, b) => byId.get(a.id).penalty - byId.get(b.id).penalty);
	}
	const ordered = candidates.map((e) => groups.get(e.tier).shift());
	return { ordered, diagnostics };
}

module.exports = { tune, WINDOW_MS, MIN_SAMPLES, SLOW_MS };
