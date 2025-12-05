const { v4: uuidv4 } = require("uuid");
const pool = require("../helpers/db");
const { buildUpdateClauses } = require("../helpers/query");

const allowedProfileFields = {
	email: "string",
	full_name: "string",
	birthday: "string",
	picture: "string",
	has_guardian: "boolean",
	is_guardian: "boolean",
	is_teacher: "boolean",
	profile_editing_locked: "boolean",
};

function mapProfileRow(row) {
	if (!row) return null;

	return {
		id: row.id,
		uuid: row.uuid,
		google_id: row.google_id,
		email: row.email,
		full_name: row.full_name,
		picture: row.picture,
		birthday: row.birthday,
		profile_editing_locked:
			row.profile_editing_locked === null ||
			row.profile_editing_locked === undefined
				? null
				: Boolean(row.profile_editing_locked),
		has_guardian:
			row.has_guardian === null || row.has_guardian === undefined
				? null
				: Boolean(row.has_guardian),
		is_guardian:
			row.is_guardian === null || row.is_guardian === undefined
				? null
				: Boolean(row.is_guardian),
		is_teacher:
			row.is_teacher === null || row.is_teacher === undefined
				? null
				: Boolean(row.is_teacher),
		invited_at: row.invited_at || null,
		approved_at: row.approved_at || null,
	};
}

function sanitizeInsertPayload(payload = {}) {
	return {
		email: typeof payload.email === "string" ? payload.email : null,
		full_name:
			typeof payload.full_name === "string" ? payload.full_name : null,
		picture: typeof payload.picture === "string" ? payload.picture : null,
		birthday:
			typeof payload.birthday === "string" ? payload.birthday : null,
		profile_editing_locked:
			typeof payload.profile_editing_locked === "boolean"
				? payload.profile_editing_locked
				: false,
		has_guardian:
			typeof payload.has_guardian === "boolean"
				? payload.has_guardian
				: null,
		is_guardian:
			typeof payload.is_guardian === "boolean"
				? payload.is_guardian
				: null,
		is_teacher:
			typeof payload.is_teacher === "boolean" ? payload.is_teacher : null,
	};
}

function extractUpdatableFields(payload = {}) {
	const updates = {};

	for (const [field, expectedType] of Object.entries(
		allowedProfileFields
	)) {
		const value = payload[field];
		if (typeof value === expectedType) {
			updates[field] = value;
		}
	}

	return updates;
}

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

async function getProfileByGoogleId(googleId) {
	const normalized = normalizeGoogleId(googleId);
	if (normalized === null) return null;

	const [rows] = await pool.query(
		`SELECT id, uuid, google_id, email, full_name, picture, birthday, profile_editing_locked, has_guardian, is_guardian, is_teacher 
    FROM profile 
    WHERE google_id = ? 
    ORDER BY created_at DESC 
    LIMIT 1;`,
		[normalized]
	);

	return mapProfileRow(rows[0]);
}

async function getProfileByEmail(email) {
	if (typeof email !== "string" || !email.trim()) return null;
	const normalized = email.trim().toLowerCase();

	const [rows] = await pool.query(
		`SELECT id, uuid, google_id, email, full_name, picture, birthday, profile_editing_locked, has_guardian, is_guardian, is_teacher 
    FROM profile 
    WHERE LOWER(email) = ? 
    ORDER BY created_at DESC 
    LIMIT 1;`,
		[normalized]
	);

	return mapProfileRow(rows[0]);
}

async function createProfile(googleId, payload) {
	const normalized = normalizeGoogleId(googleId);
	if (normalized === null) {
		throw new Error("Invalid google_id");
	}

	const profile = sanitizeInsertPayload(payload);
	const uuid = uuidv4();

	await pool.query(
		`INSERT INTO profile 
    (uuid, google_id, email, full_name, picture, birthday, profile_editing_locked, has_guardian, is_guardian, is_teacher) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			uuid,
			normalized,
			profile.email,
			profile.full_name,
			profile.picture,
			profile.birthday,
			profile.profile_editing_locked,
			profile.has_guardian,
			profile.is_guardian,
			profile.is_teacher,
		]
	);

	return getProfileByGoogleId(normalized);
}

async function updateProfile(googleId, payload) {
	const normalized = normalizeGoogleId(googleId);
	if (normalized === null) {
		throw new Error("Invalid google_id");
	}

	const updates = extractUpdatableFields(payload);

	if (!Object.keys(updates).length) {
		throw new Error("No valid profile fields provided to update.");
	}

	const { setClauses, values } = buildUpdateClauses(
		updates,
		allowedProfileFields
	);

	await pool.query(
		`UPDATE profile SET ${setClauses} WHERE google_id = ?`,
		[...values, normalized]
	);

	return getProfileByGoogleId(normalized);
}

async function upsertProfile(googleId, payload) {
	const existing = await getProfileByGoogleId(googleId);

	if (!existing) {
		return createProfile(googleId, payload);
	}

	return updateProfile(googleId, payload);
}

async function getGuardiansByGoogleId(childGoogleId) {
	const childProfile = await getProfileByGoogleId(childGoogleId);
	if (!childProfile || !childProfile.id) {
		throw new Error("Child profile not found");
	}

	const [rows] = await pool.query(
		`SELECT 
      p.id,
      p.uuid,
      p.google_id,
      p.email,
      p.full_name,
      p.picture,
      p.birthday,
      p.has_guardian,
      p.is_guardian,
      p.is_teacher,
      pc.invited_at,
      pc.approved_at
    FROM profile_child pc
    JOIN profile p ON p.id = pc.parent_profile_id
    WHERE pc.child_profile_id = ? AND pc.deleted_at IS NULL
    ORDER BY pc.created_at DESC;`,
		[childProfile.id]
	);

	return rows.map(mapProfileRow).filter(Boolean);
}

module.exports = {
	getProfileByGoogleId,
	getProfileByEmail,
	createProfile,
	updateProfile,
	upsertProfile,
	getGuardiansByGoogleId,
};
