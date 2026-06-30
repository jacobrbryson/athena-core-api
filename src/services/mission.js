const pool = require("../helpers/db");
const { getMissionDef } = require("../config/missions");

/**
 * Mission service.
 *
 * Backs the Guardians "Current Mission" panel. Mission 1 ("Gather the
 * Guardians") asks that at least one Guardian from every family make first
 * contact with Athena, so the panel needs a per-family onboarded status for the
 * caller's adventure.
 *
 * A "family" is not an explicit column — the roster is organised by household,
 * so we derive the family from the Guardian's surname (the last token of the
 * display name). Within a single adventure each surname maps 1:1 to a household,
 * which is exactly the grouping the mission cares about. A family counts as
 * onboarded once ANY of its members has logged in (last_login_at set).
 */

/** Last token of a display name, e.g. "Lucy Wallace" -> "Wallace". */
function surnameOf(displayName) {
	if (typeof displayName !== "string") return null;
	const parts = displayName.trim().split(/\s+/).filter(Boolean);
	return parts.length ? parts[parts.length - 1] : null;
}

/**
 * Family onboarding status for an adventure.
 *
 * @param {string} adventureKey - the caller's effective adventure.
 * @returns {Promise<Array<{key:string,name:string,region:string|null,onboarded:boolean}>>}
 *   one entry per family, sorted with pending families first then alphabetical.
 */
async function getFamilyOnboardingStatus(adventureKey) {
	if (!adventureKey) return [];

	const [rows] = await pool.query(
		`SELECT c.guardian_id, c.display_name, c.city, c.last_login_at
       FROM guardian_credential c
       JOIN guardian_adventure ga ON ga.guardian_id = c.guardian_id
      WHERE ga.adventure_key = ? AND c.is_active = 1;`,
		[adventureKey]
	);

	// Group rows into families keyed by lowercased surname.
	const families = new Map();
	for (const row of rows) {
		const surname = surnameOf(row.display_name);
		// Fall back to the guardian_id so a nameless credential still appears as
		// its own family rather than being silently dropped.
		const key = (surname || row.guardian_id).toLowerCase();
		let family = families.get(key);
		if (!family) {
			family = {
				key,
				name: surname ? `The ${surname} Family` : "Unnamed Guardian",
				region: null,
				onboarded: false,
			};
			families.set(key, family);
		}
		if (!family.region && row.city) family.region = row.city.trim();
		if (row.last_login_at != null) family.onboarded = true;
	}

	// Pending families first (the ones the Guardian should reach out to), then
	// alphabetical so the list is stable.
	return [...families.values()].sort((a, b) => {
		if (a.onboarded !== b.onboarded) return a.onboarded ? 1 : -1;
		return a.name.localeCompare(b.name);
	});
}

/* -------------------------------------------------------------------------- */
/* Cooperative missions (Mission 2 "Convergence")                             */
/* -------------------------------------------------------------------------- */

/**
 * Lowercased family key for a Guardian, derived the same way as the family
 * grouping above (surname, falling back to the guardian id).
 */
function familyKeyFor({ displayName, guardianId }) {
	const surname = surnameOf(displayName);
	return (surname || guardianId || "").toLowerCase() || null;
}

/** The fragment a given family holds for a mission, or null if not a participant. */
function getFamilyFragment(missionKey, adventureKey, familyKey) {
	const def = getMissionDef(missionKey, adventureKey);
	if (!def) return null;
	const family = def.families.find((f) => f.key === familyKey);
	return family ? family.fragment : null;
}

/**
 * The map corner a given family uncovers, or null if not a participant. This is
 * the visual reward for completing the decryption challenges; the caller only
 * ever learns their own corner (others' are withheld until the map is complete).
 */
function getFamilyCorner(missionKey, adventureKey, familyKey) {
	const def = getMissionDef(missionKey, adventureKey);
	if (!def) return null;
	const family = def.families.find((f) => f.key === familyKey);
	return family ? family.corner ?? null : null;
}

/**
 * Record a family's contribution to a cooperative mission. The stored fragment
 * is the backend-authored one for that family (clients can't spoof their piece).
 * Idempotent: re-reporting updates the same row. Returns false if the family is
 * not a participant in this mission.
 */
async function recordContribution(missionKey, adventureKey, familyKey, guardianId) {
	const def = getMissionDef(missionKey, adventureKey);
	if (!def) return false;
	const family = def.families.find((f) => f.key === familyKey);
	if (!family) return false;

	await pool.query(
		`INSERT INTO mission_contribution
       (mission_key, adventure_key, family_key, guardian_id, fragment)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE guardian_id = VALUES(guardian_id), fragment = VALUES(fragment);`,
		[missionKey, adventureKey, familyKey, guardianId, family.fragment]
	);
	return true;
}

/**
 * Whether a single family has reported its contribution for a mission. Used for
 * the caller's own status when they're a test family (and so not in the gated
 * progress list). Returns false for a null/empty family key.
 */
async function hasReported(missionKey, adventureKey, familyKey) {
	if (!familyKey) return false;
	const [rows] = await pool.query(
		`SELECT 1 FROM mission_contribution
      WHERE mission_key = ? AND adventure_key = ? AND family_key = ?
      LIMIT 1;`,
		[missionKey, adventureKey, familyKey]
	);
	return rows.length > 0;
}

/**
 * Current state of a cooperative mission for an adventure: which required
 * families have reported, overall progress, and — only once EVERY required
 * family is in — the revealed convergence point. The point is withheld until
 * the mission is complete so no family can shortcut the gate.
 *
 * @returns {Promise<object|null>} null if the mission doesn't apply here.
 */
async function getConvergenceState(missionKey, adventureKey) {
	const def = getMissionDef(missionKey, adventureKey);
	if (!def) return null;

	const [rows] = await pool.query(
		`SELECT family_key FROM mission_contribution
      WHERE mission_key = ? AND adventure_key = ?;`,
		[missionKey, adventureKey]
	);
	const reportedKeys = new Set(rows.map((r) => r.family_key));

	// Only the real families count toward progress and the "all families" gate.
	// Test families (e.g. the seeded John Doe account) can fully participate —
	// earn a piece, report, see their own corner — without skewing the real game.
	const families = def.families
		.filter((f) => !f.test)
		.map((f) => {
			const reported = reportedKeys.has(f.key);
			return {
				key: f.key,
				name: f.name,
				// A family's map corner is revealed to everyone the moment that
				// family uncovers it (reports), so the shared map fills in piece by
				// piece. Unreported corners stay withheld until earned.
				corner: reported ? f.corner ?? null : null,
				reported,
			};
		});
	const reported = families.filter((f) => f.reported).length;
	const total = families.length;
	const complete = total > 0 && reported === total;

	return {
		families,
		reported,
		total,
		complete,
		// The gathering point is no longer surfaced to players — the assembled
		// map is the payoff — but keep it server-side for potential later use.
		convergence: complete ? def.convergence : null,
	};
}

module.exports = {
	getFamilyOnboardingStatus,
	familyKeyFor,
	getFamilyFragment,
	getFamilyCorner,
	hasReported,
	recordContribution,
	getConvergenceState,
};
