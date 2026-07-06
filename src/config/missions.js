/**
 * Cooperative-mission content (the gated bits that must NOT live in the
 * frontend bundle). The Guardians app authors mission *narrative* in
 * missions.json; the secret payload — which family holds which piece, and the
 * destination that's only revealed once everyone has reported — lives here so
 * the backend can enforce the "all families" gate.
 *
 * Mission 2 "Convergence" (now framed as the "Decryption" mission): each Lake
 * Norman family earns one piece of the path by helping Athena decrypt an
 * intercepted message via a short series of "bot check" challenges (authored,
 * and validated, client-side in the Guardians app). A family's reward is one
 * `corner` of a map torn into four; only when ALL four real families have
 * reported does the assembled map — and the gathering point — get revealed.
 *
 * The `fragment` each family holds still spells out the coordinates in order
 * ("35" + ".544604" + "-80" + ".937160"); `corner` is the visual quarter of the
 * torn map that family uncovers (nw/ne/sw/se → image id under public/map/).
 *
 * A `test: true` family ("doe") lets the seeded John Doe test account run the
 * entire decrypt → report → corner-reveal flow solo. Test families are full
 * participants (they get a piece and can report) but are EXCLUDED from the
 * "all families" gate, so the real four-family game is unaffected.
 */
const MISSIONS = {
	/**
	 * Rescue Ratatouille Mission 1 "The Trail to Ratatouille": ten clue cards are
	 * hidden around the lake house property, each marked with the Guardians logo
	 * and bearing a single-use decryption key. Reporting ANY valid unused key —
	 * and then completing a short run of decryption challenges — reveals the next
	 * leg of the trail, strictly in order. The keys and the trail legs are the
	 * gated payload, so they live here and never ship in the frontend bundle.
	 *
	 * Trail legs chain: each leg's distance/bearing is walked FROM the previous
	 * leg's location. Leg 0 is the trailhead (the Front Door).
	 */
	"mission-1-ratatouille-trail": {
		objective: "trail",
		adventures: {
			rescue_ratatouille: {
				keys: [
					"X1G7",
					"SM37",
					"PX3P",
					"C4A8",
					"6KT8",
					"XG1D",
					"E34Z",
					"VS8T",
					"GYLL",
					"7PKT",
				],
				clues: [
					{ distance: 0, bearing: 0, description: "Front Door" },
					{ distance: 170, bearing: 315, description: "Island Cove" },
					{ distance: 120, bearing: 210, description: "Windy Run" },
					{ distance: 100, bearing: 170, description: "Hunters Point" },
					{ distance: 90, bearing: 150, description: "419 Bay Harbor" },
					{ distance: 55, bearing: 180, description: "425 Bay Harbor" },
					{ distance: 85, bearing: 210, description: "444 Bay Harbor" },
					{ distance: 140, bearing: 175, description: "Shoreline" },
					{ distance: 122, bearing: 125, description: "First Island" },
					{ distance: 350, bearing: 200, description: "Fallen Tree" },
				],
			},
		},
	},

	"mission-2-convergence": {
		objective: "convergence",
		adventures: {
			lake_norman_guardians: {
				// The real-world gathering point, revealed only when every required
				// family has reported in.
				convergence: {
					lat: 35.544604,
					lng: -80.937160,
				},
				// Required families (keyed by lowercased surname): the fragment each
				// one holds (order matters — it's how the pieces assemble) plus the
				// map corner they uncover. `test` families don't count toward the gate.
				families: [
					{ key: "wallace", name: "The Wallace Family", fragment: "35", corner: "nw" },
					{ key: "bryson", name: "The Bryson Family", fragment: ".544604", corner: "ne" },
					{ key: "morgan", name: "The Morgan Family", fragment: "-80", corner: "sw" },
					{ key: "abassi", name: "The Abassi Family", fragment: ".937160", corner: "se" },
					{ key: "doe", name: "The Doe Family (test)", fragment: "test", corner: "test", test: true },
				],
			},
		},
	},
};

/** The mission definition for an adventure, or null if it doesn't apply. */
function getMissionDef(missionKey, adventureKey) {
	const mission = MISSIONS[missionKey];
	if (!mission) return null;
	const def = mission.adventures[adventureKey];
	if (!def) return null;
	return { objective: mission.objective, ...def };
}

module.exports = { MISSIONS, getMissionDef };
