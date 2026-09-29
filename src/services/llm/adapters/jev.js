/**
 * Jev (TypeSafe AI) adapter — a "System One" decision model.
 *
 * Jev writes no text. It takes a state (the person's words) and a set of typed
 * questions, and answers every question in parallel with a probability, in
 * roughly 0.1–0.4 s. Athena uses it for one thing: guessing, before the real
 * reply starts, which of her passive sources a message needs — so the reads
 * can start at once and she can say "let me check your calendar, hmm…" while
 * they run.
 *
 * Hosted only (no local weights), so this is a cloud provider like Gemini and
 * goes through the same live access check before every dispatch. The only
 * thing sent is the message text and the question definitions; nothing about
 * the person's accounts.
 *
 * API: POST https://api.typesafe.ai/v1/systemone, Bearer auth.
 * Question types used here: `noul` ({ noul: p }) and `choice`
 * ({ choice, probabilities, confidence }).
 */
const { assertModelAccess } = require("../../../security/access");

const BASE_URL = process.env.JEV_BASE_URL || "https://api.typesafe.ai";
const MODEL = process.env.JEV_MODEL || "jev-latest";
// A guess that arrives after the reply would have started is worthless, so the
// budget is tight and a miss is simply "no guess" — the caller falls back.
const DEFAULT_TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS) || 800;

function configured() {
	return !!process.env.JEV_API_KEY;
}

/**
 * Ask Jev a set of typed questions about `state`.
 * Returns { answers, model, usage }. Throws on any failure, including timeout.
 */
async function decide({ state, questions, timeoutMs = DEFAULT_TIMEOUT_MS }) {
	await assertModelAccess();
	if (!configured()) throw new Error("JEV_API_KEY is not set");
	if (!state || !questions || !Object.keys(questions).length) {
		throw new Error("Jev needs a state and at least one question");
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${BASE_URL}/v1/systemone`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.JEV_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model: MODEL, state, questions }),
			signal: controller.signal,
		});
		if (!res.ok) {
			const detail = (await res.text().catch(() => "")).slice(0, 200);
			throw Object.assign(new Error(`Jev HTTP ${res.status}${detail ? `: ${detail}` : ""}`), {
				status: res.status,
			});
		}
		const data = await res.json();
		if (!data || typeof data.answers !== "object") throw new Error("Jev returned no answers");
		return { answers: data.answers, model: data.model || MODEL, usage: data.usage || null };
	} catch (err) {
		if (err.name === "AbortError") throw new Error(`Jev timed out after ${timeoutMs} ms`);
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

module.exports = { decide, configured, MODEL };
