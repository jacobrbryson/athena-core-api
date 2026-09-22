/**
 * Firebase Cloud Messaging (HTTP v1) transport.
 *
 * The only part of push that knows about Google. `index.js` decides who to
 * reach and what to say; this decides how the bytes get there, so adding APNs
 * or Web Push later is a sibling file rather than a rewrite.
 *
 * ## Credentials
 *
 * A service-account JSON in the `FCM_SERVICE_ACCOUNT` secret, resolved through
 * services/secrets — so it comes from the env locally and from Secret Manager
 * in production, and a rotated version is picked up when the cache entry
 * expires rather than at the next deploy. No key material in the image.
 *
 * The account needs one role: `roles/firebasemessaging.admin` (or just the
 * `cloudmessaging.messages.create` permission) on the Firebase project.
 *
 * ## Why not firebase-admin
 *
 * The whole job is "mint an OAuth token, POST some JSON". `google-auth-library`
 * is already a dependency and does the first half; the second half is a fetch.
 * Pulling in firebase-admin would add a large dependency tree to the API image
 * for one endpoint.
 */

const { JWT } = require("google-auth-library");
const secrets = require("../secrets");

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const SEND_TIMEOUT_MS = 10_000;

/** Cached JWT client. Reused so tokens are minted once an hour, not per send. */
let clientPromise = null;
let clientForProject = null;

/**
 * FCM's own vocabulary for "this registration is dead — stop using it".
 *
 * These are the only errors that should cost a device its token. Everything
 * else (a quota, a 503, a network blip) is transient, and clearing a
 * registration on one of those would silently unsubscribe someone from
 * notifications they asked for, with no way for them to tell.
 */
const DEAD_REGISTRATION = new Set([
	"UNREGISTERED",
	"INVALID_ARGUMENT",
	"SENDER_ID_MISMATCH",
	"NOT_FOUND",
]);

function reset() {
	clientPromise = null;
	clientForProject = null;
}

/** The service account, or null when push is simply not configured. */
async function serviceAccount() {
	const json = await secrets.getSecretJson("FCM_SERVICE_ACCOUNT");
	if (!json || !json.client_email || !json.private_key || !json.project_id) {
		return null;
	}
	return json;
}

/** True when FCM could send right now. Used to keep the UI honest. */
async function isConfigured() {
	try {
		return (await serviceAccount()) !== null;
	} catch {
		return false;
	}
}

async function authorized() {
	const account = await serviceAccount();
	if (!account) return null;
	// A rotated secret changes the client_email/key pair; rebuild rather than
	// keep signing with the retired one.
	if (clientPromise && clientForProject === account.project_id) {
		return { client: await clientPromise, projectId: account.project_id };
	}
	clientForProject = account.project_id;
	clientPromise = Promise.resolve(
		new JWT({
			email: account.client_email,
			key: account.private_key,
			scopes: [SCOPE],
		})
	);
	return { client: await clientPromise, projectId: account.project_id };
}

/**
 * Send one notification to one registration token.
 *
 * Returns { ok: true } or { ok: false, dead, reason }. It does NOT throw for
 * an ordinary refusal: a dead handset must not be able to fail the pass that
 * was trying to reach five other people.
 */
async function send(token, { title, body, data = {}, collapseKey } = {}) {
	let auth;
	try {
		auth = await authorized();
	} catch (err) {
		return { ok: false, dead: false, reason: `credentials: ${err.message}` };
	}
	if (!auth) return { ok: false, dead: false, reason: "not_configured" };

	const message = {
		message: {
			token,
			notification: { title, body },
			// Every value must be a string: FCM rejects the whole message
			// otherwise, and a nudge uuid arriving as a number is the obvious
			// way to trip that.
			data: Object.fromEntries(
				Object.entries(data).map(([k, v]) => [k, String(v)])
			),
			android: {
				// A later nudge replaces an earlier unread one rather than
				// stacking. The interruption budget already decided the person
				// should hear from her at most this often; a pile of
				// notifications would quietly undo that.
				collapseKey: collapseKey || "athena",
				priority: "high",
				notification: { tag: collapseKey || "athena" },
			},
		},
	};

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
	try {
		// google-auth-library 10 returns a WHATWG Headers object, and spreading
		// one yields {} — which silently dropped the Authorization header and
		// made every Android push fail UNAUTHENTICATED while the browser (VAPID,
		// no Google auth) kept working. `new Headers(...)` accepts either shape.
		const headers = new Headers(await auth.client.getRequestHeaders());
		headers.set("Content-Type", "application/json");
		const response = await fetch(
			`https://fcm.googleapis.com/v1/projects/${auth.projectId}/messages:send`,
			{
				method: "POST",
				headers,
				body: JSON.stringify(message),
				signal: controller.signal,
			}
		);
		if (response.ok) return { ok: true };

		const text = await response.text().catch(() => "");
		let parsed = null;
		try {
			parsed = JSON.parse(text);
		} catch {
			/* a non-JSON body is still a failure, just a less specific one */
		}
		// FCM puts the useful code in an ErrorInfo detail, not in `status`.
		const detail = (parsed?.error?.details || []).find((d) =>
			String(d["@type"] || "").includes("FcmError")
		);
		const code = detail?.errorCode || parsed?.error?.status || `HTTP_${response.status}`;
		return {
			ok: false,
			// 404 is FCM's own "no such registration"; the codes cover the rest.
			dead: DEAD_REGISTRATION.has(code) || response.status === 404,
			reason: code,
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

module.exports = { send, isConfigured, reset, DEAD_REGISTRATION };
