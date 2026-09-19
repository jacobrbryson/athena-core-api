/**
 * Initiative HTTP surface: what Athena has said unprompted, and the controls
 * for how often she may.
 *
 * Same rule as the action controller — every handler acts on the caller's own
 * profile, resolved from the verified token, and no handler reads a profile id
 * from a request body. Child tokens are refused: being interrupted is
 * something the account owner opted into, and the settings that govern it are
 * theirs.
 */

const initiative = require("../services/initiative");
const triggers = require("../services/initiative/triggers");
const memory = require("../services/memory");
const push = require("../services/push");

async function callerProfile(req, res) {
	if (req.user?.kind === "child") {
		res.status(403).json({
			success: false,
			message: "Only the account owner can change this",
		});
		return null;
	}
	try {
		const { profileId } = await memory.resolveProfileId(
			req.user?.kind === "device"
				? { profileId: req.user.profileId }
				: { googleId: req.user.googleId }
		);
		return profileId;
	} catch (err) {
		console.warn("[initiative] profile resolution failed:", err.message);
		res.status(404).json({ success: false, message: "Profile not found" });
		return null;
	}
}

function fail(res, err, fallbackMessage) {
	const status = Number.isInteger(err?.status) ? err.status : 500;
	if (status >= 500) console.error("[initiative]", err?.message);
	return res.status(status).json({
		success: false,
		code: err?.code || null,
		message: status >= 500 ? fallbackMessage : err.message || fallbackMessage,
	});
}

/** Settings, the trigger catalog, and what she has said lately. */
async function getStatus(req, res) {
	const profileId = await callerProfile(req, res);
	if (!profileId) return undefined;
	try {
		const [pref, muted, recent, scores, pushStatus] = await Promise.all([
			initiative.getPref(profileId),
			initiative.listMutes(profileId),
			initiative.recentFor(profileId, 20),
			initiative.scoresFor(profileId),
			push.statusFor(profileId),
		]);
		return res.json({
			pref,
			// Whether push can work at all on this server, and which handsets
			// are registered. `available: false` means nobody wired FCM up, and
			// the UI says that rather than offering a switch that does nothing.
			push: pushStatus,
			// What Athena has learned about how each trigger lands for THIS
			// person. Surfaced because a system that quietly went quiet on you
			// would be worse than one that never learned: the panel says which
			// ones she has backed off and why, and offers them back.
			scores,
			// The whole catalog, including triggers this person cannot currently
			// fire. Someone deciding whether to switch this on deserves to see
			// everything she might say, not only what her current links allow.
			catalog: triggers.TRIGGERS.map((t) => ({
				id: t.id,
				label: t.label,
				describe: t.describe,
				sources: t.sources,
				urgency: t.urgency,
			})),
			muted,
			recent,
		});
	} catch (err) {
		return fail(res, err, "Failed to load initiative settings");
	}
}

/**
 * GET /initiative/diagnostics — why she is quiet right now.
 *
 * `?evaluate=1` runs the real trigger evaluators, which calls out to whichever
 * providers are linked. Off by default so opening a settings panel does not
 * cost three provider round trips.
 */
async function getDiagnostics(req, res) {
	const profileId = await callerProfile(req, res);
	if (!profileId) return undefined;
	try {
		const evaluate = req.query?.evaluate === "1" || req.query?.evaluate === "true";
		const [report, pushStatus] = await Promise.all([
			initiative.diagnose(profileId, { evaluate }),
			push.statusFor(profileId),
		]);
		return res.json({ ...report, push: pushStatus });
	} catch (err) {
		return fail(res, err, "Failed to work out why she is quiet");
	}
}

/**
 * GET /initiative/web-push — the VAPID public key this browser subscribes with.
 *
 * Served rather than built into the bundle so rotating the keypair takes
 * effect on the next page load instead of the next deploy of the web app.
 * Null means web push is not configured on this server, and the UI says so
 * instead of offering a switch that cannot work.
 */
async function getWebPushKey(req, res) {
	const profileId = await callerProfile(req, res);
	if (!profileId) return undefined;
	try {
		return res.json({ public_key: await push.webPushPublicKey() });
	} catch (err) {
		return fail(res, err, "Failed to load the notification key");
	}
}

/**
 * PUT /initiative/web-push — this browser asks to be reachable.
 *
 * Session-authenticated: unlike a phone, a browser is handed no device token
 * to keep. See services/push.registerBrowser.
 */
async function registerWebPush(req, res) {
	const profileId = await callerProfile(req, res);
	if (!profileId) return undefined;
	try {
		const result = await push.registerBrowser(profileId, {
			subscription: req.body?.subscription,
			browserId: req.body?.browser_id,
			name: req.body?.name,
		});
		return res.json({ success: true, ...result });
	} catch (err) {
		return fail(res, err, "Failed to turn on notifications for this browser");
	}
}

/** DELETE /initiative/web-push — notifications turned off in this browser. */
async function forgetWebPush(req, res) {
	const profileId = await callerProfile(req, res);
	if (!profileId) return undefined;
	try {
		const result = await push.forgetBrowser(profileId, req.query?.browser_id);
		return res.json({ success: true, ...result });
	} catch (err) {
		return fail(res, err, "Failed to turn off notifications for this browser");
	}
}

/**
 * POST /initiative/sms — start verifying a number, by texting a code to it.
 *
 * Unlike a push token, a phone number is a string somebody typed rather than
 * something a device minted, so it has to prove it is theirs before Athena
 * will ever text it. See services/push.registerPhone.
 */
async function startSms(req, res) {
	const profileId = await callerProfile(req, res);
	if (!profileId) return undefined;
	try {
		return res.json({ success: true, ...(await push.registerPhone(profileId, req.body?.phone)) });
	} catch (err) {
		return fail(res, err, "Could not send the verification text");
	}
}

/** PUT /initiative/sms — the code came back; make the number live. */
async function confirmSms(req, res) {
	const profileId = await callerProfile(req, res);
	if (!profileId) return undefined;
	try {
		const result = await push.confirmPhone(profileId, req.body?.phone, req.body?.code);
		return res.json({ success: true, ...result });
	} catch (err) {
		return fail(res, err, "Could not confirm that number");
	}
}

/** DELETE /initiative/sms — stop texting me. */
async function forgetSms(req, res) {
	const profileId = await callerProfile(req, res);
	if (!profileId) return undefined;
	try {
		return res.json({ success: true, ...(await push.forgetPhone(profileId)) });
	} catch (err) {
		return fail(res, err, "Could not turn off text messages");
	}
}

/**
 * POST /initiative/test-notification — prove the path to this person's devices.
 *
 * Deliberately not routed through the budget or recorded as a nudge; see
 * services/push.sendTest for why. The honest failure cases matter more than
 * the success here, so the per-device reasons are passed straight through
 * rather than collapsed into a count.
 */
async function testNotification(req, res) {
	const profileId = await callerProfile(req, res);
	if (!profileId) return undefined;
	try {
		const result = await push.sendTest(profileId);
		return res.json({ success: true, ...result });
	} catch (err) {
		return fail(res, err, "Failed to send the test notification");
	}
}

/**
 * Anything she has to say that the caller has not seen.
 *
 * Reading marks them delivered, so this is a POST-shaped GET on purpose: two
 * open tabs must not both count as an interruption, and `delivered_at` has to
 * mean "a person could actually see this" for the nightly review to be able
 * to tell a real interruption from one that expired unseen.
 */
async function getPending(req, res) {
	const profileId = await callerProfile(req, res);
	if (!profileId) return undefined;
	try {
		return res.json(await initiative.pendingFor(profileId));
	} catch (err) {
		return fail(res, err, "Failed to load");
	}
}

async function updatePref(req, res) {
	const profileId = await callerProfile(req, res);
	if (!profileId) return undefined;
	try {
		const pref = await initiative.setPref(profileId, req.body || {});
		return res.json({ success: true, pref });
	} catch (err) {
		return fail(res, err, "Failed to save settings");
	}
}

/** How a nudge landed. The only measurement that keeps her honest. */
async function react(req, res) {
	const profileId = await callerProfile(req, res);
	if (!profileId) return undefined;
	try {
		const result = await initiative.react(profileId, req.params.uuid, req.body?.reaction);
		return res.json({ success: true, ...result });
	} catch (err) {
		return fail(res, err, "Failed to record that");
	}
}

/**
 * "Start telling me about this again."
 *
 * The only way out of a suppression Athena applied herself. There is
 * deliberately no automatic route: she backed off because someone did not want
 * it, and deciding on their behalf that they have changed their mind is the
 * behaviour that makes people stop trusting a system like this.
 */
async function resumeTrigger(req, res) {
	const profileId = await callerProfile(req, res);
	if (!profileId) return undefined;
	try {
		const score = await initiative.resumeTrigger(profileId, req.params.triggerId);
		return res.json({ success: true, trigger_id: req.params.triggerId, score });
	} catch (err) {
		return fail(res, err, "Failed to turn that back on");
	}
}

async function mute(req, res) {
	const profileId = await callerProfile(req, res);
	if (!profileId) return undefined;
	try {
		return res.json({ success: true, muted: await initiative.mute(profileId, req.params.triggerId) });
	} catch (err) {
		return fail(res, err, "Failed to mute that");
	}
}

async function unmute(req, res) {
	const profileId = await callerProfile(req, res);
	if (!profileId) return undefined;
	try {
		return res.json({
			success: true,
			muted: await initiative.unmute(profileId, req.params.triggerId),
		});
	} catch (err) {
		return fail(res, err, "Failed to unmute that");
	}
}

module.exports = {
	getStatus,
	getDiagnostics,
	getWebPushKey,
	registerWebPush,
	forgetWebPush,
	startSms,
	confirmSms,
	forgetSms,
	testNotification,
	getPending,
	updatePref,
	react,
	mute,
	unmute,
	resumeTrigger,
};
