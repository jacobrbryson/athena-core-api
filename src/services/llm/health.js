/**
 * Endpoint health + circuit breaker.
 *
 * Every real call reports its outcome here (passive health), and configured
 * Orcwood endpoints are also probed on an interval (active health, router.js).
 * After FAILURE_THRESHOLD consecutive failures an endpoint's circuit opens and
 * the router skips it until the cooldown passes; cooldowns back off
 * exponentially so a dead box isn't hammered. One success closes the circuit.
 *
 * This is what lets Athena manage her own models: an Orcwood server going down
 * (or coming back) changes routing within a request or two, with no deploy.
 */

const FAILURE_THRESHOLD = 3;
const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
const EWMA_ALPHA = 0.2;

const state = new Map(); // endpointId -> health record

function record(id) {
	let h = state.get(id);
	if (!h) {
		h = {
			id,
			consecutiveFailures: 0,
			openUntil: 0,
			trips: 0,
			latencyMs: null,
			errorRate: 0,
			lastOkAt: null,
			lastErrorAt: null,
			lastError: null,
			calls: 0,
		};
		state.set(id, h);
	}
	return h;
}

function isAvailable(id, now = Date.now()) {
	return record(id).openUntil <= now;
}

function reportSuccess(id, latencyMs, now = Date.now()) {
	const h = record(id);
	h.calls += 1;
	h.consecutiveFailures = 0;
	h.openUntil = 0;
	h.trips = 0;
	h.lastOkAt = now;
	h.errorRate = h.errorRate * (1 - EWMA_ALPHA);
	if (Number.isFinite(latencyMs)) {
		h.latencyMs =
			h.latencyMs == null
				? latencyMs
				: h.latencyMs * (1 - EWMA_ALPHA) + latencyMs * EWMA_ALPHA;
	}
}

function reportFailure(id, error, now = Date.now()) {
	const h = record(id);
	h.calls += 1;
	h.consecutiveFailures += 1;
	h.lastErrorAt = now;
	h.lastError = String(error?.message || error || "unknown").slice(0, 300);
	h.errorRate = h.errorRate * (1 - EWMA_ALPHA) + EWMA_ALPHA;
	if (h.consecutiveFailures >= FAILURE_THRESHOLD) {
		const cooldown = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** h.trips);
		h.trips += 1;
		h.openUntil = now + cooldown;
	}
}

function snapshot(now = Date.now()) {
	return [...state.values()].map((h) => ({
		id: h.id,
		available: h.openUntil <= now,
		circuit: h.openUntil > now ? "open" : "closed",
		reopensInMs: Math.max(0, h.openUntil - now),
		latencyMs: h.latencyMs == null ? null : Math.round(h.latencyMs),
		errorRate: Math.round(h.errorRate * 100) / 100,
		consecutiveFailures: h.consecutiveFailures,
		lastOkAt: h.lastOkAt,
		lastErrorAt: h.lastErrorAt,
		lastError: h.lastError,
		calls: h.calls,
	}));
}

function reset() {
	state.clear();
}

module.exports = {
	FAILURE_THRESHOLD,
	isAvailable,
	reportSuccess,
	reportFailure,
	snapshot,
	reset,
};
