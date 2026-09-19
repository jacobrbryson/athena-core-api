/**
 * Push: reaching a paired phone when Athena is not already on screen.
 *
 * Initiative (services/initiative) could only speak where the person could
 * already see her — the companion polls, so a nudge waited until someone
 * opened the app and expired if it went stale. This is the piece that makes
 * "your 2pm is in fifteen minutes" arrive while it still means something.
 *
 * ## What this module is NOT
 *
 * It is not a second interruption budget. Everything that decides *whether* a
 * person should be disturbed already happened upstream: opt-in, quiet hours,
 * the daily cap, spacing, cooldowns, dedupe. By the time a nudge reaches
 * `deliverNudge` the decision is made, and this only chooses transport.
 *
 * Putting a second set of rules here would mean two places to look when
 * someone asks why they were or weren't told something, and they would drift.
 * The one thing push adds is its own consent — see `push_enabled` — because
 * agreeing that Athena may start a conversation in an app you have open is
 * not the same as agreeing she may light up your phone.
 *
 * ## Failure posture
 *
 * Nothing here can fail a caller. A nudge that was written and could not be
 * pushed is still a nudge: the person sees it next time they open the app,
 * exactly as before push existed. So every function swallows its errors and
 * reports rather than throws.
 */

const nodeCrypto = require("node:crypto");
const { randomUUID } = nodeCrypto;
const pool = require("../../helpers/db");
const crypto = require("../../helpers/crypto");
const fcm = require("./fcm");
const webpush = require("./webpush");
const sms = require("./sms");

/** Providers we can actually deliver to. A device may only register these. */
const PROVIDERS = new Set(["fcm", "webpush", "twilio"]);

/** Platforms with a real push story. */
const PUSHABLE_PLATFORMS = new Set(["android", "car", "web", "sms"]);

const TRANSPORTS = { fcm, webpush, twilio: sms };

/**
 * The provider a platform is allowed to register.
 *
 * Pinned rather than trusted from the request: a browser claiming `fcm` would
 * store a subscription the FCM transport cannot parse, and the failure would
 * not surface until the first nudge went nowhere.
 */
const PROVIDER_FOR_PLATFORM = {
	android: "fcm",
	car: "fcm",
	web: "webpush",
	// "sms" is a platform in the sense that matters here — somewhere she can
	// reach you — even though nothing about it is a device.
	sms: "twilio",
};

function failure(message, status, code) {
	return Object.assign(new Error(message), { status, code });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * A device tells us where to reach it. Called by the device itself, with its
 * own device token — never by the Companion app on a device's behalf, because
 * only the handset knows its own registration and only it can tell when that
 * registration has been replaced.
 *
 * Re-registering is the normal case, not an error: FCM rotates a registration
 * whenever the app is restored to a new phone, a browser replaces a
 * subscription whenever its service worker is updated, and the client is
 * expected to send the current one on every launch.
 *
 * `platform` comes from the authenticated device row, never the request, and
 * decides the provider — see PROVIDER_FOR_PLATFORM.
 */
async function registerToken(deviceId, token, { provider = "fcm", platform = null } = {}) {
	const resolved = PROVIDER_FOR_PLATFORM[platform] || provider;
	if (!PROVIDERS.has(resolved)) {
		throw failure("Unsupported push provider", 400, "bad_provider");
	}
	if (typeof token !== "string" || token.length < 20 || token.length > 4096) {
		throw failure("That does not look like a push token", 400, "bad_token");
	}
	// A web subscription is three values, and a malformed one is a send that
	// fails forever. Refuse it on the way in rather than storing it and
	// discovering the problem the first time she has something to say.
	if (resolved === "webpush" && !webpush.parseSubscription(token)) {
		throw failure("That does not look like a push subscription", 400, "bad_token");
	}
	const encrypted = await crypto.encrypt(token);
	await pool.query(
		`UPDATE paired_device
		 SET push_provider = ?, push_token_enc = ?, push_registered_at = NOW(),
		     push_failures = 0, push_failed_at = NULL
		 WHERE id = ? AND revoked_at IS NULL`,
		[resolved, encrypted, deviceId]
	);
	return { provider: resolved, registered: true };
}

/**
 * A browser registers itself, authenticated by its session rather than by a
 * device token.
 *
 * ## Why this is not the ordinary pairing flow
 *
 * A phone pairs by redeeming a short-lived code for a long-lived device token
 * and putting that token in Android Keystore. A browser has nowhere
 * comparable to put one: `localStorage` and IndexedDB are readable by any
 * script that ends up on the page, so pairing a browser the way a phone pairs
 * would trade an httpOnly session cookie for a long-lived bearer token sitting
 * in reach of the first XSS. That is a strictly worse position than the one
 * the page is already in.
 *
 * So the browser never holds a credential for this. It presents the session it
 * already has, and the server owns the row.
 *
 * `browserId` is an opaque identifier the client keeps so that a second visit
 * updates its own row instead of accumulating one per page load. It is NOT a
 * credential: everything is scoped to the profile the session proved, so the
 * worst a guessed id can do is overwrite the guesser's own subscription.
 *
 * `token_hash` is set to a value no token hashes to. The column means "this
 * row finished pairing", which is true, and `reachableDevices` filters on it;
 * leaving it NULL would make the row silently unpushable. Nothing can present
 * a token for it, because no token was ever issued — that is the point.
 */
async function registerBrowser(profileId, { subscription, browserId, name } = {}) {
	if (!profileId) throw failure("Unknown profile", 400, "no_profile");
	const raw = typeof subscription === "string" ? subscription : JSON.stringify(subscription || {});
	if (!webpush.parseSubscription(raw)) {
		throw failure("That does not look like a push subscription", 400, "bad_token");
	}
	const id =
		typeof browserId === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(browserId)
			? browserId
			: randomUUID();
	const label = (typeof name === "string" && name.trim() ? name.trim() : "This browser").slice(0, 80);
	const encrypted = await crypto.encrypt(raw);

	// Deterministic from the profile and the browser's own id, so the same
	// browser updates its row rather than collecting a new one every visit.
	const uuid = deterministicUuid(`web:${profileId}:${id}`);

	await pool.query(
		`INSERT INTO paired_device
			(uuid, profile_id, name, platform, token_hash, push_provider, push_token_enc,
			 push_registered_at, push_failures, last_seen_at)
		 VALUES (?, ?, ?, 'web', ?, 'webpush', ?, NOW(), 0, NOW())
		 ON DUPLICATE KEY UPDATE
			name = VALUES(name), push_provider = 'webpush',
			push_token_enc = VALUES(push_token_enc), push_registered_at = NOW(),
			push_failures = 0, push_failed_at = NULL, revoked_at = NULL,
			last_seen_at = NOW()`,
		[uuid, profileId, label, unissuedTokenHash(), encrypted]
	);
	return { browserId: id, device_uuid: uuid, provider: "webpush", registered: true };
}

/**
 * A phone number asks to be reachable — but not until it proves it is yours.
 *
 * ## Why this one is verified and the others are not
 *
 * An FCM token and a Web Push subscription are minted BY the device, so
 * holding one is already proof you are that device. A phone number is just a
 * string someone typed. Without a round trip anybody could register a
 * stranger's number and have Athena text them somebody else's calendar,
 * recovery score and reminders — a privacy failure, and for SMS specifically
 * an unsolicited-messaging one.
 *
 * So registration is two steps. This one writes a row that is deliberately
 * NOT reachable (`token_hash` NULL, exactly as `reachableDevices` requires)
 * and texts a code to the number. Only `confirmPhone` makes it live.
 *
 * Re-registering an unconfirmed number replaces the pending code rather than
 * erroring: someone who did not get the first text will press the button
 * again, and that is the expected path, not a fault.
 */
async function registerPhone(profileId, phone) {
	if (!profileId) throw failure("Unknown profile", 400, "no_profile");
	const number = sms.normalizeNumber(phone);
	if (!number) throw failure("That does not look like a phone number", 400, "bad_number");
	if (!(await sms.isConfigured())) {
		throw failure("Text messages are not set up on this server", 503, "not_configured");
	}

	// Six digits. Short enough to retype from a lock screen, and the row it
	// guards cannot be reached at all until it is redeemed.
	const code = String(nodeCrypto.randomInt(0, 1_000_000)).padStart(6, "0");
	const uuid = deterministicUuid(`sms:${profileId}:${number}`);
	const encrypted = await crypto.encrypt(number);

	await pool.query(
		`INSERT INTO paired_device
			(uuid, profile_id, name, platform, token_hash, pairing_code_hash,
			 pairing_expires_at, push_provider, push_token_enc, push_failures)
		 VALUES (?, ?, ?, 'sms', NULL, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), 'twilio', ?, 0)
		 ON DUPLICATE KEY UPDATE
			pairing_code_hash = VALUES(pairing_code_hash),
			pairing_expires_at = VALUES(pairing_expires_at),
			push_token_enc = VALUES(push_token_enc),
			revoked_at = NULL`,
		[uuid, profileId, maskNumber(number), hashCode(code), encrypted]
	);

	// Sent directly rather than through sendToProfile: this is not a nudge and
	// must not be gated on push_enabled — it is the step that lets somebody
	// turn push_enabled on in the first place.
	const result = await sms.send(number, {
		body: `${code} is your Athena verification code. If you didn't ask for this, ignore it.`,
	});
	if (!result.ok) {
		// Do not leave a pending row behind for a number that cannot receive.
		await pool
			.query("DELETE FROM paired_device WHERE uuid = ? AND token_hash IS NULL", [uuid])
			.catch(() => undefined);
		throw failure("That number could not be texted", 400, result.reason);
	}
	return { device_uuid: uuid, number: maskNumber(number), sent: true };
}

/**
 * The code came back. Make the number live.
 *
 * Guarded on `token_hash IS NULL` so a replayed code cannot re-activate a
 * number that was revoked since, and on the expiry so an old code sitting in
 * somebody's message history is worth nothing.
 */
async function confirmPhone(profileId, phone, code) {
	const number = sms.normalizeNumber(phone);
	if (!number) throw failure("That does not look like a phone number", 400, "bad_number");
	if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
		throw failure("That code doesn't look right", 400, "bad_code");
	}
	const uuid = deterministicUuid(`sms:${profileId}:${number}`);
	const [result] = await pool.query(
		`UPDATE paired_device
		 SET token_hash = ?, pairing_code_hash = NULL, pairing_expires_at = NULL,
		     push_registered_at = NOW(), last_seen_at = NOW()
		 WHERE uuid = ? AND profile_id = ? AND platform = 'sms'
		   AND token_hash IS NULL AND pairing_code_hash = ?
		   AND pairing_expires_at > NOW()`,
		[unissuedTokenHash(), uuid, profileId, hashCode(code.trim())]
	);
	if (!result.affectedRows) {
		throw failure("That code has expired or doesn't match", 400, "bad_code");
	}
	return { device_uuid: uuid, number: maskNumber(number), confirmed: true };
}

/** Stop texting this person. Revokes every number on their profile. */
async function forgetPhone(profileId) {
	if (!profileId) return { registered: false };
	await pool.query(
		`UPDATE paired_device
		 SET push_provider = NULL, push_token_enc = NULL, push_registered_at = NULL,
		     push_failures = 0, push_failed_at = NULL, revoked_at = NOW()
		 WHERE profile_id = ? AND platform = 'sms' AND revoked_at IS NULL`,
		[profileId]
	);
	return { registered: false };
}

/**
 * Which profile owns this number, for an inbound text.
 *
 * The number is encrypted at rest with the rotating keyring, so there is no
 * column to index — every live SMS row is opened and compared. That is the
 * right trade at this scale: a searchable plaintext table of everyone's phone
 * numbers is exactly the thing worth not having.
 */
async function profileForNumber(phone) {
	const number = sms.normalizeNumber(phone);
	if (!number) return null;
	const [rows] = await pool.query(
		`SELECT id, profile_id, push_token_enc FROM paired_device
		 WHERE platform = 'sms' AND revoked_at IS NULL AND token_hash IS NOT NULL
		   AND push_token_enc IS NOT NULL`
	);
	for (const row of rows) {
		try {
			if ((await crypto.decrypt(row.push_token_enc)) === number) {
				return { deviceId: row.id, profileId: Number(row.profile_id) };
			}
		} catch {
			// A registration we cannot open is one we cannot match on.
		}
	}
	return null;
}

/** Never show a full number where the last four will do. */
function maskNumber(number) {
	return `••• ••• ${String(number).slice(-4)}`;
}

function hashCode(code) {
	return nodeCrypto.createHash("sha256").update(String(code)).digest("hex");
}

/** This browser asks to stop being reached. Scoped to the caller's profile. */
async function forgetBrowser(profileId, browserId) {
	if (!profileId || typeof browserId !== "string") return { registered: false };
	const uuid = deterministicUuid(`web:${profileId}:${browserId}`);
	await pool.query(
		`UPDATE paired_device
		 SET push_provider = NULL, push_token_enc = NULL, push_registered_at = NULL,
		     push_failures = 0, push_failed_at = NULL, revoked_at = NOW()
		 WHERE uuid = ? AND profile_id = ? AND platform = 'web'`,
		[uuid, profileId]
	);
	return { registered: false };
}

/** A uuid-shaped, stable identifier. Not a secret — it names a row. */
function deterministicUuid(seed) {
	const h = nodeCrypto.createHash("sha256").update(seed).digest("hex");
	return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join("-");
}

/** 64 hex characters that are not the hash of any issued token. */
function unissuedTokenHash() {
	return nodeCrypto.randomBytes(32).toString("hex");
}

/** A device says "stop reaching me here" — sign-out, or notifications refused. */
async function forgetToken(deviceId) {
	await pool.query(
		`UPDATE paired_device
		 SET push_provider = NULL, push_token_enc = NULL, push_registered_at = NULL,
		     push_failures = 0, push_failed_at = NULL
		 WHERE id = ?`,
		[deviceId]
	);
	return { registered: false };
}

/**
 * Clear a registration the transport told us is dead.
 *
 * Only ever called for the errors in fcm.DEAD_REGISTRATION. A transient
 * failure must not land here: silently unsubscribing someone from
 * notifications they asked for, with nothing in the UI to explain it, is
 * worse than a few failed sends.
 */
async function dropDeadToken(deviceId, reason) {
	console.warn(`[push] dropping dead registration for device ${deviceId}: ${reason}`);
	await pool.query(
		`UPDATE paired_device
		 SET push_provider = NULL, push_token_enc = NULL, push_registered_at = NULL,
		     push_failed_at = NOW()
		 WHERE id = ?`,
		[deviceId]
	);
}

async function recordSoftFailure(deviceId) {
	await pool
		.query(
			`UPDATE paired_device SET push_failures = push_failures + 1, push_failed_at = NOW()
			 WHERE id = ?`,
			[deviceId]
		)
		.catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Live, pushable devices for one profile, with their decrypted registrations. */
async function reachableDevices(profileId) {
	const [rows] = await pool.query(
		`SELECT id, uuid, name, platform, push_provider, push_token_enc
		 FROM paired_device
		 WHERE profile_id = ? AND revoked_at IS NULL AND token_hash IS NOT NULL
		   AND push_token_enc IS NOT NULL AND push_provider IS NOT NULL`,
		[profileId]
	);
	const out = [];
	for (const row of rows) {
		if (!PUSHABLE_PLATFORMS.has(row.platform)) continue;
		// A registration stored against the wrong transport can only fail, and
		// failing it would tick the failure counter and eventually look like a
		// handset problem. Web rows predating the webpush transport are the
		// real case: they carry `fcm` because that was the only provider.
		if (PROVIDER_FOR_PLATFORM[row.platform] !== row.push_provider) {
			console.warn(
				`[push] device ${row.id} is ${row.platform} but registered ${row.push_provider}; skipping`
			);
			continue;
		}
		try {
			out.push({
				id: row.id,
				uuid: row.uuid,
				name: row.name,
				platform: row.platform,
				provider: row.push_provider,
				token: await crypto.decrypt(row.push_token_enc),
			});
		} catch (err) {
			// A registration we cannot open is a registration we cannot use.
			// Usually a key that left the ring; say so rather than failing the
			// whole fan-out over one device.
			console.warn(`[push] unreadable registration on device ${row.id}:`, err.message);
		}
	}
	return out;
}

/**
 * Has this person asked to be reached on their phone at all?
 *
 * Push is gated on its own flag rather than on initiative being enabled: they
 * are different intrusions and deserve different answers.
 */
async function pushEnabledFor(profileId) {
	const [rows] = await pool.query(
		"SELECT push_enabled FROM athena_initiative_pref WHERE profile_id = ? LIMIT 1",
		[profileId]
	);
	return rows[0]?.push_enabled === 1;
}

/**
 * Fan one notification out to every device this person can be reached on.
 *
 * Returns a summary rather than throwing. A phone that has been wiped, a
 * network that is down and a project with no FCM credentials all produce the
 * same shape of answer, because the caller's behaviour is identical in all
 * three: carry on, the in-app path still works.
 */
async function sendToProfile(profileId, { title, body, data, collapseKey } = {}) {
	if (!profileId || !title || !body) return { sent: 0, failed: 0, devices: 0 };
	if (!(await pushEnabledFor(profileId))) return { sent: 0, failed: 0, devices: 0, skipped: "not enabled" };

	const devices = await reachableDevices(profileId);
	if (!devices.length) return { sent: 0, failed: 0, devices: 0, skipped: "no registered device" };

	let sent = 0;
	let failed = 0;
	// Per device, so a caller that has to explain itself to a person — the
	// test path — can say WHICH handset refused and why, instead of "0 of 2".
	// The aggregate counts are what every other caller reads.
	const results = [];
	for (const device of devices) {
		const transport = TRANSPORTS[device.provider];
		if (!transport) {
			results.push({ uuid: device.uuid, name: device.name, ok: false, reason: "no transport" });
			continue;
		}
		const result = await transport.send(device.token, { title, body, data, collapseKey });
		results.push({
			uuid: device.uuid,
			name: device.name,
			platform: device.platform,
			ok: result.ok === true,
			reason: result.ok ? null : result.reason,
		});
		if (result.ok) {
			sent += 1;
			continue;
		}
		failed += 1;
		if (result.dead) await dropDeadToken(device.id, result.reason);
		else await recordSoftFailure(device.id);
	}
	return { sent, failed, devices: devices.length, results };
}

/**
 * Push one nudge, and record that we tried.
 *
 * `pushed_at` is set when a transport ACCEPTED the message, which is not the
 * same as the person having seen it — FCM accepting is the last thing we can
 * observe. It stays separate from `delivered_at` (a client fetched it) so the
 * nightly review can still tell a nudge that reached somebody from one that
 * went nowhere.
 *
 * The notification body is the nudge's own text, unchanged. Writing a shorter
 * "You have a new message from Athena" would be the standard thing to do and
 * would be worse: the whole value is that a glance at the lock screen is
 * enough, and a teaser forces the person to open the app to learn whether it
 * mattered.
 *
 * ## Why these no longer collapse
 *
 * Every nudge used to share one collapse key, so a second notification
 * REPLACED the first on the lock screen. That was safe only because the
 * interruption budget guaranteed at most one every ninety minutes — the
 * collapse could not actually hide anything, because there was never a second
 * one to hide.
 *
 * With the budget gone (see services/initiative), she can legitimately raise
 * two things at once, and a shared key would quietly drop the first — putting
 * back exactly the invisible loss that removing the budget was meant to end,
 * in the one place nobody would think to look. So each nudge collapses only
 * against itself: a retry of the SAME nudge still replaces it, and two
 * different nudges now stack.
 */
async function deliverNudge(profileId, nudge) {
	if (!nudge?.uuid || !nudge?.text) return { sent: 0 };
	let result;
	try {
		result = await sendToProfile(profileId, {
			title: "Athena",
			body: nudge.text,
			data: { kind: "nudge", uuid: nudge.uuid, trigger: nudge.trigger_id || "" },
			// Per nudge, not per app: a redelivery of this one replaces it, two
			// different ones stack. See the note above.
			collapseKey: `nudge-${nudge.uuid}`,
		});
	} catch (err) {
		console.warn("[push] nudge delivery failed:", err.message);
		return { sent: 0, failed: 1 };
	}
	if (result.sent > 0) {
		await pool
			.query("UPDATE athena_nudge SET pushed_at = NOW() WHERE uuid = ?", [nudge.uuid])
			.catch(() => undefined);
	}
	return result;
}

/**
 * A notification the person asked for, to prove the path works.
 *
 * ## Why this does not go through the interruption budget
 *
 * Every other push exists because Athena decided to speak, and the budget is
 * what makes that decision expensive. This one exists because a person pressed
 * a button asking to be notified. Spacing, the daily cap and quiet hours all
 * protect someone from being disturbed by a machine's judgement; none of them
 * are protection from a thing you just asked for, and applying them here would
 * mean the only honest answer to "is this working?" is "come back in ninety
 * minutes".
 *
 * ## Why it writes no nudge row
 *
 * A test is not an interruption, and counting it as one would corrupt the two
 * things nudge rows exist for: the daily cap would spend a real interruption
 * on a diagnostic, and the nightly review would score a trigger against a
 * delivery nobody was meant to react to.
 *
 * `push_enabled` is still honoured. A test that quietly bypassed the person's
 * own switch would prove the server works while telling them nothing about
 * whether Athena can actually reach them, which is the question being asked.
 */
async function sendTest(profileId) {
	const [fcmReady, webReady, smsReady, enabled] = await Promise.all([
		fcm.isConfigured(),
		webpush.isConfigured(),
		sms.isConfigured(),
		pushEnabledFor(profileId),
	]);
	if (!fcmReady && !webReady && !smsReady) {
		return { sent: 0, failed: 0, devices: 0, results: [], skipped: "not configured" };
	}
	if (!enabled) return { sent: 0, failed: 0, devices: 0, results: [], skipped: "not enabled" };

	const result = await sendToProfile(profileId, {
		title: "Athena",
		body: "This is the test you asked for — notifications are working.",
		data: { kind: "test" },
		// Its own key, so a test never replaces a real nudge sitting unread on
		// the lock screen, and a second test replaces the first.
		collapseKey: "athena-test",
	});
	return result;
}

/** Whether push can work at all, and who is reachable. For the settings UI. */
async function statusFor(profileId) {
	const [fcmReady, webReady, smsReady, devices, enabled] = await Promise.all([
		fcm.isConfigured(),
		webpush.isConfigured(),
		sms.isConfigured(),
		reachableDevices(profileId).catch(() => []),
		pushEnabledFor(profileId).catch(() => false),
	]);
	return {
		// False means no transport is wired up on the server. The UI says so
		// rather than offering a switch that silently does nothing.
		available: fcmReady || webReady || smsReady,
		// Broken out because they fail independently and for unrelated
		// reasons: "your phone works but this browser cannot" is a real state,
		// and one flag would render it as a mystery.
		transports: { fcm: fcmReady, webpush: webReady, sms: smsReady },
		enabled,
		devices: devices.map((d) => ({
			uuid: d.uuid,
			name: d.name,
			platform: d.platform,
			provider: d.provider,
		})),
	};
}

module.exports = {
	PROVIDERS,
	PUSHABLE_PLATFORMS,
	registerToken,
	forgetToken,
	registerBrowser,
	forgetBrowser,
	registerPhone,
	confirmPhone,
	forgetPhone,
	profileForNumber,
	webPushPublicKey: webpush.publicKey,
	reachableDevices,
	pushEnabledFor,
	sendToProfile,
	deliverNudge,
	sendTest,
	statusFor,
};
