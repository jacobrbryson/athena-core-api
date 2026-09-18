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

const pool = require("../../helpers/db");
const crypto = require("../../helpers/crypto");
const fcm = require("./fcm");

/** Providers we can actually deliver to. A device may only register these. */
const PROVIDERS = new Set(["fcm"]);

/** Platforms with a real push story. `web` pairs but has no transport yet. */
const PUSHABLE_PLATFORMS = new Set(["android", "car"]);

const TRANSPORTS = { fcm };

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
 * whenever the app is restored to a new phone, and the client is expected to
 * send the current one on every launch.
 */
async function registerToken(deviceId, token, { provider = "fcm" } = {}) {
	if (!PROVIDERS.has(provider)) {
		throw failure("Unsupported push provider", 400, "bad_provider");
	}
	if (typeof token !== "string" || token.length < 20 || token.length > 4096) {
		throw failure("That does not look like a push token", 400, "bad_token");
	}
	const encrypted = await crypto.encrypt(token);
	await pool.query(
		`UPDATE paired_device
		 SET push_provider = ?, push_token_enc = ?, push_registered_at = NOW(),
		     push_failures = 0, push_failed_at = NULL
		 WHERE id = ? AND revoked_at IS NULL`,
		[provider, encrypted, deviceId]
	);
	return { provider, registered: true };
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
		try {
			out.push({
				id: row.id,
				uuid: row.uuid,
				name: row.name,
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
	for (const device of devices) {
		const transport = TRANSPORTS[device.provider];
		if (!transport) continue;
		const result = await transport.send(device.token, { title, body, data, collapseKey });
		if (result.ok) {
			sent += 1;
			continue;
		}
		failed += 1;
		if (result.dead) await dropDeadToken(device.id, result.reason);
		else await recordSoftFailure(device.id);
	}
	return { sent, failed, devices: devices.length };
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
 */
async function deliverNudge(profileId, nudge) {
	if (!nudge?.uuid || !nudge?.text) return { sent: 0 };
	let result;
	try {
		result = await sendToProfile(profileId, {
			title: "Athena",
			body: nudge.text,
			data: { kind: "nudge", uuid: nudge.uuid, trigger: nudge.trigger_id || "" },
			// One live Athena notification at a time. A second nudge replaces
			// the first rather than stacking underneath it.
			collapseKey: "athena-nudge",
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

/** Whether push can work at all, and who is reachable. For the settings UI. */
async function statusFor(profileId) {
	const [configured, devices, enabled] = await Promise.all([
		fcm.isConfigured(),
		reachableDevices(profileId).catch(() => []),
		pushEnabledFor(profileId).catch(() => false),
	]);
	return {
		// False means nobody has wired FCM up on the server. The UI says so
		// rather than offering a switch that silently does nothing.
		available: configured,
		enabled,
		devices: devices.map((d) => ({ uuid: d.uuid, name: d.name })),
	};
}

module.exports = {
	PROVIDERS,
	PUSHABLE_PLATFORMS,
	registerToken,
	forgetToken,
	reachableDevices,
	pushEnabledFor,
	sendToProfile,
	deliverNudge,
	statusFor,
};
