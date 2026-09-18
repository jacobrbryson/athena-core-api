const sessionService = require("../services/session");
const { resolveMode, listModes } = require("../services/conversationMode");
const {
  gateMode,
  allowedModesForProfile,
} = require("../services/familyPermissions");
const { extractIp } = require("../helpers/utils");
const { resolveCallerProfileId } = require("../helpers/callerIdentity");
const { presentParticipants } = require("../services/sessionParticipant");

/** Active mode keys this profile may actually use (for client gating). */
async function getAllowedModes(profileId) {
  const modes = await listModes();
  return allowedModesForProfile(
    profileId,
    modes.map((m) => m.key),
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
    const requestedMode = await resolveMode(req.query.mode || req.body?.mode);
    const profileUuid = req.query.profile_uuid || req.body?.profile_uuid;

    // The profile this caller has cryptographically proven (signed token only —
    // never the profile_uuid query param, which the client controls).
    const callerProfileId = await resolveCallerProfileId(req);

    if (sessionId) {
      let session = await sessionService.getAuthorizedSession(sessionId, {
        ip: ipAddress,
        callerProfileId,
      });

      // A second guardian switching accounts on a shared device is
      // indistinguishable from an unauthorized caller here: a valid uuid and
      // a proven profile that is not the session's owner. Before falling
      // through to "start a fresh session" — which severs the transcript
      // mid-conversation and leaves Athena with no thread — offer them the
      // existing one. `admitToSession` returns null unless they share an
      // active family with its owner in an adult role.
      if (!session && callerProfileId != null) {
        session = await sessionService
          .admitToSession(sessionId, callerProfileId)
          .catch((err) => {
            console.warn("[session] admit failed:", err.message);
            return null;
          });
      }

      if (session) {
        // Upgrade a previously-anonymous session to the now-known profile. A
        // logged-in parent's first session can be created before their
        // profile_uuid is available; without this, that session stays unbound
        // forever and profile-scoped features (e.g. Connected App grounding)
        // never run for it. Binding also promotes the session off IP checks
        // and onto identity, so it survives a network change from then on.
        if (profileUuid && !session.profile_id) {
          const { profileId, familyId } =
            await sessionService.resolveProfileBinding(profileUuid);
          if (profileId) {
            await sessionService.bindSessionProfile(
              session.id,
              profileId,
              familyId,
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
          const allowedMode = await gateMode(requestedMode, session.profile_id);
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
            // Who Athena is talking to. A shared conversation should say so
            // on screen — someone needs to be able to see that their reply
            // is going somewhere another person can read.
            participants: await presentParticipants(session.id).catch(() => []),
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
