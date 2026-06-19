const pool = require("../helpers/db");
const { withTransaction, getProfileByGoogleId } = require("./parent-helpers");
const { getFamilyForProfile, createFamily } = require("./family");

/**
 * Parental consent service (Phase 2).
 *
 * Tracks the current acceptance snapshot per family/consent type in
 * `family_consent` and an append-only audit trail in `family_consent_log`.
 */

const CONSENT_TYPES = new Set([
	"privacy_policy",
	"ai_disclosure",
	"terms_of_service",
]);

function normalizeConsentType(value) {
	if (typeof value !== "string") return null;
	const v = value.trim().toLowerCase();
	return CONSENT_TYPES.has(v) ? v : null;
}

/** Ensure the parent has a family, creating one if needed. Returns family id. */
async function ensureFamilyId(googleId, conn) {
	const parent = await getProfileByGoogleId(googleId, conn);
	let family = await getFamilyForProfile(parent.id, conn);
	if (!family) {
		// createFamily runs its own transaction; call it outside this one.
		await createFamily(googleId);
		family = await getFamilyForProfile(parent.id, conn);
	}
	return { parentId: parent.id, familyId: family ? family.id : null };
}

/**
 * Record (or re-affirm) a consent acceptance for the parent's family.
 * @param {object} meta { ip, userAgent }
 */
async function recordConsent(googleId, payload = {}, meta = {}) {
	const consentType = normalizeConsentType(payload.consent_type);
	if (!consentType) {
		throw new Error("Invalid consent_type");
	}
	const documentVersion =
		typeof payload.document_version === "string"
			? payload.document_version.slice(0, 40)
			: "1.0";
	const ip = typeof meta.ip === "string" ? meta.ip.slice(0, 64) : null;
	const userAgent =
		typeof meta.userAgent === "string" ? meta.userAgent.slice(0, 255) : null;

	// Resolve family (may create one) before the write transaction.
	const parent = await getProfileByGoogleId(googleId);
	let family = await getFamilyForProfile(parent.id);
	if (!family) {
		await createFamily(googleId);
		family = await getFamilyForProfile(parent.id);
	}
	if (!family) throw new Error("Unable to resolve family for consent");

	return withTransaction(async (conn) => {
		await conn.query(
			`INSERT INTO family_consent
       (family_id, consent_type, document_version, accepted_by_profile_id, accepted_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, NOW(), ?, ?)
       ON DUPLICATE KEY UPDATE
         document_version = VALUES(document_version),
         accepted_by_profile_id = VALUES(accepted_by_profile_id),
         accepted_at = NOW(),
         ip_address = VALUES(ip_address),
         user_agent = VALUES(user_agent);`,
			[family.id, consentType, documentVersion, parent.id, ip, userAgent]
		);

		await conn.query(
			`INSERT INTO family_consent_log
       (family_id, consent_type, document_version, action, actor_profile_id, ip_address, user_agent)
       VALUES (?, ?, ?, 'accepted', ?, ?, ?);`,
			[family.id, consentType, documentVersion, parent.id, ip, userAgent]
		);

		return getConsentSnapshot(family.id, conn);
	});
}

async function getConsentSnapshot(familyId, conn = pool) {
	const [rows] = await conn.query(
		`SELECT consent_type, document_version, accepted_at, accepted_by_profile_id
     FROM family_consent WHERE family_id = ?;`,
		[familyId]
	);
	const byType = {};
	for (const r of rows) {
		byType[r.consent_type] = {
			accepted: true,
			document_version: r.document_version,
			accepted_at: r.accepted_at,
		};
	}
	const required = ["privacy_policy", "ai_disclosure"];
	return {
		consents: byType,
		privacy_accepted_at: byType.privacy_policy?.accepted_at || null,
		ai_disclosure_accepted_at: byType.ai_disclosure?.accepted_at || null,
		all_required_accepted: required.every((t) => byType[t]?.accepted),
	};
}

/** Consent status for the parent's family. */
async function getConsentStatus(googleId) {
	const parent = await getProfileByGoogleId(googleId);
	const family = await getFamilyForProfile(parent.id);
	if (!family) {
		return {
			consents: {},
			privacy_accepted_at: null,
			ai_disclosure_accepted_at: null,
			all_required_accepted: false,
		};
	}
	return getConsentSnapshot(family.id);
}

/** Audit history (most recent first) for the parent's family. */
async function getConsentHistory(googleId, limit = 100) {
	const parent = await getProfileByGoogleId(googleId);
	const family = await getFamilyForProfile(parent.id);
	if (!family) return [];
	const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
	const [rows] = await pool.query(
		`SELECT l.consent_type, l.document_version, l.action, l.created_at,
            p.full_name AS actor_name, p.email AS actor_email
     FROM family_consent_log l
     LEFT JOIN profile p ON p.id = l.actor_profile_id
     WHERE l.family_id = ?
     ORDER BY l.created_at DESC
     LIMIT ?;`,
		[family.id, safeLimit]
	);
	return rows.map((r) => ({
		consent_type: r.consent_type,
		document_version: r.document_version,
		action: r.action,
		actor: r.actor_name || r.actor_email || "Parent",
		created_at: r.created_at,
	}));
}

module.exports = {
	CONSENT_TYPES,
	recordConsent,
	getConsentStatus,
	getConsentHistory,
	getConsentSnapshot,
};
