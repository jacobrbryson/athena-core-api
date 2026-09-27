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
 *
 * Timeouts are treated differently, because a hung inference server is the
 * expensive failure: every call waits the full timeout (60s) before the next
 * tier answers, while a refused connection fails in milliseconds. So one
 * timeout opens the circuit immediately, and the background /models probe
 * cannot close a circuit a timeout opened — a hung server still lists its
 * models (that was 2026-09-27: probe green every minute, every chat 60s late).
 * It closes the way it should: the cooldown lapses, one real call goes through
 * (half-open), and it succeeds.
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
	h.openedByTimeout = false;
	h.lastOkAt = now;
	h.errorRate = h.errorRate * (1 - EWMA_ALPHA);
	if (Number.isFinite(latencyMs)) {
		h.latencyMs =
			h.latencyMs == null
				? latencyMs
				: h.latencyMs * (1 - EWMA_ALPHA) + latencyMs * EWMA_ALPHA;
	}
}

/** An adapter abort ("<id> /chat/completions timed out") or a fetch timeout. */
function isTimeout(error) {
	const msg = String(error?.message || error || "");
	return error?.name === "TimeoutError" || error?.name === "AbortError" || /timed out|timeout/i.test(msg);
}

function reportFailure(id, error, now = Date.now()) {
	const h = record(id);
	const timedOut = isTimeout(error);
	h.calls += 1;
	h.consecutiveFailures += 1;
	h.lastErrorAt = now;
	h.lastError = String(error?.message || error || "unknown").slice(0, 300);
	h.errorRate = h.errorRate * (1 - EWMA_ALPHA) + EWMA_ALPHA;
	if (timedOut || h.consecutiveFailures >= FAILURE_THRESHOLD) {
		const cooldown = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** h.trips);
		h.trips += 1;
		h.openUntil = now + cooldown;
		h.openedByTimeout = timedOut;
	}
}

/**
 * The background probe answered. It proves the server is listening, not that
 * it can generate — so it clears a circuit that connection failures opened,
 * but leaves one a timeout opened for a real call to close.
 */
function reportProbeOk(id, latencyMs, now = Date.now()) {
	const h = record(id);
	if (h.openedByTimeout && h.openUntil > now) return;
	reportSuccess(id, latencyMs, now);
}

function snapshot(now = Date.now()) {
	return [...state.values()].map((h) => ({
		id: h.id,
		available: h.openUntil <= now,
		circuit: h.openUntil > now ? "open" : "closed",
		openedByTimeout: h.openUntil > now && !!h.openedByTimeout,
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
	reportProbeOk,
	isTimeout,
	snapshot,
	reset,
};
