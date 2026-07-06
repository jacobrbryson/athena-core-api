const pool = require("../helpers/db");
const { getMissionDef } = require("../config/missions");

const LAKE_NORMAN_ADVENTURE = "lake_norman_guardians";
const PORTICO_MISSION = "mission-2-portico";
const FINAL_CIPHER = "YP2LBHM7";

const RATATOUILLE_ADVENTURE = "rescue_ratatouille";
const TRAIL_MISSION = "mission-1-ratatouille-trail";

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
/* Lake Norman mission progression                                             */
/* -------------------------------------------------------------------------- */

function messageSignalsBottleDiscovery(message) {
	if (typeof message !== "string") return false;
	const normalized = message.toLowerCase();
	if (/\bportico\b/i.test(message)) return true;
	const discoveryContext =
		/\b(found|find|washed|shore|beach|lake|floating|note|message|clue|logo|guardian)\b/.test(
			normalized
		);
	if (/\bbottle\b/.test(normalized) && discoveryContext) return true;
	return (
		/\b(note|message|clue)\b/.test(normalized) &&
		/\b(washed|ashore|shore|beach|guardian|logo)\b/.test(normalized)
	);
}

function messageContainsFinalCipher(message) {
	if (typeof message !== "string") return false;
	return message.toUpperCase().split(/[^A-Z0-9]+/).includes(FINAL_CIPHER);
}

async function getCampaignMissionPhase(adventureKey) {
	if (adventureKey !== LAKE_NORMAN_ADVENTURE) return null;
	const [rows] = await pool.query(
		`SELECT mission_key, status, started_at, decrypting_at
       FROM guardian_mission_state
      WHERE adventure_key = ?
      LIMIT 1;`,
		[adventureKey]
	);
	if (!rows.length) {
		return { missionKey: "mission-0-check-in", phase: "check_in" };
	}
	return {
		missionKey: rows[0].mission_key,
		phase: rows[0].status,
		startedAt: rows[0].started_at,
		decryptingAt: rows[0].decrypting_at,
	};
}

/**
 * Apply message-driven mission transitions. The phase at the start of the turn
 * controls what can happen, so the final cipher cannot skip the PORTICO step.
 */
async function applyMessageTransition(adventureKey, guardianId, message) {
	if (adventureKey !== LAKE_NORMAN_ADVENTURE) return null;
	const current = await getCampaignMissionPhase(adventureKey);

	if (current.phase === "check_in" && messageSignalsBottleDiscovery(message)) {
		await pool.query(
			`INSERT IGNORE INTO guardian_mission_state
         (adventure_key, mission_key, status, started_by_guardian_id)
       VALUES (?, ?, 'active', ?);`,
			[adventureKey, PORTICO_MISSION, guardianId]
		);
		return "started";
	}

	if (current.phase === "active" && messageContainsFinalCipher(message)) {
		const [result] = await pool.query(
			`UPDATE guardian_mission_state
          SET status = 'decrypting', decrypting_at = UTC_TIMESTAMP()
        WHERE adventure_key = ? AND mission_key = ? AND status = 'active';`,
			[adventureKey, PORTICO_MISSION]
		);
		return result.affectedRows > 0 ? "decrypting" : null;
	}

	return null;
}

async function getMissionPromptContext(adventureKey, transition = null) {
	const state = await getCampaignMissionPhase(adventureKey);
	if (!state) return null;

	if (state.phase === "check_in") {
		const families = await getFamilyOnboardingStatus(adventureKey);
		return {
			id: state.missionKey,
			title: "Gather the Guardians",
			phase: state.phase,
			directive: "Help the remaining Guardian families make first contact with Athena.",
			pendingFamilies: families
				.filter((family) => !family.onboarded)
				.map((family) =>
					family.region ? `${family.name} (${family.region})` : family.name
				),
		};
	}

	return {
		id: PORTICO_MISSION,
		title: "The Portico Signal",
		phase: state.phase,
		transition,
		directive:
			state.phase === "decrypting"
				? "Athena is decrypting the recovered message."
				: "Guide the Guardians through the recovered field clue without solving it for them.",
	};
}

/* -------------------------------------------------------------------------- */
/* Rescue Ratatouille Mission 1 — "The Trail to Ratatouille"                  */
/*                                                                            */
/* Ten physical clue cards (Guardians logo + a four-character key) are hidden */
/* around the property. Any valid unused key unlocks the NEXT trail leg, in   */
/* strict order; each key works once. Unlocking is a two-step: reporting the  */
/* key creates a 'pending' row, and completing the decryption challenges in   */
/* the Guardians app flips it to 'used' and reveals the clue. Progress is per */
/* guardian credential so the test account never disturbs the real team.     */
/* -------------------------------------------------------------------------- */

/** The trail definition for an adventure, or null if it doesn't apply. */
function getTrailDef(adventureKey) {
	const def = getMissionDef(TRAIL_MISSION, adventureKey);
	return def && def.objective === "trail" ? def : null;
}

/** Uppercased key, or null if it can't be one (keys are 4 alphanumerics). */
function normalizeTrailKey(raw) {
	const key = typeof raw === "string" ? raw.trim().toUpperCase() : "";
	return /^[A-Z0-9]{4}$/.test(key) ? key : null;
}

/**
 * Challenges required to decrypt a clue. Three keeps a run fun and quick;
 * the final stretch asks for one more so the ending feels earned.
 */
function trailChallengeCount(clueIndex, totalClues) {
	return clueIndex >= totalClues - 2 ? 4 : 3;
}

/** The player-facing payload for one unlocked trail leg. */
function trailCluePayload(def, index) {
	const clue = def.clues[index];
	if (!clue) return null;
	const from = index > 0 ? def.clues[index - 1].description : null;
	const text =
		index === 0
			? `THE TRAIL BEGINS AT THE ${clue.description.toUpperCase()}.`
			: `FROM ${from.toUpperCase()}: WALK ${clue.distance} METERS AT BEARING ${clue.bearing} DEGREES — ${clue.description.toUpperCase()}.`;
	return {
		index,
		distance: clue.distance,
		bearing: clue.bearing,
		description: clue.description,
		text,
	};
}

/** All key-use rows for a guardian, oldest clue first. */
async function loadTrailRows(guardianId) {
	const [rows] = await pool.query(
		`SELECT key_code, clue_index, status FROM guardian_trail_key
      WHERE guardian_id = ? AND mission_key = ?
      ORDER BY clue_index;`,
		[guardianId, TRAIL_MISSION]
	);
	return rows;
}

/**
 * Live trail state for the Current Mission panel: unlocked clues (in order),
 * the key currently awaiting decryption (if any), and overall progress.
 * Returns null for adventures without a trail mission.
 */
async function getTrailState(adventureKey, guardianId) {
	const def = getTrailDef(adventureKey);
	if (!def || !guardianId) return null;

	const rows = await loadTrailRows(guardianId);
	const used = rows.filter((r) => r.status === "used");
	const pendingRow = rows.find((r) => r.status === "pending");

	return {
		keysTotal: def.keys.length,
		keysUsed: used.length,
		complete: used.length >= def.keys.length,
		clues: used.map((r) => trailCluePayload(def, r.clue_index)).filter(Boolean),
		pending: pendingRow
			? {
					keyCode: pendingRow.key_code,
					clueIndex: pendingRow.clue_index,
					clue: trailCluePayload(def, pendingRow.clue_index),
					challenges: trailChallengeCount(pendingRow.clue_index, def.clues.length),
			  }
			: null,
	};
}

/**
 * Report a decryption key. Any valid unused key claims the NEXT clue in order
 * and goes 'pending' until the decryption challenges are completed. Re-reporting
 * the same pending key resumes it; a second key while one is pending is refused
 * (finishing the current decryption keeps unlocks strictly ordered).
 *
 * @returns {Promise<object>} { ok:true, clueIndex, clue, challenges } or
 *   { ok:false, reason: 'invalid'|'used'|'pending_other'|'complete'|'retry' }.
 */
async function reportTrailKey(adventureKey, guardianId, rawKey) {
	const def = getTrailDef(adventureKey);
	if (!def || !guardianId) return { ok: false, reason: "invalid" };

	const key = normalizeTrailKey(rawKey);
	if (!key || !def.keys.includes(key)) return { ok: false, reason: "invalid" };

	const rows = await loadTrailRows(guardianId);
	const existing = rows.find((r) => r.key_code === key);
	if (existing?.status === "used") return { ok: false, reason: "used" };

	const respond = (clueIndex) => ({
		ok: true,
		clueIndex,
		clue: trailCluePayload(def, clueIndex),
		challenges: trailChallengeCount(clueIndex, def.clues.length),
	});

	// Resuming the key already mid-decryption (e.g. after a refresh).
	if (existing?.status === "pending") return respond(existing.clue_index);

	if (rows.some((r) => r.status === "pending")) {
		return { ok: false, reason: "pending_other" };
	}
	if (rows.length >= def.clues.length) return { ok: false, reason: "complete" };

	const clueIndex = rows.length;
	try {
		await pool.query(
			`INSERT INTO guardian_trail_key
         (guardian_id, mission_key, key_code, clue_index, status)
       VALUES (?, ?, ?, ?, 'pending');`,
			[guardianId, TRAIL_MISSION, key, clueIndex]
		);
	} catch (err) {
		// Two devices raced for the same clue index — one won; ask to retry.
		if (err && err.code === "ER_DUP_ENTRY") return { ok: false, reason: "retry" };
		throw err;
	}
	return respond(clueIndex);
}

/**
 * Complete the decryption for a reported key: flips pending → used and reveals
 * the clue. Idempotent — completing an already-used key re-returns its clue.
 */
async function completeTrailKey(adventureKey, guardianId, rawKey) {
	const def = getTrailDef(adventureKey);
	if (!def || !guardianId) return { ok: false, reason: "invalid" };

	const key = normalizeTrailKey(rawKey);
	if (!key) return { ok: false, reason: "invalid" };

	const rows = await loadTrailRows(guardianId);
	const row = rows.find((r) => r.key_code === key);
	if (!row) return { ok: false, reason: "not_reported" };

	if (row.status !== "used") {
		await pool.query(
			`UPDATE guardian_trail_key
          SET status = 'used', used_at = NOW()
        WHERE guardian_id = ? AND mission_key = ? AND key_code = ? AND status = 'pending';`,
			[guardianId, TRAIL_MISSION, key]
		);
	}
	return { ok: true, clue: trailCluePayload(def, row.clue_index) };
}

/** Wipe a guardian's trail progress (testing/staging). Returns rows removed. */
async function resetTrail(guardianId) {
	if (!guardianId) return 0;
	const [result] = await pool.query(
		`DELETE FROM guardian_trail_key WHERE guardian_id = ? AND mission_key = ?;`,
		[guardianId, TRAIL_MISSION]
	);
	return result.affectedRows || 0;
}

/** The first valid trail key mentioned in a chat message, or null. */
function findTrailKeyInMessage(def, message) {
	if (typeof message !== "string") return null;
	const tokens = message.toUpperCase().split(/[^A-Z0-9]+/);
	return tokens.find((t) => def.keys.includes(t)) || null;
}

/**
 * Chat-driven trail transitions: a Guardian can "report to Athena" by simply
 * typing (or speaking) a key in conversation. A valid new key is accepted and
 * parked pending — the decryption still happens in the Current Mission panel —
 * and the returned transition tells the prompt builder what just happened.
 */
async function applyTrailMessageTransition(adventureKey, guardianId, message) {
	const def = getTrailDef(adventureKey);
	if (!def || !guardianId) return null;

	const key = findTrailKeyInMessage(def, message);
	if (!key) return null;

	const result = await reportTrailKey(adventureKey, guardianId, key);
	if (result.ok) return "key_accepted";
	if (result.reason === "used") return "key_duplicate";
	if (result.reason === "pending_other") return "key_pending_other";
	return null;
}

/**
 * Athena's steering context for the trail mission — progress plus any chat
 * transition, consumed by the prompt builder (see controllers/prompt.js).
 */
async function getTrailPromptContext(adventureKey, guardianId, transition = null) {
	const state = await getTrailState(adventureKey, guardianId);
	if (!state) return null;
	const latest = state.clues.length ? state.clues[state.clues.length - 1] : null;
	return {
		id: TRAIL_MISSION,
		title: "The Trail to Ratatouille",
		directive:
			"Find the ten Guardian clue cards hidden around the property. Each key unlocks the next leg of the trail.",
		phase: state.complete ? "trail_complete" : "key_hunt",
		transition,
		keysUsed: state.keysUsed,
		keysTotal: state.keysTotal,
		pendingDecryption: !!state.pending,
		latestClueDescription: latest ? latest.description : null,
	};
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
	LAKE_NORMAN_ADVENTURE,
	PORTICO_MISSION,
	FINAL_CIPHER,
	RATATOUILLE_ADVENTURE,
	TRAIL_MISSION,
	getTrailState,
	reportTrailKey,
	completeTrailKey,
	resetTrail,
	applyTrailMessageTransition,
	getTrailPromptContext,
	getFamilyOnboardingStatus,
	messageSignalsBottleDiscovery,
	messageContainsFinalCipher,
	getCampaignMissionPhase,
	applyMessageTransition,
	getMissionPromptContext,
	familyKeyFor,
	getFamilyFragment,
	getFamilyCorner,
	hasReported,
	recordContribution,
	getConvergenceState,
};
