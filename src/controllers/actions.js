/**
 * Action layer HTTP surface: approving, declining and standing approvals.
 *
 * Every handler acts on the CALLER'S OWN profile, resolved from the verified
 * token. No handler reads a profile id, a google id or an action id owner from
 * the request body: approving one of Athena's proposals is exactly the thing
 * worth forging, and the uuid in the path is only ever checked against the
 * caller's own rows (services/actions scopes every query by profile_id).
 */

const actions = require("../services/actions");
const registry = require("../services/actions/registry");
const memory = require("../services/memory");

/**
 * The caller's profile, or a refusal.
 *
 * Child session tokens are refused outright rather than resolved. A child may
 * be the one talking to Athena, but they are not the person who gets to
 * approve a change to the account their parent owns — and an action layer
 * that quietly accepted a child token would be the most expensive possible
 * place to learn that.
 *
 * Paired devices (phone, car) ARE allowed. The device token is bound to one
 * profile, re-checked on every request and revocable from the Companion app,
 * which is the same authority the browser session has; refusing them would
 * mean Athena can offer to add an event while you drive and then cannot.
 */
async function callerProfile(req, res) {
	if (req.user?.kind === "child") {
		res.status(403).json({
			success: false,
			message: "Only the account owner can approve what Athena does",
		});
		return null;
	}
	try {
		const { profileId, familyId } = await memory.resolveProfileId(
			req.user?.kind === "device"
				? { profileId: req.user.profileId }
				: { googleId: req.user.googleId }
		);
		return { profileId, familyId };
	} catch (err) {
		console.warn("[actions] profile resolution failed:", err.message);
		res.status(404).json({ success: false, message: "Profile not found" });
		return null;
	}
}

/** Map a service error onto a status, defaulting to 500 rather than 400. */
function fail(res, err, fallbackMessage) {
	const status = Number.isInteger(err?.status) ? err.status : 500;
	if (status >= 500) console.error("[actions]", err?.message);
	return res.status(status).json({
		success: false,
		code: err?.code || null,
		message: status >= 500 ? fallbackMessage : err.message || fallbackMessage,
	});
}

/** What Athena could propose right now, and what she is standing-approved for. */
async function getStatus(req, res) {
	const caller = await callerProfile(req, res);
	if (!caller) return undefined;
	try {
		const [available, authorities, pending] = await Promise.all([
			actions.availableFor(caller.profileId),
			actions.listAuthorities(caller.profileId),
			actions.listPending(caller.profileId),
		]);
		return res.json({
			// The catalog is registry metadata, not user data: the panel needs to
			// name an action the person has not enabled in order to offer it.
			catalog: registry.ACTIONS.map((a) => ({
				id: a.id,
				label: a.label,
				provider: a.provider,
				consent_type: a.consentType,
				reversible: a.reversible,
				standing: a.standing,
			})),
			available: available.map((a) => a.id),
			authorities,
			pending,
		});
	} catch (err) {
		return fail(res, err, "Failed to load actions");
	}
}

/** Proposals still waiting on this person. */
async function listPending(req, res) {
	const caller = await callerProfile(req, res);
	if (!caller) return undefined;
	try {
		return res.json(await actions.listPending(caller.profileId));
	} catch (err) {
		return fail(res, err, "Failed to load pending actions");
	}
}

/** Everything Athena proposed recently and what became of it. */
async function listRecent(req, res) {
	const caller = await callerProfile(req, res);
	if (!caller) return undefined;
	try {
		return res.json(await actions.listRecent(caller.profileId, req.query?.limit));
	} catch (err) {
		return fail(res, err, "Failed to load action history");
	}
}

/**
 * Approve one proposal. This is the button that makes Athena act.
 *
 * A 409 here is the normal, expected answer to a double tap or a stale card,
 * not an error worth logging: the guarded transition in the service means the
 * second press genuinely lost a race it was right to lose.
 */
async function confirm(req, res) {
	const caller = await callerProfile(req, res);
	if (!caller) return undefined;
	try {
		const result = await actions.confirm(caller.profileId, req.params.uuid, {
			familyId: caller.familyId,
		});
		return res.json({ success: true, action: result });
	} catch (err) {
		return fail(res, err, "Failed to carry that out");
	}
}

async function decline(req, res) {
	const caller = await callerProfile(req, res);
	if (!caller) return undefined;
	try {
		const result = await actions.decline(caller.profileId, req.params.uuid);
		return res.json({ success: true, action: result });
	} catch (err) {
		return fail(res, err, "Failed to decline that");
	}
}

/** "Stop asking me each time." */
async function grantAuthority(req, res) {
	const caller = await callerProfile(req, res);
	if (!caller) return undefined;
	try {
		// An expiry may be offered by the client but never extended by it: a
		// non-date is dropped to "until revoked", which the person can see and
		// revoke, rather than silently becoming a date nobody chose.
		const raw = req.body?.expires_at;
		const expires = typeof raw === "string" && !Number.isNaN(Date.parse(raw))
			? new Date(raw)
			: null;
		const authorities = await actions.grantAuthority(
			caller.profileId,
			req.params.actionId,
			{ expiresAt: expires }
		);
		return res.json({ success: true, authorities });
	} catch (err) {
		return fail(res, err, "Failed to save that approval");
	}
}

async function revokeAuthority(req, res) {
	const caller = await callerProfile(req, res);
	if (!caller) return undefined;
	try {
		const authorities = await actions.revokeAuthority(
			caller.profileId,
			req.params.actionId
		);
		return res.json({ success: true, authorities });
	} catch (err) {
		return fail(res, err, "Failed to revoke that approval");
	}
}

module.exports = {
	getStatus,
	listPending,
	listRecent,
	confirm,
	decline,
	grantAuthority,
	revokeAuthority,
};
