/**
 * Who is Athena talking to? Drives model policy (child sessions prefer
 * frontier safety tuning), the adult vs. kid companion persona, and which
 * memory features are allowed.
 *
 *   - Guardian (AR game) sessions and anonymous public sessions -> "child"
 *     (the public site is a kids' product; the safe default).
 *   - A profile with a child_profiles row -> "child".
 *   - Any other bound profile (a parent's Google account) -> "adult".
 */
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
	return audienceForProfile(session.profile_id);
}

/**
 * Whether long-term memory (recall + extraction) may run for a profile.
 * Adults: always. Children: the parent-controlled `memory_enabled` flag.
 */
async function memoryEnabledForProfile(profileId) {
	if (!Number.isFinite(Number(profileId))) return false;
	const ctx = await childContext(Number(profileId));
	if (!ctx) return true;
	const effective = await effectivePermissionsForChild(ctx.familyId, ctx.childProfilesId);
	return isPermissionEnabled(effective.memory_enabled);
}

module.exports = {
	audienceForProfile,
	audienceForSession,
	memoryEnabledForProfile,
	_clearCache: () => cache.clear(),
};
