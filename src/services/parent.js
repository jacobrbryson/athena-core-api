const pool = require("../helpers/db");
const { buildUpdateClauses } = require("../helpers/query");
const { v4: uuidv4 } = require("uuid");
const {
	getProfileByGoogleId: getProfileByGoogleIdService,
	getProfileByEmail,
} = require("./profile");

const allowedChildFields = {
	full_name: "string",
	email: "string",
	birthday: "string",
};

const childSelectColumns = `
  pc.id AS relationship_id,
  pc.parent_profile_id,
  pc.child_profile_id,
  pc.created_at AS relationship_created_at,
  pc.updated_at AS relationship_updated_at,
  pc.invited_at AS relationship_invited_at,
  pc.approved_at AS relationship_approved_at,
  pc.denied_at AS relationship_denied_at,
  child.uuid AS child_uuid,
  child.google_id AS child_google_id,
  child.full_name,
  child.email,
  child.birthday,
  child.created_at AS child_created_at,
  child.updated_at AS child_updated_at
`;

function normalizeGoogleId(googleId) {
	if (googleId === undefined || googleId === null) return null;

	if (typeof googleId === "string") {
		const trimmed = googleId.trim();
		return trimmed.length ? trimmed : null;
	}

	if (typeof googleId === "number") {
		return String(googleId);
	}

	return null;
}

function normalizeUuid(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length ? trimmed : null;
}

function mapChildRow(row) {
	if (!row) return null;

	return {
		id: row.relationship_id,
		relationship_id: row.relationship_id,
		parent_profile_id: row.parent_profile_id,
		child_profile_id: row.child_profile_id,
		uuid: row.child_uuid,
		child_uuid: row.child_uuid,
		google_id: row.child_google_id,
		child_google_id: row.child_google_id,
		full_name: row.full_name,
		email: row.email,
		birthday: row.birthday,
		created_at: row.child_created_at,
		updated_at: row.child_updated_at,
		relationship_created_at: row.relationship_created_at,
		relationship_updated_at: row.relationship_updated_at,
		invited_at: row.relationship_invited_at,
		approved_at: row.relationship_approved_at,
		denied_at: row.relationship_denied_at,
	};
}

function extractUpdatableFields(payload = {}) {
	const updates = {};

	for (const [field, expectedType] of Object.entries(allowedChildFields)) {
		const value = payload[field];
		if (typeof value === expectedType) {
			updates[field] = field === "birthday" ? value.slice(0, 10) : value;
		}
	}

	return updates;
}

function extractChildIdentifiers(payload = {}) {
	const childUuid =
		normalizeUuid(payload.child_uuid) ||
		normalizeUuid(payload.childUuid) ||
		normalizeUuid(payload.uuid);

	const childGoogleId =
		normalizeGoogleId(payload.child_google_id) ||
		normalizeGoogleId(payload.childGoogleId) ||
		normalizeGoogleId(payload.google_id);

	if (!childUuid && !childGoogleId) {
		throw new Error(
			"A child identifier (child_uuid or child_google_id) is required."
		);
	}

	return { childUuid, childGoogleId };
}

async function getProfileByGoogleId(googleId) {
	const normalized = normalizeGoogleId(googleId);
	if (normalized === null) {
		throw new Error("Invalid google_id");
	}

	const [rows] = await pool.query(
		`SELECT id, uuid, google_id FROM profile WHERE google_id = ? LIMIT 1;`,
		[normalized]
	);

	if (!rows.length) {
		throw new Error("Profile not found for provided google_id");
	}

	return rows[0];
}

async function syncHasGuardian(childProfileId) {
	const [rows] = await pool.query(
		`SELECT COUNT(*) AS cnt FROM profile_child WHERE child_profile_id = ?`,
		[childProfileId]
	);
	const count = rows?.[0]?.cnt || 0;
	const hasGuardian = count > 0 ? 1 : 0;
	await pool.query(
		`UPDATE profile SET has_guardian = ? WHERE id = ?`,
		[hasGuardian, childProfileId]
	);
	return hasGuardian === 1;
}

async function getChildProfile(childUuid, childGoogleId) {
	const conditions = [];
	const values = [];

	if (childUuid) {
		conditions.push("uuid = ?");
		values.push(childUuid);
	}

	if (childGoogleId) {
		conditions.push("google_id = ?");
		values.push(childGoogleId);
	}

	const [rows] = await pool.query(
		`SELECT id, uuid, google_id, full_name, email, birthday, created_at, updated_at
    FROM profile
    WHERE ${conditions.join(" OR ")}
    LIMIT 1;`,
		values
	);

	if (!rows.length) {
		throw new Error("Child profile not found");
	}

	return rows[0];
}

async function getChildRelationship(parentProfileId, relationshipId) {
	const [rows] = await pool.query(
		`SELECT ${childSelectColumns}
    FROM profile_child pc
    JOIN profile child ON child.id = pc.child_profile_id
    WHERE pc.id = ? AND pc.parent_profile_id = ?
    LIMIT 1;`,
		[relationshipId, parentProfileId]
	);

	return mapChildRow(rows[0]);
}

async function getChildrenByGoogleId(googleId) {
	const parentProfile = await getProfileByGoogleId(googleId);

	const [rows] = await pool.query(
		`SELECT ${childSelectColumns}
    FROM profile_child pc
    JOIN profile child ON child.id = pc.child_profile_id
    WHERE pc.parent_profile_id = ?
    ORDER BY pc.created_at DESC;`,
		[parentProfile.id]
	);

	return rows.map(mapChildRow).filter(Boolean);
}

async function addChild(googleId, payload = {}) {
	const parentProfile = await getProfileByGoogleId(googleId);
	const { childUuid, childGoogleId } = extractChildIdentifiers(payload);
	const childProfile = await getChildProfile(childUuid, childGoogleId);

	const [existing] = await pool.query(
		`SELECT id FROM profile_child WHERE parent_profile_id = ? AND child_profile_id = ? LIMIT 1;`,
		[parentProfile.id, childProfile.id]
	);

	if (existing.length) {
		throw new Error("Child is already linked to this parent");
	}

	const updates = extractUpdatableFields(payload);
	if (Object.keys(updates).length) {
		const { setClauses, values } = buildUpdateClauses(
			updates,
			allowedChildFields
		);

		await pool.query(
			`UPDATE profile SET ${setClauses} WHERE id = ?`,
			[...values, childProfile.id]
		);
	}

	const [result] = await pool.query(
		`INSERT INTO profile_child (parent_profile_id, child_profile_id)
    VALUES (?, ?);`,
		[parentProfile.id, childProfile.id]
	);
	await syncHasGuardian(childProfile.id);

	return getChildRelationship(parentProfile.id, result.insertId);
}

async function updateChild(googleId, childRelationshipId, payload = {}) {
	const parentProfile = await getProfileByGoogleId(googleId);

	const relationshipId = Number(childRelationshipId);
	if (!Number.isFinite(relationshipId)) {
		throw new Error("Invalid child id");
	}

	const relationship = await getChildRelationship(
		parentProfile.id,
		relationshipId
	);
	if (!relationship) {
		throw new Error("Child not found for this parent");
	}

	const updates = extractUpdatableFields(payload);
	if (!Object.keys(updates).length) {
		throw new Error("No valid child fields provided to update.");
	}

	const { setClauses, values } = buildUpdateClauses(
		updates,
		allowedChildFields
	);

	await pool.query(
		`UPDATE profile SET ${setClauses} WHERE id = ?`,
		[...values, relationship.child_profile_id]
	);

	return getChildRelationship(parentProfile.id, relationshipId);
}

async function deleteChild(googleId, childRelationshipId) {
	const parentProfile = await getProfileByGoogleId(googleId);

	const relationshipId = Number(childRelationshipId);
	if (!Number.isFinite(relationshipId)) {
		throw new Error("Invalid child id");
	}

	const relationship = await getChildRelationship(
		parentProfile.id,
		relationshipId
	);
	if (!relationship) {
		throw new Error("Child not found for this parent");
	}

	await pool.query(
		`DELETE FROM profile_child WHERE id = ? AND parent_profile_id = ?`,
		[relationshipId, parentProfile.id]
	);

	await syncHasGuardian(relationship.child_profile_id);

	return { success: true };
}

async function isBlocked(parentProfileId, childProfileId) {
	const [rows] = await pool.query(
		`SELECT 1 FROM parent_child_blocklist WHERE parent_profile_id = ? AND child_profile_id = ? LIMIT 1;`,
		[parentProfileId, childProfileId]
	);

	return rows.length > 0;
}

async function getBlocklist(googleId) {
	const parentProfile = await getProfileByGoogleId(googleId);

	const [rows] = await pool.query(
		`SELECT 
      b.parent_profile_id,
      b.child_profile_id,
      b.child_email,
      b.blocked_at,
      child.uuid AS child_uuid,
      child.google_id AS child_google_id,
      child.full_name,
      child.email
    FROM parent_child_blocklist b
    LEFT JOIN profile child ON child.id = b.child_profile_id
    WHERE b.parent_profile_id = ?
    ORDER BY b.blocked_at DESC;`,
		[parentProfile.id]
	);

	return rows.map((row) => ({
		parent_profile_id: row.parent_profile_id,
		child_profile_id: row.child_profile_id,
		child_uuid: row.child_uuid,
		child_google_id: row.child_google_id,
		full_name: row.full_name,
		email: row.email || row.child_email,
		blocked_at: row.blocked_at,
	}));
}

async function blockChild(googleId, childRelationshipId) {
	const parentProfile = await getProfileByGoogleId(googleId);

	const relationshipId = Number(childRelationshipId);
	if (!Number.isFinite(relationshipId)) {
		throw new Error("Invalid child id");
	}

	const relationship = await getChildRelationship(
		parentProfile.id,
		relationshipId
	);
	if (!relationship) {
		throw new Error("Child not found for this parent");
	}

	const childEmail = normalizeEmail(relationship.email);

	await pool.query(
		`INSERT INTO parent_child_blocklist (parent_profile_id, child_profile_id, child_email, blocked_at)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE blocked_at = NOW(), child_email = VALUES(child_email);`,
		[parentProfile.id, relationship.child_profile_id, childEmail]
	);

	await pool.query(
		`DELETE FROM profile_child WHERE id = ? AND parent_profile_id = ?`,
		[relationshipId, parentProfile.id]
	);

	await syncHasGuardian(relationship.child_profile_id);

	return { success: true, blocked: true };
}

async function unblockChild(googleId, childProfileId, options = {}) {
	const parentProfile = await getProfileByGoogleId(googleId);
	const childProfileIdNumber = Number(childProfileId);

	if (!Number.isFinite(childProfileIdNumber)) {
		throw new Error("Invalid child id");
	}

	await pool.query(
		`DELETE FROM parent_child_blocklist WHERE parent_profile_id = ? AND child_profile_id = ?`,
		[parentProfile.id, childProfileIdNumber]
	);

	if (options.addChild) {
		await pool.query(
			`INSERT INTO profile_child (parent_profile_id, child_profile_id, invited_at, approved_at, denied_at)
       VALUES (?, ?, NOW(), NOW(), NULL)
       ON DUPLICATE KEY UPDATE invited_at = VALUES(invited_at), approved_at = VALUES(approved_at), denied_at = NULL;`,
			[parentProfile.id, childProfileIdNumber]
		);

		await syncHasGuardian(childProfileIdNumber);

		return { success: true, unblocked: true, added: true };
	}

	return { success: true, unblocked: true };
}

function normalizeEmail(email) {
	if (typeof email !== "string") return null;
	const trimmed = email.trim().toLowerCase();
	if (!trimmed) return null;
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return emailRegex.test(trimmed) ? trimmed : null;
}

async function ensureChildProfileByGoogleId(googleId) {
	const profile = await getProfileByGoogleIdService(googleId);
	if (!profile) {
		throw new Error("Child profile not found for provided google_id");
	}
	return profile;
}

async function ensureParentProfileByEmail(email) {
	const normalizedEmail = normalizeEmail(email);
	if (!normalizedEmail) {
		throw new Error("Invalid parent email");
	}

	const existingByEmail = await getProfileByEmail(normalizedEmail);
	if (existingByEmail) return existingByEmail;

	const syntheticGoogleId = `invite:${normalizedEmail}`;
	const [result] = await pool.query(
		`INSERT INTO profile 
    (uuid, google_id, email, full_name, picture, birthday, has_guardian, is_guardian, is_teacher) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			uuidv4(),
			syntheticGoogleId,
			normalizedEmail,
			null,
			null,
			null,
			null,
			true,
			false,
		]
	);

	const [rows] = await pool.query(
		`SELECT id, uuid, google_id, email, full_name, birthday, created_at, updated_at 
    FROM profile WHERE id = ? LIMIT 1;`,
		[result.insertId]
	);

	if (!rows.length) {
		throw new Error("Failed to create parent profile");
	}

	return rows[0];
}

async function inviteParentByEmail(childGoogleId, parentEmail) {
	const childProfile = await ensureChildProfileByGoogleId(childGoogleId);
	const parentProfile = await ensureParentProfileByEmail(parentEmail);

	// If this parent has blocked this child, treat the request as accepted but do not surface it.
	if (await isBlocked(parentProfile.id, childProfile.id)) {
		return { success: true, blocked: true };
	}

	await pool.query(
		`INSERT INTO profile_child (parent_profile_id, child_profile_id, invited_at, approved_at, denied_at)
    VALUES (?, ?, NOW(), NULL, NULL)
    ON DUPLICATE KEY UPDATE invited_at = NOW(), approved_at = NULL, denied_at = NULL;`,
		[parentProfile.id, childProfile.id]
	);

	await syncHasGuardian(childProfile.id);

	return {
		success: true,
		parent_profile_id: parentProfile.id,
		child_profile_id: childProfile.id,
	};
}

async function respondToInvite(googleId, childRelationshipId, action) {
	const parentProfile = await getProfileByGoogleId(googleId);

	const relationshipId = Number(childRelationshipId);
	if (!Number.isFinite(relationshipId)) {
		throw new Error("Invalid child id");
	}

	let approvedAt = null;
	let deniedAt = null;

	if (action === "approve") {
		approvedAt = new Date();
	} else if (action === "deny") {
		deniedAt = new Date();
	} else {
		throw new Error("Invalid action");
	}

	await pool.query(
		`UPDATE profile_child 
    SET approved_at = ?, denied_at = ?, invited_at = COALESCE(invited_at, NOW())
    WHERE id = ? AND parent_profile_id = ?`,
		[approvedAt, deniedAt, relationshipId, parentProfile.id]
	);

	if (action === "approve") {
		await pool.query(
			`UPDATE profile SET has_guardian = 1 WHERE id = (SELECT child_profile_id FROM profile_child WHERE id = ?)`,
			[relationshipId]
		);
	}

	return getChildRelationship(parentProfile.id, relationshipId);
}

module.exports = {
	getChildrenByGoogleId,
	addChild,
	updateChild,
	deleteChild,
	blockChild,
	getBlocklist,
	unblockChild,
	respondToInvite,
	inviteParentByEmail,
};
