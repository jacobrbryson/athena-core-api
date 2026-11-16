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
 *
 * A spent quota is the other failure that deserves its own rule (2026-11, when
 * Gemini ran out and most of the app went with it). "You have exceeded your
 * quota" is not going to change in 30 seconds, so retrying on the normal
 * backoff only makes every chat wait on a refusal before the next tier
 * answers. One quota error opens the circuit for LLM_QUOTA_COOLDOWN_MS (an
 * hour by default); after that a single real call checks whether it is back.
 * A per-minute rate limit (429 without quota/billing wording) opens it for the
 * normal cooldown instead — that one does clear quickly.
 */

const FAILURE_THRESHOLD = 3;
const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
const EWMA_ALPHA = 0.2;
const quotaCooldownMs = () => {
	const v = Number(process.env.LLM_QUOTA_COOLDOWN_MS);
	return Number.isFinite(v) && v > 0 ? v : 60 * 60_000;
};

/**
 * What kind of failure this was: quota | rate_limit | timeout | auth | error.
 * Gemini's SDK sets `status` (429 + RESOURCE_EXHAUSTED); the OpenAI-compatible
 * adapter puts "HTTP <code>" in the message (OpenAI's spent credit is a 429
 * `insufficient_quota`).
 */
function classify(error) {
	const msg = String(error?.message || error || "");
	const status = Number(error?.status || error?.code) || Number(msg.match(/HTTP (\d{3})/)?.[1]) || null;
	if (/RESOURCE_EXHAUSTED|quota|insufficient_quota|billing|credit balance|exceeded your current/i.test(msg)) return "quota";
	if (status === 429 || /rate.?limit|too many requests/i.test(msg)) return "rate_limit";
	if (isTimeout(error)) return "timeout";
	if (status === 401 || status === 403 || /unauthori[sz]ed|permission denied|invalid api key/i.test(msg)) return "auth";
	return "error";
}

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
	h.openReason = null;
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
	const kind = classify(error);
	const timedOut = kind === "timeout";
	h.calls += 1;
	h.consecutiveFailures += 1;
	h.lastErrorAt = now;
	h.lastError = String(error?.message || error || "unknown").slice(0, 300);
	h.lastErrorKind = kind;
	h.errorRate = h.errorRate * (1 - EWMA_ALPHA) + EWMA_ALPHA;
	if (kind === "quota") {
		h.trips += 1;
		h.openUntil = now + quotaCooldownMs();
		h.openedByTimeout = false;
		h.openReason = "quota";
		h.openedAt = now;
	} else if (timedOut || kind === "rate_limit" || h.consecutiveFailures >= FAILURE_THRESHOLD) {
		const cooldown = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** h.trips);
		h.trips += 1;
		h.openUntil = now + cooldown;
		h.openedByTimeout = timedOut;
		h.openReason = kind === "error" ? "errors" : kind;
		h.openedAt = now;
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
		openReason: h.openUntil > now ? h.openReason || "errors" : null,
		openedAt: h.openUntil > now ? h.openedAt || null : null,
		lastErrorKind: h.lastErrorKind || null,
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
	classify,
	quotaCooldownMs,
	snapshot,
	reset,
};
