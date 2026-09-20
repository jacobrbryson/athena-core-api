/**
 * Inbound SMS: replying to Athena by text and having it be a conversation.
 *
 * Outbound alone would make her a notification robot with a phone number. The
 * point of two-way is that "what time again?" works from a car, from a lock
 * screen, from a phone with no app installed — and lands in the SAME session
 * as everything else, so she is not keeping a second, dumber memory of you.
 *
 * ## The signature is the whole security model
 *
 * This endpoint cannot be authenticated the way every other route is. There is
 * no session, no device token, and the only identifying thing in the request
 * body is a `From` number — which is a string anybody can type into a POST.
 * Without verification, this URL would be "text as Ross, read his calendar,
 * read his memories" for anyone who found it.
 *
 * So the X-Twilio-Signature check is not defence in depth here; it is the
 * entire door. It is validated BEFORE the number is looked up, before a
 * session is touched, and before a single model token is spent. If the auth
 * token is not configured the request is refused rather than trusted, because
 * an unverifiable webhook is strictly worse than a missing one.
 *
 * ## Silence is the right answer to a stranger
 *
 * An unrecognised number gets 204 and nothing else. Replying "you are not
 * registered" would confirm to anyone texting the number at random that they
 * had found a live system, and would let somebody enumerate which numbers
 * belong to an account by watching which ones get an answer.
 */

const crypto = require("node:crypto");
const secrets = require("../services/secrets");
const push = require("../services/push");
const sms = require("../services/push/sms");
const sessionService = require("../services/session");
const messageService = require("../services/message");
const { processAiResponse } = require("./gemini");

/** Twilio's own STOP/HELP keywords. The carrier handles these; we must not. */
const CARRIER_KEYWORDS = new Set([
	"stop", "stopall", "unsubscribe", "cancel", "end", "quit",
	"start", "yes", "unstop", "help", "info",
]);

/**
 * Twilio's request signature: HMAC-SHA1 over the full URL with every POST
 * parameter appended in sorted order, keyed by the ACCOUNT AUTH TOKEN — not
 * the API key secret, which signs nothing.
 */
function validateSignature(authToken, url, params, signature) {
	if (!authToken || !signature) return false;
	const payload = Object.keys(params || {})
		.sort()
		.reduce((acc, key) => acc + key + params[key], url);
	const expected = crypto
		.createHmac("sha1", authToken)
		.update(Buffer.from(payload, "utf-8"))
		.digest("base64");
	const a = Buffer.from(expected);
	const b = Buffer.from(String(signature));
	// Length check first: timingSafeEqual throws on a mismatch rather than
	// returning false, and a thrown comparison would read as a server error
	// instead of a refusal.
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The URL Twilio signed, which is the one it was configured with — not
 * necessarily the one this process sees. Behind Cloud Run and the proxy the
 * request arrives as http on an internal host, and signing that would never
 * match. `TWILIO_WEBHOOK_URL` is the authority when set.
 */
async function signedUrl(req) {
	const configured = await secrets.getSecret("TWILIO_WEBHOOK_URL").catch(() => null);
	if (configured) return configured;
	const host = req.get("x-forwarded-host") || req.get("host");
	return `https://${host}${req.originalUrl}`;
}

/** An empty TwiML document: "received, nothing to say back right now." */
function noReply(res) {
	res.set("Content-Type", "text/xml");
	return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
}

/**
 * POST /sms/inbound — a text arrived.
 *
 * Answers Twilio immediately and does the thinking afterwards. A model call
 * can take many seconds; Twilio times the webhook out at 15 and would retry,
 * which would mean the same message answered twice. So the reply goes out as
 * a fresh outbound message rather than in the TwiML response.
 */
async function inbound(req, res) {
	const authToken = await secrets.getSecret("TWILIO_AUTH_TOKEN").catch(() => null);
	if (!authToken) {
		// Refuse rather than trust. An unverifiable webhook is worse than none.
		console.error("[sms] TWILIO_AUTH_TOKEN is not configured; refusing inbound webhook");
		return res.status(503).send("Not configured");
	}

	const valid = validateSignature(
		authToken,
		await signedUrl(req),
		req.body,
		req.get("x-twilio-signature")
	);
	if (!valid) {
		console.warn("[sms] rejected an inbound message with a bad signature");
		return res.status(403).send("Bad signature");
	}

	const from = sms.normalizeNumber(req.body?.From);
	const text = typeof req.body?.Body === "string" ? req.body.Body.trim() : "";
	if (!from || !text) return noReply(res);

	// The carrier already actioned these and will have replied itself. Twilio
	// also stops delivering to a number that sent STOP, so the registration is
	// cleared here to keep our side honest rather than discovering it later.
	if (CARRIER_KEYWORDS.has(text.toLowerCase())) {
		const owner = await push.profileForNumber(from).catch(() => null);
		if (owner && ["stop", "stopall", "unsubscribe", "cancel", "end", "quit"].includes(text.toLowerCase())) {
			await push.forgetPhone(owner.profileId).catch(() => undefined);
		}
		return noReply(res);
	}

	const owner = await push.profileForNumber(from).catch(() => null);
	// Deliberately indistinguishable from a number that is registered but had
	// nothing to say. See the header.
	if (!owner) return noReply(res);

	// Answer the webhook now; think afterwards. Deliberately NOT awaited: the
	// response has already gone, and keeping the handler's promise pending
	// buys nothing except a request that looks stuck.
	//
	// DEPLOYMENT NOTE: this continues working after the response, so the
	// service needs CPU outside the request — Cloud Run must run with CPU
	// always allocated (or startup boost) for this path. With the default
	// throttling the instance can be frozen mid-thought and the reply simply
	// never arrives, with nothing in the logs to say why.
	noReply(res);

	answer(owner.profileId, from, text).catch((err) =>
		console.error("[sms] could not answer an inbound message:", err.message)
	);
}

/**
 * Put the text into this person's conversation, let Athena answer it, and send
 * her answer back as a message.
 *
 * The session is the ordinary one, not an SMS-shaped side channel: a reply
 * that did not land in the same thread would give her a second, thinner memory
 * of the same person, and "what did we decide?" would depend on which device
 * they happened to have asked from.
 */
async function answer(profileId, number, text) {
	const session = await sessionService.getOrCreateForProfile(profileId);
	await messageService.addMessage(session.id, true, text, null, profileId);

	// An empty client map: nobody is watching a socket for a text message. The
	// broadcasts inside become no-ops and the reply is read back from the
	// transcript instead.
	await processAiResponse(session, text, new Map(), {});

	const recent = await messageService.getMessages(session.id, profileId);
	const reply = [...recent].reverse().find((m) => !m.is_human);
	if (!reply?.text) return;

	// Answered on the channel they used, not fanned out to every device they
	// own. Someone who texts a question expects a text back — and routing this
	// through sendToProfile would also gate it on `push_enabled`, which is
	// consent for Athena to start a conversation, not permission to answer one
	// they just started themselves.
	const sent = await sms.send(number, { body: reply.text });
	if (!sent.ok) console.warn(`[sms] could not deliver a reply: ${sent.reason}`);
}

module.exports = { inbound, validateSignature, _answer: answer };
