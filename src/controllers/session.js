const sessionService = require("../services/session");
const { resolveMode, listModes } = require("../services/conversationMode");
const {
	gateMode,
	allowedModesForProfile,
} = require("../services/familyPermissions");
const { extractIp } = require("../helpers/utils");

/** Active mode keys this profile may actually use (for client gating). */
async function getAllowedModes(profileId) {
	const modes = await listModes();
	return allowedModesForProfile(
		profileId,
		modes.map((m) => m.key)
	);
}

function buildSessionPayload(session, extra = {}) {
	return {
		uuid: session.uuid,
		wisdom_points: session.wisdom_points ?? 0,
		age: session.age ?? 5,
		mode: session.mode || "teach",
		profile_id: session.profile_id || null,
		...extra,
	};
}

async function getOrCreateSession(req, res) {
	try {
		const ipAddress = extractIp(req);
		const sessionId = req.query.sessionId;
		const requestedMode = await resolveMode(
			req.query.mode || req.body?.mode
		);
		const profileUuid = req.query.profile_uuid || req.body?.profile_uuid;

		if (sessionId) {
			const session = await sessionService.getSessionByUuidAndIp(
				sessionId,
				ipAddress
			);

			if (session) {
				// Upgrade a previously-anonymous (IP-bound) session to the now-
				// known profile. A logged-in parent's first session can be created
				// before their profile_uuid is available; without this, that
				// session stays unbound forever and profile-scoped features (e.g.
				// Connected App grounding) never run for it.
				if (profileUuid && !session.profile_id) {
					const { profileId, familyId } =
						await sessionService.resolveProfileBinding(profileUuid);
					if (profileId) {
						await sessionService.bindSessionProfile(
							session.id,
							profileId,
							familyId
						);
						session.profile_id = profileId;
						session.family_id = familyId || null;
					}
				}

				// Allow switching the conversation mode on an existing session,
				// subject to the child account's parent-configured permissions.
				let modeDenied = false;
				if (
					(req.query.mode || req.body?.mode) &&
					requestedMode !== session.mode
				) {
					const allowedMode = await gateMode(
						requestedMode,
						session.profile_id
					);
					modeDenied = allowedMode !== requestedMode;
					if (allowedMode !== session.mode) {
						await sessionService.updateSession(session.id, {
							mode: allowedMode,
						});
						session.mode = allowedMode;
					}
				}

				res.json({
					success: true,
					session: buildSessionPayload(session, {
						mode_denied: modeDenied,
						allowed_modes: await getAllowedModes(session.profile_id),
					}),
				});
				return;
			}
		}

		const { profileId, familyId } =
			await sessionService.resolveProfileBinding(profileUuid);

		// Gate the requested mode against this child's parent-set permissions
		// before persisting the session (companion mode is default-deny).
		const allowedMode = await gateMode(requestedMode, profileId);

		const newSessionId = await sessionService.addSession(ipAddress, {
			mode: allowedMode,
			profileId,
			familyId,
		});

		res.json({
			success: true,
			session: {
				uuid: newSessionId,
				wisdom_points: 0,
				age: 5,
				mode: allowedMode,
				profile_id: profileId || null,
				mode_denied: allowedMode !== requestedMode,
				allowed_modes: await getAllowedModes(profileId),
			},
		});
	} catch (error) {
		console.error("Error creating/getting session:", error);
		res.status(500).json({ success: false, error: "DB query failed" });
	}
}

module.exports = getOrCreateSession;
