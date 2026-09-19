/**
 * Web Push (RFC 8030 / VAPID) transport — the browser half of push.
 *
 * Sibling to fcm.js, which is what the transport split in index.js was for:
 * that file decides who to reach and what to say, this decides how the bytes
 * reach a browser. Same `send()` contract, same failure vocabulary.
 *
 * ## Why not FCM's own web support
 *
 * It would have reused the credential that already works for Android. It also
 * needs a "Web Push certificate" minted in the Firebase console, which has no
 * public API — so the one thing standing between a fresh checkout and working
 * browser notifications would be a manual click nobody can script or audit.
 * VAPID keys are a keypair anyone can generate, and the standard is what
 * Chrome, Firefox, Edge and Safari implement natively. No SDK reaches the
 * browser bundle either: `navigator.serviceWorker` and `PushManager` are
 * platform APIs.
 *
 * ## Credentials
 *
 * A `VAPID_KEYS` secret resolved through services/secrets — env locally,
 * Secret Manager in production, re-read when the cache entry expires rather
 * than at the next deploy:
 *
 *   { "publicKey": "B...", "privateKey": "...", "subject": "https://..." }
 *
 * `subject` identifies the sender to the push service if it needs to get in
 * touch about traffic from this server. It is an https URL rather than the
 * usual mailto: deliberately — the subject is transmitted to Google, Mozilla
 * and Apple on every single send, and a person's email address does not need
 * to be.
 *
 * The public key is not a secret (the browser must have it to subscribe) but
 * it lives in the same blob so the pair can never drift apart: a public key
 * that does not match the private one produces subscriptions that are
 * accepted at subscribe time and rejected forever after, which is the most
 * confusing failure this feature has.
 */

const webpush = require("web-push");
const secrets = require("../secrets");

/** How long a push service should hold a nudge for a browser that is offline. */
const TTL_SECONDS = 6 * 60 * 60;

let cached = null;

function reset() {
	cached = null;
}

/** The VAPID keypair, or null when web push is simply not configured. */
async function keys() {
	const json = await secrets.getSecretJson("VAPID_KEYS");
	if (!json || !json.publicKey || !json.privateKey) return null;
	// A rotated secret replaces the pair; rebuild rather than keep signing
	// with the retired one.
	if (!cached || cached.publicKey !== json.publicKey) {
		cached = {
			publicKey: json.publicKey,
			privateKey: json.privateKey,
			subject: json.subject || "https://athena.orcwood.com",
		};
	}
	return cached;
}

/** True when web push could send right now. Used to keep the UI honest. */
async function isConfigured() {
	try {
		return (await keys()) !== null;
	} catch {
		return false;
	}
}

/**
 * The browser's public key, for the client's `pushManager.subscribe()`.
 *
 * Handed out over an authenticated endpoint rather than baked into the built
 * bundle: rotating the pair then takes effect on the next page load instead
 * of the next deploy of the web app.
 */
async function publicKey() {
	const pair = await keys().catch(() => null);
	return pair?.publicKey || null;
}

/**
 * A stored registration is the whole PushSubscription, as JSON.
 *
 * Unlike an FCM token a subscription is three values — where to POST, and the
 * two keys the payload is encrypted to — so the "token" column holds the JSON
 * object. Parsing is strict: a half-formed subscription that reached the
 * database is a send that fails forever, and it should be refused on the way
 * in instead.
 */
function parseSubscription(token) {
	let parsed;
	try {
		parsed = typeof token === "string" ? JSON.parse(token) : token;
	} catch {
		return null;
	}
	if (!parsed || typeof parsed.endpoint !== "string") return null;
	if (!/^https:\/\//.test(parsed.endpoint)) return null;
	const { p256dh, auth } = parsed.keys || {};
	if (typeof p256dh !== "string" || typeof auth !== "string") return null;
	return { endpoint: parsed.endpoint, keys: { p256dh, auth } };
}

/**
 * A collapse key the push services will actually accept as a Topic.
 *
 * RFC 8030 limits it to 32 characters from the URL-safe base64 alphabet, and
 * an over-long or malformed one is a 400 for the whole send. Callers name
 * their keys for readability (`nudge-<uuid>` is 42 characters), so truncation
 * happens here rather than constraining every caller to a transport detail
 * they should not have to know.
 *
 * Truncating the END of a uuid-bearing key is safe: the first 26 characters
 * of a random uuid are still far beyond collision range for one person's
 * unread notifications.
 */
function topicFor(collapseKey) {
	if (typeof collapseKey !== "string" || !collapseKey) return null;
	const safe = collapseKey.replace(/[^A-Za-z0-9\-_]/g, "-").slice(0, 32);
	return safe || null;
}

/**
 * Send one notification to one browser.
 *
 * Returns { ok: true } or { ok: false, dead, reason }. It does NOT throw for
 * an ordinary refusal: a closed browser must not be able to fail the pass
 * that was trying to reach five other people.
 */
async function send(token, { title, body, data = {}, collapseKey } = {}) {
	const subscription = parseSubscription(token);
	if (!subscription) return { ok: false, dead: true, reason: "MALFORMED_SUBSCRIPTION" };

	let pair;
	try {
		pair = await keys();
	} catch (err) {
		return { ok: false, dead: false, reason: `credentials: ${err.message}` };
	}
	if (!pair) return { ok: false, dead: false, reason: "not_configured" };

	// Unlike FCM there is no server-side `notification` block: the payload is
	// encrypted end to end and only the service worker can read it, so the
	// whole notification travels as the message body.
	const payload = JSON.stringify({ title, body, data });
	const topic = topicFor(collapseKey);

	try {
		await webpush.sendNotification(subscription, payload, {
			TTL: TTL_SECONDS,
			// Collapses a redelivery of the same nudge against itself. Two
			// different nudges carry different keys and stack — see the note in
			// push/index.js deliverNudge about why that changed.
			...(topic ? { topic } : {}),
			vapidDetails: {
				subject: pair.subject,
				publicKey: pair.publicKey,
				privateKey: pair.privateKey,
			},
		});
		return { ok: true };
	} catch (err) {
		const status = err?.statusCode;
		return {
			ok: false,
			// 404 and 410 are the push services' own "this subscription is
			// gone" — the tab's storage was cleared, or notifications were
			// revoked for the site. Nothing else costs a registration: a 403
			// means the VAPID pair does not match, and clearing every
			// subscription over a key mistake would silently unsubscribe
			// everyone from notifications they asked for.
			dead: status === 404 || status === 410,
			reason: status ? `HTTP_${status}` : err?.message || "unknown",
		};
	}
}

module.exports = { send, isConfigured, publicKey, parseSubscription, topicFor, reset, TTL_SECONDS };
