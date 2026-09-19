/**
 * SMS (Twilio) transport — reaching a phone with no app on it.
 *
 * Third sibling to fcm.js and webpush.js, same `send()` contract and the same
 * failure vocabulary, so push/index.js does not learn a third shape.
 *
 * ## Why SMS is different from the other two, and treated the same anyway
 *
 * A push notification is free, silent if the person wants it to be, and dies
 * with the app. A text message costs money, survives a factory reset, sits in
 * the same thread as messages from their family, and — the part that actually
 * matters — is regulated. Someone who replies STOP has withdrawn consent in a
 * way that carries legal weight, not merely a preference.
 *
 * That is why 21610 is in DEAD, and why it is the one error here that must
 * never be retried or "repaired" by re-registering: a STOP that gets quietly
 * undone by the next launch's re-registration is the single worst bug this
 * module could have.
 *
 * ## Credentials
 *
 * Resolved through services/secrets — env locally, Secret Manager in
 * production, re-read when the cache entry expires rather than at deploy:
 *
 *   TWILIO_ACCOUNT_SID    the AC… account. Required in the REST path itself.
 *   TWILIO_SID            an SK… API key, used as the basic-auth username.
 *   TWILIO_CLIENT_SECRET  that key's secret.
 *   TWILIO_FROM_NUMBER    an SMS-capable number on the account, E.164.
 *
 * An API key is deliberately preferred over the account's own auth token: it
 * can be revoked on its own without rotating everything else that uses the
 * account. Passing the account SID as the username also works, so both forms
 * are accepted — if TWILIO_SID is missing, the account SID stands in.
 */

const secrets = require("../secrets");

const SEND_TIMEOUT_MS = 10_000;

/**
 * Twilio's own vocabulary for "stop using this number".
 *
 * 21610 is the important one: the person replied STOP. The rest are numbers
 * that will never deliver. Everything else — a 429, a 500, a network blip —
 * is transient, and clearing a registration on one of those would silently
 * unsubscribe someone from messages they asked for.
 */
const DEAD = new Set([
	21610, // recipient has unsubscribed (STOP)
	21211, // invalid 'To' number
	21614, // 'To' is not a mobile number
	21612, // cannot route to this number
	21408, // no permission to send to this region
]);

let cached = null;

function reset() {
	cached = null;
}

async function config() {
	const [account, key, secret, from] = await Promise.all([
		secrets.getSecret("TWILIO_ACCOUNT_SID"),
		secrets.getSecret("TWILIO_SID"),
		secrets.getSecret("TWILIO_CLIENT_SECRET"),
		secrets.getSecret("TWILIO_FROM_NUMBER"),
	]);
	if (!account || !secret || !from) return null;
	if (!cached || cached.account !== account || cached.from !== from) {
		cached = { account, key: key || account, secret, from };
	}
	return cached;
}

/** True when SMS could send right now. Used to keep the UI honest. */
async function isConfigured() {
	try {
		return (await config()) !== null;
	} catch {
		return false;
	}
}

/**
 * E.164, or null.
 *
 * Strict on the way in because a malformed number is not a send that fails
 * once — Twilio bills for the attempt, and a typo'd number may belong to a
 * real stranger who then receives somebody else's private reminders.
 */
function normalizeNumber(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	// A bare 10-digit US number is what a person actually types.
	const digits = trimmed.replace(/[^\d+]/g, "");
	const e164 = /^\+/.test(digits)
		? digits
		: digits.length === 10
			? `+1${digits}`
			: digits.length === 11 && digits.startsWith("1")
				? `+${digits}`
				: null;
	if (!e164 || !/^\+[1-9]\d{6,14}$/.test(e164)) return null;
	return e164;
}

/**
 * Send one message to one number.
 *
 * Returns { ok: true } or { ok: false, dead, reason }. It does NOT throw for
 * an ordinary refusal: one unreachable number must not fail the pass that was
 * trying to reach five other places.
 */
async function send(token, { title, body } = {}) {
	const to = normalizeNumber(token);
	if (!to) return { ok: false, dead: true, reason: "MALFORMED_NUMBER" };

	let cfg;
	try {
		cfg = await config();
	} catch (err) {
		return { ok: false, dead: false, reason: `credentials: ${err.message}` };
	}
	if (!cfg) return { ok: false, dead: false, reason: "not_configured" };

	// No title line. On a push the title is a separate visual field; in a text
	// thread it would just be the word "Athena" above every message she has
	// ever sent, in a conversation that is already unmistakably from her.
	const text = String(body || title || "").slice(0, 1500);
	if (!text) return { ok: false, dead: false, reason: "empty" };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
	try {
		const response = await fetch(
			`https://api.twilio.com/2010-04-01/Accounts/${cfg.account}/Messages.json`,
			{
				method: "POST",
				headers: {
					Authorization:
						"Basic " + Buffer.from(`${cfg.key}:${cfg.secret}`).toString("base64"),
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({ To: to, From: cfg.from, Body: text }).toString(),
				signal: controller.signal,
			}
		);
		if (response.ok) return { ok: true };

		const payload = await response.json().catch(() => null);
		const code = Number(payload?.code);
		return {
			ok: false,
			dead: DEAD.has(code),
			reason: code ? `TWILIO_${code}` : `HTTP_${response.status}`,
		};
	} catch (err) {
		return {
			ok: false,
			dead: false,
			reason: err.name === "AbortError" ? "timeout" : err.message,
		};
	} finally {
		clearTimeout(timer);
	}
}

module.exports = { send, isConfigured, normalizeNumber, reset, DEAD };
