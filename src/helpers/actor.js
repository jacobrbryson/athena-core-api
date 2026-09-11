/**
 * Resolve the authenticated caller (after requireAuth) to a profile, family,
 * and audience. Works for all three token kinds: parent (Google JWT), child
 * (login-code JWT), and paired device (opaque device token).
 */
const { resolveProfileId } = require("../services/memory");
const { audienceForProfile } = require("../services/audience");

function actorFromUser(user) {
	if (!user) return null;
	if (user.kind === "child") return { profileUuid: user.profileUuid };
	if (user.kind === "device") return { profileId: user.profileId };
	return { googleId: user.googleId };
}

async function resolveActor(req) {
	const actor = actorFromUser(req.user);
	if (!actor) throw Object.assign(new Error("Unauthorized"), { status: 401 });
	const { profileId, familyId } = await resolveProfileId(actor);
	const audience = await audienceForProfile(profileId);
	return { profileId, familyId, audience, kind: req.user.kind };
}

/** Express helper: 403 unless the caller is an adult profile. */
async function requireAdultActor(req, res) {
	try {
		const who = await resolveActor(req);
		if (who.audience !== "adult") {
			res.status(403).json({ success: false, message: "This feature is for adult accounts" });
			return null;
		}
		return who;
	} catch (err) {
		res.status(err.status || 401).json({ success: false, message: "Unauthorized" });
		return null;
	}
}

module.exports = { resolveActor, requireAdultActor, actorFromUser };
