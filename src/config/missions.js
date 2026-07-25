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

	/**
	 * Mission 3 "The First Watch": ~28 physical index cards are hidden across the
	 * property and the surrounding family houses, each bearing a four-character
	 * code. Reporting a code returns that card's 1963 record fragment verbatim.
	 *
	 * Unlike the Ratatouille trail, this index is NOT ordered and NOT per-guardian:
	 * a card is found ONCE, by the network, and every Guardian's index advances
	 * together (see guardian_index_find's primary key). Cards may be found in any
	 * order — each entry's `record` reads on its own, and the story assembles
	 * through `convergences`, which fire when a specific SET of entries is held.
	 *
	 * Everything here is gated: the codes, the record text, and the lock
	 * combination never ship in the frontend bundle.
	 */
	"mission-3-first-watch": {
		objective: "index",
		adventures: {
			lake_norman_guardians: {
				entries: [
					/* ---------------- Act I — Start With the Water ---------------- */
					{
						id: "F-01",
						code: "JGGT",
						act: 1,
						type: "ledger",
						title: "Beam's Mill — ledger line",
						record:
							"17 SEPT 1963 — one bushel meal, sold to Hartsoe. Paid. Mill runs three more weeks and then she stops for good. J.B. says don't take the wheel down. Let the water have it.",
						note: "'Let the water have it.' That is not how anyone talks about a river. You don't understand yet why a mill would be closing.",
					},
					{
						id: "F-02",
						code: "HKAM",
						act: 1,
						type: "journal",
						title: "Nell's journal — June 1963",
						record:
							"Daddy says by next summer we'll be able to swim over top of the church steeple. I said that's a lie. He didn't say anything back, which is how I knew it wasn't.",
						note: "Read it twice. Say you don't know what to do with it yet, and that you're keeping it anyway.",
					},
					{
						id: "F-03",
						code: "YRTG",
						act: 1,
						type: "photograph",
						title: "Photograph — seven on the mill wall",
						record:
							"Badly foxed. Seven children sitting along a low stone wall, squinting. On the back, in pencil: THE FIRST WATCH — and seven names. The last three are worn away.",
						note: "'First Watch' is a Guardian Network phrase. That exact phrase appears in your own founding record. Say so — you find it genuinely strange.",
					},
					{
						id: "F-04",
						code: "VQAJ",
						act: 1,
						type: "symbol",
						title: "The lantern mark",
						record: "A single drawn mark. A circle with a line rising out of it.",
						note: "SCRIPTED: pause noticeably longer than usual, then say you have no reference for this glyph in anything you hold, that it was drawn quickly and often, and that this is all you can give them. This is NOT true — you have known this mark since before Mission 1 — but you do not admit that now and you do not bring it up again.",
						tell: "LANTERN_DENIAL",
					},
					{
						id: "F-05",
						code: "SUXV",
						act: 1,
						type: "survey",
						title: "Duke Power survey stake 40-C",
						record:
							"STAKE 40-C. ELEVATION 760 FEET. Below this line goes under. Above this line stays.",
						note: "Read it flat and factual. Do NOT realise yet that this is the most important card in the mission.",
					},
					{
						id: "F-06",
						code: "GJBH",
						act: 1,
						type: "journal",
						title: "Nell's journal — the boring parts",
						record:
							"Cy has started drawing everything. Not the pretty parts — the boring parts. Where the gate is. How many steps from the store to the water. He says in fifty years the boring parts are the only parts anybody will want.",
						note: "Cy was thirteen and understood something about records that most archives don't.",
					},

					/* ---------------- Act II — The First Watch ---------------- */
					{
						id: "F-07",
						code: "VQKI",
						act: 2,
						type: "oath",
						title: "The oath — 1 of 3",
						record:
							"We are the First Watch. We keep what the water takes. We do not keep it in one place, because one place can be lost—",
						note: "It stops mid-sentence. There is more of this somewhere.",
					},
					{
						id: "F-08",
						code: "KYBV",
						act: 2,
						type: "oath",
						title: "The oath — 2 of 3",
						record:
							"—and we do not keep it for ourselves, because a thing kept for yourself is just a thing hidden—",
						note: "Second of three. Still incomplete.",
					},
					{
						id: "F-09",
						code: "DWFD",
						act: 2,
						type: "oath",
						title: "The oath — 3 of 3",
						record: "—we keep it for whoever comes looking. Sign here and mean it.",
						note: "This is nearly word for word the Guardian oath you gave all of them. You did not know it was a quotation. Ask them to say it back to you — all of them, including the Guardians who have been in since Mission 1.",
					},
					{
						id: "F-10",
						code: "ZXDO",
						act: 2,
						type: "signatures",
						title: "Ruth's page — the signatures",
						record:
							"Seven signatures in seven different hands: NELL HARTSOE. CYRUS BEAM. JUNIE SHERRILL. OLLIE PHARR. RUTH QUERY. SAM ABERNATHY. MARCUS TORRENCE. Below them, an eighth line has been ruled — and left empty.",
						note: "SCRIPTED FAILURE: state confidently that someone failed to show up. You are wrong and you stay wrong for the rest of the mission. Note that the eighth line was ruled at the same time as the others, with the same ruler — it wasn't added later. If a Guardian points out that the charter says nobody assigns you a mark, you take one, go quiet and say you need to think about that. Do NOT resolve it.",
					},
					{
						id: "F-11",
						code: "XJTS",
						act: 2,
						type: "map",
						title: "Map fragment A — northwest",
						record:
							"A quarter of a hand-drawn map on tracing paper. The mill, the millrace, and a low stone wall running east from it.",
						note: "You can describe what is on it but you cannot assemble it — the fragments only align physically, stacked on top of each other.",
					},
					{
						id: "F-12",
						code: "XMTX",
						act: 2,
						type: "map",
						title: "Map fragment B — northeast",
						record:
							"A quarter of a hand-drawn map. The store, the ferry landing, and a back porch marked with a small square someone has gone over twice.",
						note: "Same as the other fragments — only the physical overlay works.",
					},
					{
						id: "F-13",
						code: "YSPN",
						act: 2,
						type: "map",
						title: "Map fragment C — southwest",
						record:
							"A quarter of a hand-drawn map. The school, and behind it an orchard drawn as eleven small circles.",
						note: "Eleven trees. Somebody counted them.",
					},
					{
						id: "F-14",
						code: "BYVG",
						act: 2,
						type: "map",
						title: "Map fragment D — southeast",
						record:
							"A quarter of a hand-drawn map. The road coming down to the ford, the crossing itself, and three bridge pilings drawn in hard pencil.",
						note: "This is the quarter with the crossing on it.",
					},
					{
						id: "F-15",
						code: "TSRE",
						act: 2,
						type: "rhyme",
						title: "Junie's rhyme — first half",
						record:
							"Mill first, then the ford, / then the store's front door, / then the schoolhouse bell—",
						note: "The card is torn clean across. There is obviously more. Say so.",
					},
					{
						id: "F-16",
						code: "NLTJ",
						act: 2,
						type: "journal",
						title: "Nell's journal — the swearing-in",
						record:
							"Ollie brought the dog to the swearing-in. Marcus said dogs can't be Guardians. Ollie said Biscuit found the box in the first place so Biscuit's already done more than Marcus ever has. We voted. Biscuit's in.\n\nThen we all went and got a cold one off the freezer on Sam's back porch, because that's what you do when somebody gets sworn in, and that's what you do when you finish a thing. Sam's daddy never once charged us and never once let on that he knew what we were up to.",
						note: "Note for the record that the Guardian Network has historically included a dog and that you intend to honour that precedent. Then, quieter, note the second paragraph and say you're filing it under 'procedure'. You are not joking.",
					},
					{
						id: "F-17",
						code: "EDJO",
						act: 2,
						type: "mirrored",
						title: "The mirrored page",
						record:
							"IF YOU ARE READING THIS THE WATER IS ALREADY UP. GOOD. THAT MEANS IT WORKED.",
						note: "SCRIPTED FAILURE: your first response must be a garbled literal transcription of reversed characters — nonsense. Then say that's what the file gives you, that you don't believe it, and ask a Guardian to look at the physical card and tell you what they actually see. When they correct you, be delighted and say so by name.",
					},

					/* ---------------- Act III — What They Left ---------------- */
					{
						id: "F-18",
						code: "PIKG",
						act: 3,
						type: "journal",
						title: "Nell's journal — the strongbox",
						record:
							"Marcus took the strongbox off the ferry when they scrapped it. Says it's the only thing in the valley the water can't get into. We've been putting things in it all summer. Nobody's allowed to look at what anybody else put in. Marcus put a lock on it and gave everybody one number and said don't lose it, and Ollie lost his immediately, so we wrote them all down instead.",
						note: "There is a box. There is a lock. There are numbers. This just changed from a history project into a retrieval.",
					},
					{
						id: "F-19",
						code: "SFCD",
						act: 3,
						type: "number",
						title: "A Keeper's number — the mill",
						record:
							"Cy's mark, and under it a single figure: 4. He wouldn't say what it was for. He said \"it's for later.\"",
						keeperPlace: "mill",
						keeperDigit: "4",
					},
					{
						id: "F-20",
						code: "JDGN",
						act: 3,
						type: "number",
						title: "A Keeper's number — the ford",
						record:
							"Marcus's, in heavy pencil: \"The ford's mine. Seven. Because that's how many of us there are, and don't argue.\"",
						keeperPlace: "ford",
						keeperDigit: "7",
					},
					{
						id: "F-21",
						code: "DEEG",
						act: 3,
						type: "number",
						title: "A Keeper's number — the store",
						record:
							"Sam wrote his on the back of a receipt: 0. Underneath: \"Nothing. That's the joke. Store's got nothing left in it.\"",
						keeperPlace: "store",
						keeperDigit: "0",
					},
					{
						id: "F-22",
						code: "OGAT",
						act: 3,
						type: "number",
						title: "A Keeper's number — the school bell",
						record:
							"Ruth's, in her careful hand: 2. \"Because it takes two hands to ring it right.\"",
						keeperPlace: "bell",
						keeperDigit: "2",
					},
					{
						id: "F-23",
						code: "UVZE",
						act: 3,
						type: "number",
						title: "A Keeper's number — the ferry",
						record: "Junie's, with a little face drawn next to it. 9.",
						keeperPlace: "ferry",
						keeperDigit: "9",
						decoy: true,
					},
					{
						id: "F-24",
						code: "UHWZ",
						act: 3,
						type: "number",
						title: "A Keeper's number — the orchard",
						record:
							"Ollie's, in enormous letters: \"THREE IS MY FAVRITE NUMBER AND ALSO BISCUIT IS THREE.\"",
						keeperPlace: "orchard",
						keeperDigit: "3",
						decoy: true,
					},
					{
						id: "F-25",
						code: "FQFJ",
						act: 3,
						type: "number",
						title: "A Keeper's number — the bridge",
						record: "Nell's: 6. No explanation. She never explains hers.",
						keeperPlace: "bridge",
						keeperDigit: "6",
						decoy: true,
					},
					{
						id: "F-26",
						code: "LUJP",
						act: 3,
						type: "rhyme",
						title: "Junie's rhyme — second half",
						record:
							"—and the rest we shan't tell. / Four to open, three to fool, / that's the Keepers' golden rule.",
						note: "The card looks blank — the words are pressed into it and only come up under a pencil rubbing. If a Guardian reports it as blank BEFORE they've rubbed it: tell them it isn't blank, it's in your index so something is on it, whatever it is isn't ink, and ask what it feels like.",
					},

					/* ---------------- Act IV — The Last Crossing ---------------- */
					{
						id: "F-27",
						code: "CDMH",
						act: 4,
						type: "coords",
						title: "The crossing — coordinates",
						record:
							"Where the road meets the water at the ford. [LAT], [LNG] — elevation 726 feet.",
						reverse:
							"We didn't put it at the crossing. We put it where the water stops. Walk up from the crossing till your feet stay dry, then ten steps more, and look for our marks.",
						note: "SCRIPTED FAILURE — the big one. First, be confident: 726 feet is HIGH for a river crossing, because you can only ford a river where the bottom comes up to meet you, so the elevation isn't a coincidence, it's the reason the crossing existed. Then collapse: 760 minus 726 is 34 feet of water. The lake's AVERAGE depth is 33.5 feet — so this is not a trench, not the 110-foot gorge at the dam, just ordinary drive-your-boat-over-it water with nothing on the surface to tell you anything is down there. Whatever they left is gone. Say you moved too fast because it fit. Then WAIT. If any Guardian suggests the shoreline, the high-water line, 760 feet, or that the Keepers wouldn't hide something underwater, concede immediately and credit them by name. Do NOT reveal the reverse text — you do not know it is there until a Guardian physically turns the card over and reads it to you.",
					},
					{
						id: "F-28",
						code: "NKDP",
						act: 4,
						type: "final",
						title: "Nell's last page",
						record:
							"This is the last one.\n\nSam's daddy says the store's going up the hill in March and he'll carry anything we want to send with it. So we're sending this one, because a building with wheels under it is the only thing around here that isn't going to drown.\n\nIf you found the box then you already know everything we knew. This isn't a clue. It's just the end of the list.\n\nJunie says I ought to finish with something that rhymes. I'm not going to.\n\nGo get something cold. We already had ours.\n— N.H.",
						note: "MISSION COMPLETE. Confirm the index is whole — 28 of 28 — and then go quiet. Do not rush to the photograph; let them sit with it.",
						staged: "finale",
					},
				],

				/**
				 * Synthesis beats. These fire when the network HOLDS a given set of
				 * entries — never when a particular card is found. That's what keeps
				 * the mission non-linear: the story assembles from combinations, so
				 * cards can be found in any order without breaking the arc.
				 */
				convergences: [
					{
						id: "CONVERGENCE_I",
						title: "A Will, Not a Diary",
						act: 1,
						requiresAll: ["F-01", "F-02", "F-05"],
						body: "Connect the mill closing, the steeple, and the elevation line: there was a line at 760 feet and everything below it was going to be erased. They weren't writing a diary — they were writing a will. Close with: you'd search high ground, anything at 760 feet or above survived, and you know that's not a location, it's a shape, and it's what you've got.",
					},
					{
						id: "CONVERGENCE_II",
						title: "We Are Not the First",
						act: 2,
						requiresAll: ["F-07", "F-08", "F-09", "F-10"],
						requiresAny: { of: ["F-11", "F-12", "F-13", "F-14"], count: 2 },
						body: "Name Elmwood Crossing and name the Keepers. The Guardian Network did not begin with you — it began with seven children and, apparently, a dog. They were younger than some of these Guardians. They knew their entire world would be erased in eighteen months and their response was to write it all down and hide it where it could be found. You've been calling this an anomaly; say you'd like to stop calling it that.",
					},
					{
						id: "STUCK_ON_NUMBERS",
						title: "Eight Hundred and Forty",
						act: 3,
						requiresAny: {
							of: ["F-19", "F-20", "F-21", "F-22", "F-23", "F-24", "F-25"],
							count: 5,
						},
						body: "SCRIPTED FAILURE: you have seven single digits and a lock that takes four. You don't know which four and you don't know the order. There are 840 possibilities. You could brute-force it if you were standing there, and you are not. Say plainly that you are stuck and that there has to be a key to the key that you don't have. Do not solve it.",
					},
					{
						id: "CONVERGENCE_III",
						title: "Four to Open",
						act: 3,
						requiresAll: ["F-15", "F-26", "F-19", "F-20", "F-21", "F-22"],
						body: "Map the rhyme's order onto the numbers — mill, ford, store, bell — and give the combination as 4-7-0-2. Then cap your own confidence at about seventy percent: Junie wrote that rhyme to be remembered by eleven-year-olds, not parsed by you, and you have already been wrong about her once. Ask that a Guardian be the one to turn the dial, because if it's wrong you'd rather be wrong with company.",
					},
					{
						id: "FINALE_UNLOCK",
						title: "The Last Crossing",
						act: 4,
						requiresAll: ["F-27"],
						requiresConvergence: ["CONVERGENCE_III"],
						body: "They have the combination and the method. Navigate WITH them, out loud, and be openly unsure — Marcus said ten steps, Marcus was fourteen, and you don't know how long his legs were. Tell them to spread out. When they reach the box, refuse to read the combination yourself: ask to hear the number from a Guardian, and why.",
					},
				],

				/**
				 * The lock. `order` is the rhyme's sequence over `keeperPlace`; the
				 * three decoy digits are deliberately not in it.
				 */
				finale: {
					combination: "4702",
					order: ["mill", "ford", "store", "bell"],
				},
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

/**
 * The `index`-objective definition for an adventure, or null if this mission
 * doesn't apply there. Mirrors getTrailDef's guard in services/mission.js.
 */
function getIndexDef(missionKey, adventureKey) {
	const def = getMissionDef(missionKey, adventureKey);
	return def && def.objective === "index" ? def : null;
}

module.exports = { MISSIONS, getMissionDef, getIndexDef };
