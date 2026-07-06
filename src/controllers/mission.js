const missionService = require("../services/mission");
const config = require("../config");
const { decodeGuardianFromRequest: decodeGuardian } = require("../helpers/guardianToken");
const { broadcastToGuardian } = require("../websocket/wsServer");

/**
 * Nudge every device this guardian credential has open (the family shares one
 * credential across several tablets/phones) to re-fetch the trail mission.
 * Ping-only — clients respond with GET /mission/current, so what they render
 * is always the server's authoritative state, never a stale pushed payload.
 */
function notifyTrailChanged(guardianId) {
	try {
		broadcastToGuardian(guardianId, { rpc: "trailUpdate" });
	} catch (err) {
		console.warn("[mission] trailUpdate broadcast failed:", err.message);
	}
}

/**
 * GET /api/v1/mission/families
 * Per-family onboarding status for the calling Guardian's adventure. Powers the
 * "Current Mission" panel (Mission 1: at least one Guardian from every family
 * makes first contact).
 */
async function getMissionFamilies(req, res) {
	const guardian = decodeGuardian(req);
	if (!guardian) {
		return res
			.status(401)
			.json({ success: false, message: "Guardian session required" });
	}

	try {
		const families = await missionService.getFamilyOnboardingStatus(
			guardian.adventure_key
		);
		return res.json({
			success: true,
			adventure_key: guardian.adventure_key,
			families,
		});
	} catch (err) {
		console.error("[mission] getMissionFamilies failed:", err.message);
		return res
			.status(500)
			.json({ success: false, message: "Failed to load mission status" });
	}
}

/** GET /api/v1/mission/current - server-authoritative live mission phase. */
async function getCurrentMission(req, res) {
	const guardian = decodeGuardian(req);
	if (!guardian) {
		return res
			.status(401)
			.json({ success: false, message: "Guardian session required" });
	}

	try {
		// Rescue Ratatouille: Mission 1 is the key-hunt trail, tracked per guardian.
		if (guardian.adventure_key === missionService.RATATOUILLE_ADVENTURE) {
			const trail = await missionService.getTrailState(
				guardian.adventure_key,
				guardian.guardian_id
			);
			if (trail) {
				return res.json({
					success: true,
					adventure_key: guardian.adventure_key,
					phase: "key_hunt",
					mission: {
						id: missionService.TRAIL_MISSION,
						number: 1,
						title: "The Trail to Ratatouille",
						status: trail.complete
							? "Trail Complete"
							: `${trail.keysUsed}/${trail.keysTotal} keys`,
						summary: trail.complete
							? "Every key is in. Follow the whole trail from the very start — Ratatouille is waiting at the end."
							: "Ten Guardian clue cards are hidden around the property, marked with the Guardians logo. Each card's decryption key unlocks the next leg of the trail.",
					},
					families: [],
					trail,
				});
			}
		}

		const state = await missionService.getCampaignMissionPhase(
			guardian.adventure_key
		);
		if (!state) {
			return res.json({ success: true, adventure_key: guardian.adventure_key, mission: null });
		}

		const families =
			state.phase === "check_in"
				? await missionService.getFamilyOnboardingStatus(guardian.adventure_key)
				: [];
		const mission =
			state.phase === "check_in"
				? {
						id: "mission-0-check-in",
						number: 1,
						title: "Gather the Guardians",
						status: "Awaiting Guardians",
						summary: "Get at least one Guardian from every family to check in with Athena.",
				  }
				: {
						id: missionService.PORTICO_MISSION,
						number: 2,
						title: "The Portico Signal",
						status: state.phase === "decrypting" ? "Decrypting" : "In Progress",
						summary:
							state.phase === "decrypting"
								? "Athena is decrypting the recovered message. Check back later."
								: "A Guardian-marked field signal has been recovered. Investigate it and report discoveries to Athena.",
				  };

		return res.json({
			success: true,
			adventure_key: guardian.adventure_key,
			phase: state.phase,
			mission,
			families,
		});
	} catch (err) {
		console.error("[mission] getCurrentMission failed:", err.message);
		return res
			.status(500)
			.json({ success: false, message: "Failed to load mission status" });
	}
}

/** The calling Guardian's family key (surname-derived), from their token. */
function callerFamilyKey(guardian) {
	return missionService.familyKeyFor({
		displayName: guardian.display_name,
		guardianId: guardian.guardian_id,
	});
}

/**
 * Build the cooperative-mission payload for the caller: their own piece (the
 * fragment their family holds, if they're a participant) plus overall progress
 * and — once every family is in — the revealed convergence point.
 */
async function buildConvergencePayload(missionKey, guardian) {
	const adventureKey = guardian.adventure_key;
	const familyKey = callerFamilyKey(guardian);
	const [fragment, corner, state] = await Promise.all([
		Promise.resolve(
			missionService.getFamilyFragment(missionKey, adventureKey, familyKey)
		),
		Promise.resolve(
			missionService.getFamilyCorner(missionKey, adventureKey, familyKey)
		),
		missionService.getConvergenceState(missionKey, adventureKey),
	]);
	if (!state) return null;

	// The caller's reported status. Real families are in the gated `state.families`
	// list; a test family isn't, so look its contribution up directly.
	const inGate = state.families.some((f) => f.key === familyKey);
	const reportedKeys = new Set(
		state.families.filter((f) => f.reported).map((f) => f.key)
	);
	let reported = false;
	if (familyKey) {
		reported = inGate
			? reportedKeys.has(familyKey)
			: await missionService.hasReported(missionKey, adventureKey, familyKey);
	}
	return {
		success: true,
		mission: missionKey,
		adventure_key: adventureKey,
		family: {
			key: familyKey,
			// The piece this family holds; null if they're not a participant.
			fragment: fragment ?? null,
			// The map corner this family uncovers; null if not a participant.
			corner: corner ?? null,
			is_participant: fragment != null,
			reported,
		},
		progress: {
			// Each family carries its own corner once it has reported, so the
			// client can render the shared map filling in piece by piece.
			families: state.families,
			reported: state.reported,
			total: state.total,
			complete: state.complete,
		},
		// Kept for potential later use; the assembled map is the player payoff now.
		convergence: state.convergence,
	};
}

/**
 * GET /api/v1/mission/state?mission=mission-2-convergence
 * The calling Guardian's cooperative-mission piece + live progress.
 */
async function getMissionState(req, res) {
	const guardian = decodeGuardian(req);
	if (!guardian) {
		return res
			.status(401)
			.json({ success: false, message: "Guardian session required" });
	}
	const missionKey = String(req.query.mission || "").trim();
	if (!missionKey) {
		return res
			.status(400)
			.json({ success: false, message: "Missing mission" });
	}
	try {
		const payload = await buildConvergencePayload(missionKey, guardian);
		if (!payload) {
			return res
				.status(404)
				.json({ success: false, message: "Mission not found for this adventure" });
		}
		return res.json(payload);
	} catch (err) {
		console.error("[mission] getMissionState failed:", err.message);
		return res
			.status(500)
			.json({ success: false, message: "Failed to load mission state" });
	}
}

/**
 * POST /api/v1/mission/contribute  { mission }
 * Report the calling Guardian's family piece. Idempotent. The fragment stored
 * is the backend-authored one, so a family can't submit someone else's piece.
 */
async function postMissionContribute(req, res) {
	const guardian = decodeGuardian(req);
	if (!guardian) {
		return res
			.status(401)
			.json({ success: false, message: "Guardian session required" });
	}
	const missionKey = String(req.body?.mission || "").trim();
	if (!missionKey) {
		return res
			.status(400)
			.json({ success: false, message: "Missing mission" });
	}

	const familyKey = callerFamilyKey(guardian);
	try {
		const ok = await missionService.recordContribution(
			missionKey,
			guardian.adventure_key,
			familyKey,
			guardian.guardian_id
		);
		if (!ok) {
			return res.status(403).json({
				success: false,
				message: "This Guardian's family is not part of this mission",
			});
		}
		const payload = await buildConvergencePayload(missionKey, guardian);
		return res.json(payload);
	} catch (err) {
		console.error("[mission] postMissionContribute failed:", err.message);
		return res
			.status(500)
			.json({ success: false, message: "Failed to record contribution" });
	}
}

/**
 * POST /api/v1/mission/trail/report-key  { key }
 * Report a decryption key from a found clue card. A valid unused key claims
 * the next clue (in strict order) and goes pending until the decryption
 * challenges are completed. The clue payload rides back so the decrypt game
 * can de-glitch the real text.
 */
async function postTrailReportKey(req, res) {
	const guardian = decodeGuardian(req);
	if (!guardian) {
		return res
			.status(401)
			.json({ success: false, message: "Guardian session required" });
	}
	try {
		const result = await missionService.reportTrailKey(
			guardian.adventure_key,
			guardian.guardian_id,
			req.body?.key
		);
		if (!result.ok) return res.json({ success: false, reason: result.reason });
		notifyTrailChanged(guardian.guardian_id);
		return res.json({ success: true, ...result });
	} catch (err) {
		console.error("[mission] postTrailReportKey failed:", err.message);
		return res
			.status(500)
			.json({ success: false, message: "Failed to report key" });
	}
}

/**
 * POST /api/v1/mission/trail/complete-key  { key }
 * Decryption challenges finished — flip the pending key to used and reveal the
 * clue. Idempotent. Returns the refreshed trail state for the panel.
 */
async function postTrailCompleteKey(req, res) {
	const guardian = decodeGuardian(req);
	if (!guardian) {
		return res
			.status(401)
			.json({ success: false, message: "Guardian session required" });
	}
	try {
		const result = await missionService.completeTrailKey(
			guardian.adventure_key,
			guardian.guardian_id,
			req.body?.key
		);
		if (!result.ok) return res.json({ success: false, reason: result.reason });
		const trail = await missionService.getTrailState(
			guardian.adventure_key,
			guardian.guardian_id
		);
		notifyTrailChanged(guardian.guardian_id);
		return res.json({ success: true, clue: result.clue, trail });
	} catch (err) {
		console.error("[mission] postTrailCompleteKey failed:", err.message);
		return res
			.status(500)
			.json({ success: false, message: "Failed to complete decryption" });
	}
}

/**
 * POST /api/v1/mission/trail/reset
 * Wipe the CALLER's own trail progress. Testing affordance only — gated to the
 * allowlisted guardian ids (default: the seeded test account). Full resets for
 * any account go through `npm run reset:trail`.
 */
async function postTrailReset(req, res) {
	const guardian = decodeGuardian(req);
	if (!guardian) {
		return res
			.status(401)
			.json({ success: false, message: "Guardian session required" });
	}
	if (!config.TRAIL_RESET_GUARDIAN_IDS.includes(guardian.guardian_id)) {
		return res
			.status(403)
			.json({ success: false, message: "Reset not permitted for this Guardian" });
	}
	try {
		const removed = await missionService.resetTrail(guardian.guardian_id);
		const trail = await missionService.getTrailState(
			guardian.adventure_key,
			guardian.guardian_id
		);
		notifyTrailChanged(guardian.guardian_id);
		return res.json({ success: true, removed, trail });
	} catch (err) {
		console.error("[mission] postTrailReset failed:", err.message);
		return res
			.status(500)
			.json({ success: false, message: "Failed to reset trail" });
	}
}

module.exports = {
	getCurrentMission,
	getMissionFamilies,
	getMissionState,
	postMissionContribute,
	postTrailReportKey,
	postTrailCompleteKey,
	postTrailReset,
};
