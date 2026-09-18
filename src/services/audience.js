/**
 * Who is Athena talking to? Drives model policy (child sessions prefer
 * frontier safety tuning), the adult vs. kid companion persona, and which
 * memory features are allowed.
 *
 *   - Guardian (AR game) sessions and anonymous public sessions -> "child"
 *     (the public site is a kids' product; the safe default).
 *   - A profile with a child_profiles row -> "child".
 *   - Any other bound profile (a parent's Google account) -> "adult".
 *
 * Since a session can hold more than one person (0030_session_participant),
 * the answer for a SESSION is the most restrictive answer among everyone
 * present — not the profile it was bound to. A parent switching accounts on
 * the device a child is still sitting at must not unlock adult model policy,
 * adult persona or adult memory rules in front of them. The switch changes who
 * may approve things; it does not change who is in the room.
 */
const { presentProfileIds } = require("./sessionParticipant");
const {
  getChildPermissionContext,
  effectivePermissionsForChild,
  isPermissionEnabled,
} = require("./familyPermissions");

const TTL_MS = 10 * 60_000;
const cache = new Map(); // profileId -> { value, at }

async function childContext(profileId) {
  const hit = cache.get(profileId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await getChildPermissionContext(profileId);
  cache.set(profileId, { value, at: Date.now() });
  return value;
}

async function audienceForProfile(profileId) {
  if (!Number.isFinite(Number(profileId))) return "child";
  return (await childContext(Number(profileId))) ? "child" : "adult";
}

async function audienceForSession(session, ctx = {}) {
  if (ctx.guardian || ctx.guardianAuth) return "child";
  if (!session?.profile_id) return "child";

  // Everyone currently in the conversation, not just whoever started it.
  // Fails closed: if we cannot establish who is present, assume a child is.
  // Guessing "adult" here would relax safety rules on the strength of a
  // failed query, which is the one direction this must never fail in.
  let present;
  try {
    present = await presentProfileIds(session.id);
  } catch (err) {
    console.warn("[audience] participants unavailable:", err.message);
    return "child";
  }

  // A session predating 0030, or one whose span write failed, still has an
  // owner to judge by.
  const people = present.length ? present : [Number(session.profile_id)];

  for (const profileId of people) {
    if ((await audienceForProfile(profileId)) === "child") return "child";
  }
  return "adult";
}

/**
 * Whether long-term memory (recall + extraction) may run for a profile.
 * Adults: always. Children: the parent-controlled `memory_enabled` flag.
 */
async function memoryEnabledForProfile(profileId) {
  if (!Number.isFinite(Number(profileId))) return false;
  const ctx = await childContext(Number(profileId));
  if (!ctx) return true;
  const effective = await effectivePermissionsForChild(
    ctx.familyId,
    ctx.childProfilesId,
  );
  return isPermissionEnabled(effective.memory_enabled);
}

module.exports = {
  audienceForProfile,
  audienceForSession,
  memoryEnabledForProfile,
  _clearCache: () => cache.clear(),
};
