const pool = require("../helpers/db");
const { getProfileByGoogleId } = require("./parent-helpers");
const { getFamilyForProfile, authorizeChildForParent } = require("./family");

/**
 * Family permission service.
 *
 * Stores parent-configurable AI / feature permissions. A row scoped to
 * child_profile_id = 0 is the family-wide default; a row scoped to a
 * specific child_profiles.id overrides the default for that child.
 *
 * Permissions are free-form key/value so new toggles (companion_mode,
 * voice_input, allowed_ai_provider, daily_message_limit, ...) can be added
 * without migrations. `DEFAULT_PERMISSIONS` documents the known keys.
 */

const DEFAULT_PERMISSIONS = {
	// Companion (open-ended chat) is OFF by default for child accounts. A
	// parent must explicitly enable it per family or per child. Teach mode
	// (the learning experience) stays on by default.
	companion_mode: "false",
	voice_input: "true",
	memory_enabled: "true",
	teach_mode: "true",
};

/**
 * Maps a conversation mode to the permission flag a child account must have
 * enabled to use it. Modes not listed here are unrestricted (e.g. 'teach').
 */
const MODE_PERMISSION_KEYS = {
	companion: "companion_mode",
};

function isPermissionEnabled(value) {
	return String(value).trim().toLowerCase() === "true";
}

async function resolveFamily(googleId) {
	const parent = await getProfileByGoogleId(googleId);
	const family = await getFamilyForProfile(parent.id);
	if (!family) throw new Error("No family found for this parent");
	return { parentId: parent.id, family };
}

/**
 * Effective permissions for a family (and optionally a specific child):
 * defaults <- family overrides <- child overrides.
 */
async function getPermissions(googleId, childUuid = null) {
	const { family } = await resolveFamily(googleId);
	let childProfilesId = 0;
	if (childUuid) {
		const { child } = await authorizeChildForParent(googleId, childUuid);
		childProfilesId = child.child_profiles_id;
	}

	const [rows] = await pool.query(
		`SELECT child_profile_id, permission_key, permission_value
     FROM family_permissions
     WHERE family_id = ? AND child_profile_id IN (0, ?);`,
		[family.id, childProfilesId]
	);

	const effective = { ...DEFAULT_PERMISSIONS };
	const familyLevel = {};
	const childLevel = {};
	for (const r of rows) {
		if (r.child_profile_id === 0) familyLevel[r.permission_key] = r.permission_value;
		else childLevel[r.permission_key] = r.permission_value;
	}
	Object.assign(effective, familyLevel, childLevel);

	return {
		effective,
		family_overrides: familyLevel,
		child_overrides: childLevel,
		scope: childUuid ? "child" : "family",
	};
}

/** Set/override a permission at family scope or for a specific child. */
async function setPermission(googleId, payload = {}) {
	const { parentId, family } = await resolveFamily(googleId);
	const key =
		typeof payload.key === "string" && payload.key.trim()
			? payload.key.trim().slice(0, 64)
			: null;
	if (!key) throw new Error("A permission key is required");
	const value =
		payload.value == null ? null : String(payload.value).slice(0, 512);

	let childProfilesId = 0;
	if (payload.child_uuid) {
		const { child } = await authorizeChildForParent(
			googleId,
			payload.child_uuid
		);
		childProfilesId = child.child_profiles_id;
	}

	await pool.query(
		`INSERT INTO family_permissions
     (family_id, child_profile_id, permission_key, permission_value, updated_by_profile_id)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE permission_value = VALUES(permission_value),
       updated_by_profile_id = VALUES(updated_by_profile_id);`,
		[family.id, childProfilesId, key, value, parentId]
	);

	return getPermissions(googleId, payload.child_uuid || null);
}

/**
 * Resolve the child-permission context for a session's profile id. A session
 * is "a child account" only when its profile has a `child_profiles` row.
 * Returns { familyId, childProfilesId } or null for parents / anonymous
 * public sessions (which are never gated).
 */
async function getChildPermissionContext(profileId) {
	if (!Number.isFinite(Number(profileId))) return null;
	const [rows] = await pool.query(
		`SELECT id AS child_profiles_id, family_id
     FROM child_profiles
     WHERE profile_id = ? AND deleted_at IS NULL
     LIMIT 1;`,
		[Number(profileId)]
	);
	if (!rows.length) return null;
	return {
		childProfilesId: Number(rows[0].child_profiles_id),
		familyId: Number(rows[0].family_id),
	};
}

/** Effective permissions for a child: defaults <- family <- child overrides. */
async function effectivePermissionsForChild(familyId, childProfilesId) {
	const [rows] = await pool.query(
		`SELECT child_profile_id, permission_key, permission_value
     FROM family_permissions
     WHERE family_id = ? AND child_profile_id IN (0, ?);`,
		[familyId, childProfilesId]
	);
	const effective = { ...DEFAULT_PERMISSIONS };
	const familyLevel = {};
	const childLevel = {};
	for (const r of rows) {
		if (Number(r.child_profile_id) === 0)
			familyLevel[r.permission_key] = r.permission_value;
		else childLevel[r.permission_key] = r.permission_value;
	}
	Object.assign(effective, familyLevel, childLevel);
	return effective;
}

/**
 * Whether the profile behind a session may use `modeKey`.
 * - Modes with no permission requirement (e.g. 'teach') are always allowed.
 * - Non-child profiles (parents, anonymous public sessions) are unrestricted.
 * - Child profiles may use a gated mode only when the parent has turned the
 *   corresponding permission flag on (default-deny for companion_mode).
 */
async function isModeAllowedForProfile(profileId, modeKey) {
	const permissionKey = MODE_PERMISSION_KEYS[modeKey];
	if (!permissionKey) return true;
	const ctx = await getChildPermissionContext(profileId);
	if (!ctx) return true;
	const effective = await effectivePermissionsForChild(
		ctx.familyId,
		ctx.childProfilesId
	);
	return isPermissionEnabled(effective[permissionKey]);
}

/**
 * Return the mode a session is actually allowed to run in. If the requested
 * mode is not permitted for this profile, fall back to 'teach' (the safe,
 * always-available learning mode).
 */
async function gateMode(requestedMode, profileId) {
	return (await isModeAllowedForProfile(profileId, requestedMode))
		? requestedMode
		: "teach";
}

/**
 * Filter a list of mode keys down to those this profile may use, so the
 * client can disable forbidden modes (e.g. grey out Companion for a child
 * whose parent has not enabled it). Non-child profiles get the full list.
 * Performs a single permission lookup regardless of the number of modes.
 */
async function allowedModesForProfile(profileId, modeKeys = []) {
	const ctx = await getChildPermissionContext(profileId);
	if (!ctx) return [...modeKeys];
	const effective = await effectivePermissionsForChild(
		ctx.familyId,
		ctx.childProfilesId
	);
	return modeKeys.filter((key) => {
		const permissionKey = MODE_PERMISSION_KEYS[key];
		return !permissionKey || isPermissionEnabled(effective[permissionKey]);
	});
}

module.exports = {
	DEFAULT_PERMISSIONS,
	MODE_PERMISSION_KEYS,
	getPermissions,
	setPermission,
	isModeAllowedForProfile,
	gateMode,
	allowedModesForProfile,
};
