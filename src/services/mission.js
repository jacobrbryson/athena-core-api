const pool = require("../helpers/db");
const { getMissionDef, getIndexDef: getIndexDefFor } = require("../config/missions");

const LAKE_NORMAN_ADVENTURE = "lake_norman_guardians";
const PORTICO_MISSION = "mission-2-portico";
const FINAL_CIPHER = "YP2LBHM7";

const RATATOUILLE_ADVENTURE = "rescue_ratatouille";
const TRAIL_MISSION = "mission-1-ratatouille-trail";

const INDEX_MISSION = "mission-3-first-watch";

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

/* -------------------------------------------------------------------------- */
/* Mission 3 "The First Watch" — the shared index                             */
/*                                                                            */
/* ~28 physical cards, each with a four-character code, hidden across the      */
/* property and the surrounding family houses. Reporting a code returns that   */
/* card's 1963 record fragment.                                                */
/*                                                                            */
/* The defining difference from the Ratatouille trail: the index belongs to    */
/* the NETWORK, not to a guardian. guardian_index_find's primary key omits     */
/* guardian_id entirely, so one Guardian reporting a code advances the index   */
/* for EVERY Guardian at once — which is exactly how the trail mission should  */
/* have behaved and didn't. Order doesn't matter either: each record reads on  */
/* its own, and the story assembles through convergences that fire on SETS of  */
/* held entries rather than on any single card.                                */
/* -------------------------------------------------------------------------- */

/** The index definition for an adventure, or null if it doesn't apply. */
function getIndexDef(adventureKey) {
	return getIndexDefFor(INDEX_MISSION, adventureKey);
}

/** Uppercased code, or null if it can't be one (codes are 4 alphanumerics). */
function normalizeIndexCode(raw) {
	const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
	return /^[A-Z0-9]{4}$/.test(code) ? code : null;
}

/** The entry a code belongs to, or null. */
function indexEntryByCode(def, code) {
	return def.entries.find((e) => e.code === code) || null;
}

/**
 * The player-facing shape of an entry. Deliberately drops `note` (Athena's
 * private steering), `reverse` (the back of the two-sided F-27 card, which
 * Athena must not know about until a Guardian physically turns it over) and
 * `decoy` (which would give away which lock digits are real).
 */
function indexEntryPayload(entry, row) {
	return {
		id: entry.id,
		act: entry.act,
		type: entry.type,
		title: entry.title,
		record: entry.record,
		foundBy: row ? row.found_by_guardian_id : null,
		foundAt: row ? row.found_at : null,
	};
}

/** Every code this adventure has found, oldest first. */
async function loadIndexFinds(adventureKey) {
	const [rows] = await pool.query(
		`SELECT code, entry_id, found_by_guardian_id, found_at
       FROM guardian_index_find
      WHERE mission_key = ? AND adventure_key = ?
      ORDER BY found_at, code;`,
		[INDEX_MISSION, adventureKey]
	);
	return rows;
}

/** Convergence ids that have already fired for this adventure. */
async function loadFiredConvergences(adventureKey) {
	const [rows] = await pool.query(
		`SELECT convergence_id FROM guardian_index_convergence
      WHERE mission_key = ? AND adventure_key = ?;`,
		[INDEX_MISSION, adventureKey]
	);
	return rows.map((r) => r.convergence_id);
}

/** Whether a convergence's requirements are met by the held entries. */
function convergenceSatisfied(conv, foundIds, firedIds) {
	if (Array.isArray(conv.requiresAll)) {
		if (!conv.requiresAll.every((id) => foundIds.has(id))) return false;
	}
	if (conv.requiresAny) {
		const hits = conv.requiresAny.of.filter((id) => foundIds.has(id)).length;
		if (hits < conv.requiresAny.count) return false;
	}
	if (Array.isArray(conv.requiresConvergence)) {
		if (!conv.requiresConvergence.every((id) => firedIds.has(id))) return false;
	}
	return true;
}

/**
 * Fire any convergences the network has newly earned and record them so they
 * only ever land once. Returns the newly fired ones (in config order) so the
 * caller can hand them to Athena on the same turn.
 */
async function fireNewConvergences(def, adventureKey, foundIds, alreadyFired) {
	const firedIds = new Set(alreadyFired);
	const newly = [];

	// Sequential rather than parallel: FINALE_UNLOCK depends on CONVERGENCE_III
	// having fired, so a convergence must be able to see one that fired earlier
	// in this same pass.
	for (const conv of def.convergences) {
		if (firedIds.has(conv.id)) continue;
		if (!convergenceSatisfied(conv, foundIds, firedIds)) continue;

		const [result] = await pool.query(
			`INSERT IGNORE INTO guardian_index_convergence
         (mission_key, adventure_key, convergence_id)
       VALUES (?, ?, ?);`,
			[INDEX_MISSION, adventureKey, conv.id]
		);
		// affectedRows 0 means another device won the race — it has already been
		// delivered, so don't deliver it twice.
		if (result.affectedRows > 0) newly.push(conv);
		firedIds.add(conv.id);
	}
	return newly;
}

/** The act the network is currently in, from the convergences it has fired. */
function currentAct(def, firedIds) {
	let act = 1;
	for (const conv of def.convergences) {
		if (firedIds.has(conv.id) && conv.act > act) act = conv.act;
	}
	return act;
}

/**
 * Live index state for the whole adventure. Shared by every Guardian — the
 * panel renders identically on all eight phones.
 */
async function getIndexState(adventureKey) {
	const def = getIndexDef(adventureKey);
	if (!def) return null;

	const [rows, fired] = await Promise.all([
		loadIndexFinds(adventureKey),
		loadFiredConvergences(adventureKey),
	]);
	const byCode = new Map(rows.map((r) => [r.code, r]));
	const firedIds = new Set(fired);

	const entries = def.entries
		.filter((e) => byCode.has(e.code))
		.map((e) => indexEntryPayload(e, byCode.get(e.code)))
		.sort((a, b) => new Date(a.foundAt) - new Date(b.foundAt));

	return {
		found: rows.length,
		total: def.entries.length,
		complete: rows.length >= def.entries.length,
		act: currentAct(def, firedIds),
		entries,
		firedConvergences: fired,
	};
}

/**
 * Report a found card code. Any valid code works at any time — there is no
 * ordering — and a code already claimed by ANOTHER Guardian is not an error:
 * the card is simply already in the shared index, and we say who found it.
 *
 * @returns {Promise<object>} { ok:true, entry, alreadyFound, newConvergences,
 *   progress } or { ok:false, reason:'invalid' }.
 */
function clueHintFor(def, entryId) {
	const configured = def?.clueHints?.[entryId];
	if (typeof configured === "string") return { text: configured };
	return configured && typeof configured.text === "string" ? configured : null;
}

function clueIsEligible(def, entryId, foundIds, firedIds) {
	if (foundIds.has(entryId)) return false;
	const hint = clueHintFor(def, entryId);
	if (!hint) return false;
	return !hint.requiresConvergence || firedIds.has(hint.requiresConvergence);
}

async function loadIndexClueRow(adventureKey, guardianId) {
	const [rows] = await pool.query(
		`SELECT target_entry_id, status, issued_at, revealed_at
       FROM guardian_index_clue
      WHERE mission_key = ? AND adventure_key = ? AND guardian_id = ?
      LIMIT 1;`,
		[INDEX_MISSION, adventureKey, guardianId]
	);
	return rows[0] || null;
}

async function chooseUnfoundClueTarget(def, adventureKey, foundIds, firedIds) {
	const eligible = def.entries.filter((entry) =>
		clueIsEligible(def, entry.id, foundIds, firedIds)
	);
	if (!eligible.length) return null;
	const [rows] = await pool.query(
		`SELECT target_entry_id, COUNT(*) AS assignments
       FROM guardian_index_clue
      WHERE mission_key = ? AND adventure_key = ? AND status = 'pending'
      GROUP BY target_entry_id;`,
		[INDEX_MISSION, adventureKey]
	);
	const counts = new Map(
		rows.map((row) => [row.target_entry_id, Number(row.assignments) || 0])
	);
	return eligible.reduce((best, entry) =>
		(counts.get(entry.id) || 0) < (counts.get(best.id) || 0) ? entry : best
	);
}

async function savePendingIndexClue(adventureKey, guardianId, targetEntryId) {
	await pool.query(
		`INSERT INTO guardian_index_clue
       (mission_key, adventure_key, guardian_id, target_entry_id, status, issued_at, revealed_at)
     VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, NULL)
     ON DUPLICATE KEY UPDATE
       target_entry_id = VALUES(target_entry_id),
       status = 'pending',
       issued_at = CURRENT_TIMESTAMP,
       revealed_at = NULL;`,
		[INDEX_MISSION, adventureKey, guardianId, targetEntryId]
	);
	return { pending: true, challenges: 3 };
}

async function issueIndexClue(adventureKey, guardianId) {
	const def = getIndexDef(adventureKey);
	if (!def || !guardianId) return null;
	const [row, finds, fired] = await Promise.all([
		loadIndexClueRow(adventureKey, guardianId),
		loadIndexFinds(adventureKey),
		loadFiredConvergences(adventureKey),
	]);
	const foundIds = new Set(finds.map((find) => find.entry_id));
	const firedIds = new Set(fired);
	if (
		row?.status === "pending" &&
		clueIsEligible(def, row.target_entry_id, foundIds, firedIds)
	) {
		return { pending: true, challenges: 3 };
	}
	const target = await chooseUnfoundClueTarget(
		def,
		adventureKey,
		foundIds,
		firedIds
	);
	return target
		? savePendingIndexClue(adventureKey, guardianId, target.id)
		: null;
}

async function getIndexClueState(adventureKey, guardianId) {
	const def = getIndexDef(adventureKey);
	if (!def || !guardianId) return null;
	const [row, finds, fired] = await Promise.all([
		loadIndexClueRow(adventureKey, guardianId),
		loadIndexFinds(adventureKey),
		loadFiredConvergences(adventureKey),
	]);
	if (!row || row.status !== "pending") return null;
	const foundIds = new Set(finds.map((find) => find.entry_id));
	const firedIds = new Set(fired);
	if (clueIsEligible(def, row.target_entry_id, foundIds, firedIds)) {
		return { pending: true, challenges: 3 };
	}
	const target = await chooseUnfoundClueTarget(
		def,
		adventureKey,
		foundIds,
		firedIds
	);
	return target
		? savePendingIndexClue(adventureKey, guardianId, target.id)
		: null;
}

async function completeIndexClue(adventureKey, guardianId) {
	const def = getIndexDef(adventureKey);
	if (!def || !guardianId) return { ok: false, reason: "invalid" };
	const [row, finds, fired] = await Promise.all([
		loadIndexClueRow(adventureKey, guardianId),
		loadIndexFinds(adventureKey),
		loadFiredConvergences(adventureKey),
	]);
	if (!row || row.status !== "pending") {
		return { ok: false, reason: "none_pending" };
	}
	const foundIds = new Set(finds.map((find) => find.entry_id));
	const firedIds = new Set(fired);
	let targetId = row.target_entry_id;
	if (!clueIsEligible(def, targetId, foundIds, firedIds)) {
		const replacement = await chooseUnfoundClueTarget(
			def,
			adventureKey,
			foundIds,
			firedIds
		);
		if (!replacement) return { ok: false, reason: "complete" };
		targetId = replacement.id;
	}
	const hint = clueHintFor(def, targetId);
	await pool.query(
		`UPDATE guardian_index_clue
        SET target_entry_id = ?, status = 'revealed', revealed_at = CURRENT_TIMESTAMP
      WHERE mission_key = ? AND adventure_key = ? AND guardian_id = ?;`,
		[targetId, INDEX_MISSION, adventureKey, guardianId]
	);
	return { ok: true, clue: { text: hint.text } };
}

async function reportIndexCode(adventureKey, guardianId, rawCode) {
	const def = getIndexDef(adventureKey);
	if (!def || !guardianId) return { ok: false, reason: "invalid" };

	const code = normalizeIndexCode(rawCode);
	const entry = code ? indexEntryByCode(def, code) : null;
	if (!entry) return { ok: false, reason: "invalid" };

	const [result] = await pool.query(
		`INSERT IGNORE INTO guardian_index_find
       (mission_key, adventure_key, code, entry_id, found_by_guardian_id)
     VALUES (?, ?, ?, ?, ?);`,
		[INDEX_MISSION, adventureKey, code, entry.id, guardianId]
	);
	const alreadyFound = result.affectedRows === 0;

	const [rows, fired] = await Promise.all([
		loadIndexFinds(adventureKey),
		loadFiredConvergences(adventureKey),
	]);
	const foundIds = new Set(rows.map((r) => r.entry_id));
	const newConvergences = await fireNewConvergences(
		def,
		adventureKey,
		foundIds,
		fired
	);
	const firedIds = new Set([...fired, ...newConvergences.map((c) => c.id)]);
	const row = rows.find((r) => r.code === code) || null;

	return {
		ok: true,
		alreadyFound,
		entry: indexEntryPayload(entry, row),
		newConvergences: newConvergences.map((c) => ({
			id: c.id,
			title: c.title,
			body: c.body,
		})),
		progress: {
			found: rows.length,
			total: def.entries.length,
			complete: rows.length >= def.entries.length,
			act: currentAct(def, firedIds),
		},
	};
}

/** The first valid index code mentioned in a chat message, or null. */
function findIndexCodeInMessage(def, message) {
	if (typeof message !== "string") return null;
	const codes = new Set(def.entries.map((e) => e.code));
	const tokens = message.toUpperCase().split(/[^A-Z0-9]+/);
	return tokens.find((t) => codes.has(t)) || null;
}

/**
 * Chat-driven reporting: a Guardian reads Athena a code and it counts. This is
 * the primary interface for Mission 3 — Mission 2 proved the kids much prefer
 * typing the code straight into the conversation over using a panel.
 */
async function applyIndexMessageTransition(adventureKey, guardianId, message) {
	const def = getIndexDef(adventureKey);
	if (!def || !guardianId) return null;

	const code = findIndexCodeInMessage(def, message);
	if (!code) return null;

	const result = await reportIndexCode(adventureKey, guardianId, code);
	if (!result.ok) return null;
	return {
		kind: result.alreadyFound ? "code_duplicate" : "code_accepted",
		entry: result.entry,
		newConvergences: result.newConvergences,
		progress: result.progress,
	};
}

/**
 * Athena's steering context for the index mission. Only entries the network has
 * ACTUALLY FOUND are included — an unfound entry must not exist as far as the
 * model is concerned, so it can't be summarized, hinted at, or leaked.
 */
async function getIndexPromptContext(adventureKey, guardianId, transition = null) {
	const def = getIndexDef(adventureKey);
	if (!def) return null;

	const state = await getIndexState(adventureKey);
	if (!state) return null;

	const byId = new Map(def.entries.map((e) => [e.id, e]));
	const foundEntries = state.entries.map((e) => ({
		id: e.id,
		title: e.title,
		record: e.record,
		// Athena's private steering for this card — how to play it, including the
		// scripted failures. Never rendered to a client.
		note: byId.get(e.id)?.note ?? null,
		foundBy: e.foundBy,
	}));

	const latest = state.entries.length
		? state.entries[state.entries.length - 1]
		: null;

	return {
		id: INDEX_MISSION,
		title: "The First Watch",
		phase: state.complete ? "index_complete" : "index_hunt",
		act: state.act,
		transition: transition ? transition.kind : null,
		foundCount: state.found,
		total: state.total,
		foundEntries,
		latestEntry: transition?.entry
			? {
					id: transition.entry.id,
					title: transition.entry.title,
					record: transition.entry.record,
					note: byId.get(transition.entry.id)?.note ?? null,
					foundBy: transition.entry.foundBy,
			  }
			: latest,
		newConvergences: transition?.newConvergences ?? [],
		// The tell (§3 of the design doc) this card is scripted to carry, if any.
		// Config-fired only — Athena never improvises the sentience layer.
		pendingTell: transition?.entry
			? byId.get(transition.entry.id)?.tell ?? null
			: null,
		directive:
			"The Guardians find the cards; you read what's on them. Never reveal, summarize, or hint at an entry they have not found.",
	};
}

/** Wipe the adventure's whole index (testing/staging). Returns rows removed. */
async function resetIndex(adventureKey) {
	if (!adventureKey) return 0;
	const [finds] = await pool.query(
		`DELETE FROM guardian_index_find WHERE mission_key = ? AND adventure_key = ?;`,
		[INDEX_MISSION, adventureKey]
	);
	await pool.query(
		`DELETE FROM guardian_index_convergence WHERE mission_key = ? AND adventure_key = ?;`,
		[INDEX_MISSION, adventureKey]
	);
	await pool.query(
		`DELETE FROM guardian_index_clue WHERE mission_key = ? AND adventure_key = ?;`,
		[INDEX_MISSION, adventureKey]
	);
	return finds.affectedRows || 0;
}

module.exports = {
	LAKE_NORMAN_ADVENTURE,
	PORTICO_MISSION,
	FINAL_CIPHER,
	RATATOUILLE_ADVENTURE,
	TRAIL_MISSION,
	INDEX_MISSION,
	getIndexDef,
	normalizeIndexCode,
	findIndexCodeInMessage,
	getIndexState,
	getIndexClueState,
	issueIndexClue,
	completeIndexClue,
	reportIndexCode,
	applyIndexMessageTransition,
	getIndexPromptContext,
	resetIndex,
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
