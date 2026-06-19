const { v4: uuidv4 } = require("uuid");
const pool = require("../helpers/db");
const {
	withTransaction,
	getProfileByGoogleId,
	logChildActivity,
	getProfileDisplayName,
} = require("./parent-helpers");

/**
 * Family service — the canonical family-first layer.
 *
 * Families are the organizing entity. Parents and children are both
 * `profile` rows joined to a family through `family_members`. Children
 * additionally have a `child_profiles` row. The legacy pairwise
 * `profile_child` table is maintained as a compatibility shadow so the
 * existing parent endpoints keep functioning during the transition
 * (see docs/architecture/family-system.md).
 */

const CHILD_ROLES = new Set(["child"]);
const PARENT_ROLES = new Set(["owner", "parent", "guardian"]);
const ALLOWED_GRADES = new Set([
	"pre-k", "kindergarten", "1", "2", "3", "4", "5",
	"6", "7", "8", "9", "10", "11", "12",
]);

function normalizeGrade(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim().toLowerCase();
	return ALLOWED_GRADES.has(trimmed) ? trimmed : null;
}

function normalizeName(value, fallback = null) {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	return trimmed.length ? trimmed.slice(0, 120) : fallback;
}

function publicFamily(row) {
	if (!row) return null;
	return {
		uuid: row.uuid,
		name: row.name,
		subscription_plan: row.subscription_plan,
		status: row.status,
		created_at: row.created_at,
		role: row.role || null,
	};
}

function publicChildProfile(row) {
	if (!row) return null;
	return {
		uuid: row.uuid,
		profile_uuid: row.profile_uuid,
		display_name: row.display_name,
		avatar: row.avatar || null,
		grade: row.grade || null,
		birthday:
			typeof row.birthday === "string" && row.birthday.length >= 10
				? row.birthday.slice(0, 10)
				: row.birthday || null,
		status: row.status,
		wisdom_points: row.wisdom_points ?? 0,
		level: row.level ?? null,
		created_at: row.created_at,
	};
}

/** Resolve the acting parent's profile, ensuring they own a family. */
async function resolveParentProfile(googleId, conn = pool) {
	return getProfileByGoogleId(googleId, conn);
}

/** Find the family a profile belongs to (as parent/owner). Returns row or null. */
async function getFamilyForProfile(profileId, conn = pool) {
	const [rows] = await conn.query(
		`SELECT f.id, f.uuid, f.name, f.subscription_plan, f.status, f.created_at,
            fm.role
     FROM family_members fm
     JOIN families f ON f.id = fm.family_id
     WHERE fm.profile_id = ? AND fm.deleted_at IS NULL AND f.deleted_at IS NULL
       AND fm.role IN ('owner', 'parent', 'guardian')
     ORDER BY (fm.role = 'owner') DESC, f.created_at ASC
     LIMIT 1;`,
		[profileId]
	);
	return rows[0] || null;
}

/**
 * Create a family owned by the given profile. Idempotent-ish: if the
 * profile already owns/belongs to a family, that one is returned.
 */
async function createFamily(googleId, payload = {}) {
	return withTransaction(async (conn) => {
		const parent = await resolveParentProfile(googleId, conn);
		const existing = await getFamilyForProfile(parent.id, conn);
		if (existing) return publicFamily(existing);

		const name =
			normalizeName(payload.name) ||
			`${(await getProfileDisplayName(parent.id, conn)) || "My"}'s Family`;
		const uuid = uuidv4();
		const [result] = await conn.query(
			`INSERT INTO families (uuid, name, created_by_profile_id) VALUES (?, ?, ?);`,
			[uuid, name, parent.id]
		);
		await conn.query(
			`INSERT INTO family_members (family_id, profile_id, role, status)
       VALUES (?, ?, 'owner', 'active')
       ON DUPLICATE KEY UPDATE role = 'owner', deleted_at = NULL;`,
			[result.insertId, parent.id]
		);
		// Mark the profile as a guardian for compatibility with existing flags.
		await conn.query(`UPDATE profile SET is_guardian = 1 WHERE id = ?;`, [
			parent.id,
		]);

		const [rows] = await conn.query(
			`SELECT id, uuid, name, subscription_plan, status, created_at FROM families WHERE id = ?;`,
			[result.insertId]
		);
		return publicFamily({ ...rows[0], role: "owner" });
	});
}

/** Full family context for a parent: the family, members, and children. */
async function getFamilyContext(googleId) {
	const parent = await resolveParentProfile(googleId);
	const family = await getFamilyForProfile(parent.id);
	if (!family) {
		return { family: null, members: [], children: [] };
	}

	const [members] = await pool.query(
		`SELECT fm.role, fm.display_name, fm.status, p.uuid AS profile_uuid,
            p.full_name, p.picture, p.email
     FROM family_members fm
     JOIN profile p ON p.id = fm.profile_id
     WHERE fm.family_id = ? AND fm.deleted_at IS NULL
     ORDER BY FIELD(fm.role, 'owner', 'parent', 'guardian', 'child'), fm.created_at ASC;`,
		[family.id]
	);

	const children = await listChildren(family.id);

	return {
		family: publicFamily(family),
		members: members.map((m) => ({
			role: m.role,
			display_name: m.display_name || m.full_name,
			full_name: m.full_name,
			picture: m.picture || null,
			profile_uuid: m.profile_uuid,
			status: m.status,
		})),
		children,
	};
}

/** List child profiles for a family, enriched with their profile stats. */
async function listChildren(familyId) {
	const [rows] = await pool.query(
		`SELECT cp.uuid, cp.display_name, cp.avatar, cp.grade, cp.birthday, cp.status,
            cp.created_at, p.uuid AS profile_uuid, p.wisdom_points, p.level
     FROM child_profiles cp
     JOIN profile p ON p.id = cp.profile_id
     WHERE cp.family_id = ? AND cp.deleted_at IS NULL
     ORDER BY cp.created_at ASC;`,
		[familyId]
	);
	return rows.map(publicChildProfile);
}

/** List children for the family owned by the authenticated parent. */
async function getChildrenForParent(googleId) {
	const parent = await resolveParentProfile(googleId);
	const family = await getFamilyForProfile(parent.id);
	if (!family) return [];
	return listChildren(family.id);
}

/**
 * Create a child profile inside the parent's family. No email / Google
 * account required. Creates the underlying profile, family membership,
 * child_profiles row, and a profile_child shadow for every parent in the
 * family (backwards compatibility).
 */
async function createChild(googleId, payload = {}) {
	return withTransaction(async (conn) => {
		const parent = await resolveParentProfile(googleId, conn);
		let family = await getFamilyForProfile(parent.id, conn);

		// Auto-provision a family on first child creation.
		if (!family) {
			const familyUuid = uuidv4();
			const familyName = `${
				(await getProfileDisplayName(parent.id, conn)) || "My"
			}'s Family`;
			const [fResult] = await conn.query(
				`INSERT INTO families (uuid, name, created_by_profile_id) VALUES (?, ?, ?);`,
				[familyUuid, familyName, parent.id]
			);
			await conn.query(
				`INSERT INTO family_members (family_id, profile_id, role, status)
         VALUES (?, ?, 'owner', 'active');`,
				[fResult.insertId, parent.id]
			);
			await conn.query(`UPDATE profile SET is_guardian = 1 WHERE id = ?;`, [
				parent.id,
			]);
			family = { id: fResult.insertId, uuid: familyUuid, name: familyName };
		}

		const displayName = normalizeName(
			payload.display_name || payload.full_name,
			"New Explorer"
		);
		const grade = normalizeGrade(payload.grade);
		const birthday =
			typeof payload.birthday === "string" && payload.birthday.length >= 10
				? payload.birthday.slice(0, 10)
				: null;

		// 1. Underlying profile (no email / no Google id).
		const profileUuid = uuidv4();
		const [pResult] = await conn.query(
			`INSERT INTO profile
       (uuid, google_id, email, full_name, birthday, grade, has_guardian, is_guardian, is_teacher, profile_editing_locked)
       VALUES (?, ?, NULL, ?, ?, ?, 1, 0, 0, 1);`,
			[profileUuid, `child:${profileUuid}`, displayName, birthday, grade]
		);
		const childProfileId = pResult.insertId;

		// 2. Family membership.
		await conn.query(
			`INSERT INTO family_members (family_id, profile_id, role, display_name, status)
       VALUES (?, ?, 'child', ?, 'active');`,
			[family.id, childProfileId, displayName]
		);

		// 3. child_profiles extension row.
		const childUuid = uuidv4();
		await conn.query(
			`INSERT INTO child_profiles
       (uuid, family_id, profile_id, display_name, avatar, grade, birthday, created_by_profile_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
			[
				childUuid,
				family.id,
				childProfileId,
				displayName,
				normalizeName(payload.avatar) || null,
				grade,
				birthday,
				parent.id,
			]
		);

		// 4. profile_child shadow for every parent/guardian in the family.
		await conn.query(
			`INSERT IGNORE INTO profile_child (parent_profile_id, child_profile_id, invited_at, approved_at)
       SELECT fm.profile_id, ?, NOW(), NOW()
       FROM family_members fm
       WHERE fm.family_id = ? AND fm.role IN ('owner', 'parent', 'guardian') AND fm.deleted_at IS NULL;`,
			[childProfileId, family.id]
		);

		await logChildActivity({
			childProfileId,
			parentProfileId: parent.id,
			activity: `${displayName} was added to ${family.name}`,
			tableName: "child_profiles",
			recordId: childProfileId,
			actorProfileId: parent.id,
		});

		const [rows] = await conn.query(
			`SELECT cp.uuid, cp.display_name, cp.avatar, cp.grade, cp.birthday, cp.status,
              cp.created_at, p.uuid AS profile_uuid, p.wisdom_points, p.level
       FROM child_profiles cp JOIN profile p ON p.id = cp.profile_id
       WHERE cp.profile_id = ? LIMIT 1;`,
			[childProfileId]
		);
		return publicChildProfile(rows[0]);
	});
}

/**
 * Verify the authenticated parent may act for the given child (by child
 * profile uuid OR child_profiles uuid). Returns { parent, family, child }
 * with internal ids, or throws. Used by profile-switching and login-code
 * generation.
 */
async function authorizeChildForParent(googleId, childUuid, conn = pool) {
	const parent = await resolveParentProfile(googleId, conn);
	const family = await getFamilyForProfile(parent.id, conn);
	if (!family) throw new Error("No family found for this parent");

	const [rows] = await conn.query(
		`SELECT cp.id AS child_profiles_id, cp.uuid AS child_uuid, cp.display_name,
            cp.profile_id, p.uuid AS profile_uuid
     FROM child_profiles cp
     JOIN profile p ON p.id = cp.profile_id
     WHERE cp.family_id = ? AND cp.deleted_at IS NULL
       AND (cp.uuid = ? OR p.uuid = ?)
     LIMIT 1;`,
		[family.id, childUuid, childUuid]
	);
	if (!rows.length) throw new Error("Child not found in your family");

	return {
		parent,
		family: { id: family.id, uuid: family.uuid, name: family.name },
		child: rows[0],
	};
}

module.exports = {
	CHILD_ROLES,
	PARENT_ROLES,
	createFamily,
	getFamilyContext,
	getFamilyForProfile,
	getChildrenForParent,
	listChildren,
	createChild,
	authorizeChildForParent,
	resolveParentProfile,
	publicFamily,
	publicChildProfile,
};
