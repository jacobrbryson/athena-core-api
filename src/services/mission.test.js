/**
 * Unit tests for the cooperative-mission (Mission 2 "Convergence") service
 * logic. The DB pool is mocked so these never touch a database — they assert
 * the fragment lookup, the "all families" gate, and that the destination is
 * withheld until every family has reported.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn() }));

const pool = require("../helpers/db");
const mission = require("./mission");

const MISSION = "mission-2-convergence";
const ADV = "lake_norman_guardians";

beforeEach(() => {
	pool.query.mockReset();
});

describe("mission service — convergence", () => {
	test("familyKeyFor derives the lowercased surname", () => {
		expect(mission.familyKeyFor({ displayName: "Lucy Wallace" })).toBe("wallace");
		expect(mission.familyKeyFor({ displayName: "Aaron Abassi" })).toBe("abassi");
		expect(mission.familyKeyFor({ displayName: null, guardianId: "20250101" })).toBe(
			"20250101"
		);
	});

	test("getFamilyFragment returns a participant's piece, null otherwise", () => {
		expect(mission.getFamilyFragment(MISSION, ADV, "wallace")).toBe("35");
		expect(mission.getFamilyFragment(MISSION, ADV, "abassi")).toBe(".937160");
		expect(mission.getFamilyFragment(MISSION, ADV, "smith")).toBeNull();
		expect(mission.getFamilyFragment(MISSION, "rescue_ratatouille", "wallace")).toBeNull();
	});

	test("getFamilyCorner returns a participant's map corner, null otherwise", () => {
		expect(mission.getFamilyCorner(MISSION, ADV, "wallace")).toBe("nw");
		expect(mission.getFamilyCorner(MISSION, ADV, "abassi")).toBe("se");
		expect(mission.getFamilyCorner(MISSION, ADV, "smith")).toBeNull();
	});

	test("the test family ('doe') is a full participant", () => {
		// John Doe can earn a piece and a corner and so run the flow solo.
		expect(mission.getFamilyFragment(MISSION, ADV, "doe")).toBe("test");
		expect(mission.getFamilyCorner(MISSION, ADV, "doe")).toBe("test");
	});

	test("each family's corner reveals as soon as that family reports", async () => {
		// Only two of four real families in.
		pool.query.mockResolvedValueOnce([
			[{ family_key: "wallace" }, { family_key: "bryson" }],
		]);
		const partial = await mission.getConvergenceState(MISSION, ADV);
		expect(partial.reported).toBe(2);
		// The test family is excluded from the gate — only the four real ones count.
		expect(partial.total).toBe(4);
		expect(partial.complete).toBe(false);
		// Reported families expose their corner; unreported ones stay withheld.
		const byKey = Object.fromEntries(partial.families.map((f) => [f.key, f]));
		expect(byKey.wallace).toMatchObject({ reported: true, corner: "nw" });
		expect(byKey.bryson).toMatchObject({ reported: true, corner: "ne" });
		expect(byKey.morgan).toMatchObject({ reported: false, corner: null });
		expect(byKey.abassi).toMatchObject({ reported: false, corner: null });
	});

	test("a test-family report never satisfies the gate", async () => {
		// Doe (test) reporting must not count toward the four-family total.
		pool.query.mockResolvedValueOnce([[{ family_key: "doe" }]]);
		const state = await mission.getConvergenceState(MISSION, ADV);
		expect(state.reported).toBe(0);
		expect(state.total).toBe(4);
		expect(state.complete).toBe(false);
		expect(state.families.map((f) => f.key)).not.toContain("doe");
	});

	test("the map completes once all families have reported", async () => {
		pool.query.mockResolvedValueOnce([
			[
				{ family_key: "wallace" },
				{ family_key: "bryson" },
				{ family_key: "morgan" },
				{ family_key: "abassi" },
			],
		]);
		const done = await mission.getConvergenceState(MISSION, ADV);
		expect(done.complete).toBe(true);
		// Every family's corner is now revealed — the full map.
		expect(done.families.map((f) => f.corner)).toEqual(["nw", "ne", "sw", "se"]);
	});

	test("recordContribution rejects a non-participant family", async () => {
		const ok = await mission.recordContribution(MISSION, ADV, "smith", "00000001");
		expect(ok).toBe(false);
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("recordContribution stores the backend-authored fragment for a participant", async () => {
		pool.query.mockResolvedValueOnce([{}]);
		const ok = await mission.recordContribution(MISSION, ADV, "morgan", "20250301");
		expect(ok).toBe(true);
		const [, params] = pool.query.mock.calls[0];
		expect(params).toEqual([MISSION, ADV, "morgan", "20250301", "-80"]);
	});
});

describe("mission service - PORTICO progression", () => {
	test("recognizes PORTICO and contextual bottle discoveries", () => {
		expect(mission.messageSignalsBottleDiscovery("The word is portico!")).toBe(true);
		expect(mission.messageSignalsBottleDiscovery("We found a note in a bottle")).toBe(
			true
		);
		expect(mission.messageSignalsBottleDiscovery("A clue washed ashore")).toBe(true);
		expect(mission.messageSignalsBottleDiscovery("I filled my water bottle")).toBe(
			false
		);
	});

	test("recognizes the final cipher as a complete token", () => {
		expect(mission.messageContainsFinalCipher("We found YP2LBHM7!")).toBe(true);
		expect(mission.messageContainsFinalCipher("yp2lbhm7")).toBe(true);
		expect(mission.messageContainsFinalCipher("XYP2LBHM7X")).toBe(false);
	});

	test("starts Mission 2 from the check-in phase", async () => {
		pool.query
			.mockResolvedValueOnce([[]])
			.mockResolvedValueOnce([{ affectedRows: 1 }]);

		const transition = await mission.applyMessageTransition(
			ADV,
			"20250101",
			"I found PORTICO in the bottle"
		);

		expect(transition).toBe("started");
		expect(pool.query).toHaveBeenCalledTimes(2);
		expect(pool.query.mock.calls[1][1]).toEqual([
			ADV,
			"mission-2-portico",
			"20250101",
		]);
	});

	test("does not accept the final cipher before Mission 2 starts", async () => {
		pool.query.mockResolvedValueOnce([[]]);
		const transition = await mission.applyMessageTransition(
			ADV,
			"20250101",
			"YP2LBHM7"
		);

		expect(transition).toBeNull();
		expect(pool.query).toHaveBeenCalledTimes(1);
	});

	test("moves an active Mission 2 into decrypting", async () => {
		pool.query
			.mockResolvedValueOnce([
				[{ mission_key: "mission-2-portico", status: "active" }],
			])
			.mockResolvedValueOnce([{ affectedRows: 1 }]);

		const transition = await mission.applyMessageTransition(
			ADV,
			"20250101",
			"The last clue says YP2LBHM7."
		);

		expect(transition).toBe("decrypting");
		expect(pool.query).toHaveBeenCalledTimes(2);
	});
});

describe("mission service — Ratatouille trail (key hunt)", () => {
	const RAT = "rescue_ratatouille";
	const GID = "12345678";
	const row = (key_code, clue_index, status) => ({ key_code, clue_index, status });

	test("trail state is null for adventures without a trail mission", async () => {
		expect(await mission.getTrailState(ADV, GID)).toBeNull();
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("a valid first key claims the trailhead clue as pending", async () => {
		pool.query
			.mockResolvedValueOnce([[]]) // no rows yet
			.mockResolvedValueOnce([{ affectedRows: 1 }]); // insert

		const res = await mission.reportTrailKey(RAT, GID, "x1g7");
		expect(res.ok).toBe(true);
		expect(res.clueIndex).toBe(0);
		expect(res.clue.text).toBe("THE TRAIL BEGINS AT THE FRONT DOOR.");
		expect(res.challenges).toBe(3);
		// The insert stored the normalized key and clue index 0.
		expect(pool.query.mock.calls[1][1]).toEqual([
			GID,
			"mission-1-ratatouille-trail",
			"X1G7",
			0,
		]);
	});

	test("ANY valid key unlocks the NEXT clue in order", async () => {
		pool.query
			.mockResolvedValueOnce([
				[row("X1G7", 0, "used"), row("GYLL", 1, "used"), row("SM37", 2, "used")],
			])
			.mockResolvedValueOnce([{ affectedRows: 1 }]);

		const res = await mission.reportTrailKey(RAT, GID, "7PKT");
		expect(res.ok).toBe(true);
		expect(res.clueIndex).toBe(3);
		expect(res.clue.text).toBe(
			"FROM WINDY RUN: WALK 100 METERS AT BEARING 170 DEGREES — HUNTERS POINT."
		);
	});

	test("unknown keys are rejected without touching the database", async () => {
		expect(await mission.reportTrailKey(RAT, GID, "ZZZZ")).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(await mission.reportTrailKey(RAT, GID, "hello there")).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("a used key can never be used twice", async () => {
		pool.query.mockResolvedValueOnce([[row("X1G7", 0, "used")]]);
		expect(await mission.reportTrailKey(RAT, GID, "X1G7")).toEqual({
			ok: false,
			reason: "used",
		});
	});

	test("re-reporting the pending key resumes the same clue", async () => {
		pool.query.mockResolvedValueOnce([[row("SM37", 0, "pending")]]);
		const res = await mission.reportTrailKey(RAT, GID, "sm37");
		expect(res.ok).toBe(true);
		expect(res.clueIndex).toBe(0);
		// No INSERT — only the row load.
		expect(pool.query).toHaveBeenCalledTimes(1);
	});

	test("a second key is refused while another decryption is pending", async () => {
		pool.query.mockResolvedValueOnce([[row("SM37", 0, "pending")]]);
		expect(await mission.reportTrailKey(RAT, GID, "X1G7")).toEqual({
			ok: false,
			reason: "pending_other",
		});
	});

	test("the final stretch demands an extra challenge", async () => {
		const nineUsed = [
			"X1G7",
			"SM37",
			"PX3P",
			"C4A8",
			"6KT8",
			"XG1D",
			"E34Z",
			"VS8T",
			"GYLL",
		].map((k, i) => row(k, i, "used"));
		pool.query
			.mockResolvedValueOnce([nineUsed])
			.mockResolvedValueOnce([{ affectedRows: 1 }]);

		const res = await mission.reportTrailKey(RAT, GID, "7PKT");
		expect(res.clueIndex).toBe(9);
		expect(res.challenges).toBe(4);
		expect(res.clue.text).toBe(
			"FROM FIRST ISLAND: WALK 350 METERS AT BEARING 200 DEGREES — FALLEN TREE."
		);
	});

	test("completing a pending key flips it used and returns its clue", async () => {
		pool.query
			.mockResolvedValueOnce([[row("X1G7", 0, "pending")]])
			.mockResolvedValueOnce([{ affectedRows: 1 }]);

		const res = await mission.completeTrailKey(RAT, GID, "X1G7");
		expect(res.ok).toBe(true);
		expect(res.clue.index).toBe(0);
	});

	test("completing an unreported key is refused", async () => {
		pool.query.mockResolvedValueOnce([[]]);
		expect(await mission.completeTrailKey(RAT, GID, "X1G7")).toEqual({
			ok: false,
			reason: "not_reported",
		});
	});

	test("trail state exposes ordered clues, pending decryption, and completion", async () => {
		pool.query.mockResolvedValueOnce([
			[row("X1G7", 0, "used"), row("SM37", 1, "used"), row("PX3P", 2, "pending")],
		]);
		const state = await mission.getTrailState(RAT, GID);
		expect(state.keysTotal).toBe(10);
		expect(state.keysUsed).toBe(2);
		expect(state.complete).toBe(false);
		expect(state.clues.map((c) => c.index)).toEqual([0, 1]);
		expect(state.pending).toMatchObject({
			keyCode: "PX3P",
			clueIndex: 2,
			challenges: 3,
		});
		expect(state.pending.clue.description).toBe("Windy Run");
	});

	test("a key typed in chat is accepted as a report", async () => {
		pool.query
			.mockResolvedValueOnce([[]])
			.mockResolvedValueOnce([{ affectedRows: 1 }]);
		const transition = await mission.applyTrailMessageTransition(
			RAT,
			GID,
			"athena we found a card! it says x1g7"
		);
		expect(transition).toBe("key_accepted");
	});

	test("a duplicate key in chat reports the reuse", async () => {
		pool.query.mockResolvedValueOnce([[row("X1G7", 0, "used")]]);
		const transition = await mission.applyTrailMessageTransition(
			RAT,
			GID,
			"X1G7 again!"
		);
		expect(transition).toBe("key_duplicate");
	});

	test("chat without a key produces no transition", async () => {
		const transition = await mission.applyTrailMessageTransition(
			RAT,
			GID,
			"where should we look?"
		);
		expect(transition).toBeNull();
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("prompt context carries progress, phase, and the latest clue", async () => {
		pool.query.mockResolvedValueOnce([
			[row("X1G7", 0, "used"), row("SM37", 1, "used")],
		]);
		const ctx = await mission.getTrailPromptContext(RAT, GID, "key_accepted");
		expect(ctx).toMatchObject({
			id: "mission-1-ratatouille-trail",
			phase: "key_hunt",
			transition: "key_accepted",
			keysUsed: 2,
			keysTotal: 10,
			latestClueDescription: "Island Cove",
		});
	});

	test("resetTrail clears the guardian's rows", async () => {
		pool.query.mockResolvedValueOnce([{ affectedRows: 4 }]);
		expect(await mission.resetTrail(GID)).toBe(4);
		expect(pool.query.mock.calls[0][1]).toEqual([
			GID,
			"mission-1-ratatouille-trail",
		]);
	});
});

describe("mission service — Mission 3 'The First Watch' (shared index)", () => {
	const M3 = "mission-3-first-watch";
	const GID = "12345678";
	const OTHER = "87654321";

	// Codes from the real card set (see docs/missions/mission-3-the-first-watch.md).
	const F01 = "JGGT"; // Beam's Mill ledger
	const F02 = "HKAM"; // Nell's steeple journal
	const F05 = "SUXV"; // Duke Power survey stake — elevation 760
	const F27 = "CDMH"; // the coordinates (two-sided card)

	const find = (code, entry_id, guardian = GID, at = "2026-07-01T10:00:00Z") => ({
		code,
		entry_id,
		found_by_guardian_id: guardian,
		found_at: at,
	});

	test("only four-character codes in the card set are accepted", async () => {
		expect(await mission.reportIndexCode(ADV, GID, "ZZZZ")).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(await mission.reportIndexCode(ADV, GID, "not a code")).toEqual({
			ok: false,
			reason: "invalid",
		});
		// Right shape, wrong campaign — Mission 3 is Lake Norman only.
		expect(await mission.reportIndexCode("rescue_ratatouille", GID, F01)).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("a valid code returns the 1963 record verbatim", async () => {
		pool.query
			.mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT the find
			.mockResolvedValueOnce([[find(F01, "F-01")]]) // loadIndexFinds
			.mockResolvedValueOnce([[]]); // loadFiredConvergences

		const res = await mission.reportIndexCode(ADV, GID, "jggt");
		expect(res.ok).toBe(true);
		expect(res.alreadyFound).toBe(false);
		expect(res.entry.id).toBe("F-01");
		expect(res.entry.record).toContain("Let the water have it");
		expect(res.progress).toMatchObject({ found: 1, total: 28, complete: false });
	});

	test("the player payload never leaks Athena's steering or the card's reverse", async () => {
		pool.query
			.mockResolvedValueOnce([{ affectedRows: 1 }])
			.mockResolvedValueOnce([[find(F27, "F-27")]])
			.mockResolvedValueOnce([[]]);

		const res = await mission.reportIndexCode(ADV, GID, F27);
		// `note` is Athena's private steering; `reverse` is the back of the card,
		// which she must not know about until a Guardian physically turns it over.
		expect(res.entry).not.toHaveProperty("note");
		expect(res.entry).not.toHaveProperty("reverse");
		expect(res.entry).not.toHaveProperty("decoy");
		expect(JSON.stringify(res.entry)).not.toContain("where the water stops");
	});

	/* ---- the behaviour Mission 2 got wrong: shared, not per-guardian ---- */

	test("a card found by ONE Guardian is recorded for the whole network", async () => {
		pool.query
			.mockResolvedValueOnce([{ affectedRows: 1 }])
			.mockResolvedValueOnce([[find(F01, "F-01")]])
			.mockResolvedValueOnce([[]]);

		await mission.reportIndexCode(ADV, GID, F01);

		// The find row is keyed by mission+adventure+code. The guardian id is
		// stored only to credit the finder — it is NOT part of the identity of
		// the find, so no second Guardian can claim the same card.
		const [insertSql, insertParams] = pool.query.mock.calls[0];
		expect(insertSql).toContain("guardian_index_find");
		expect(insertParams).toEqual([M3, ADV, F01, "F-01", GID]);

		// And the read-back is scoped to the ADVENTURE, with no guardian filter.
		const [selectSql, selectParams] = pool.query.mock.calls[1];
		expect(selectSql).not.toContain("found_by_guardian_id = ?");
		expect(selectParams).toEqual([M3, ADV]);
	});

	test("every Guardian sees the same index regardless of who found what", async () => {
		pool.query
			.mockResolvedValueOnce([
				[find(F01, "F-01", GID), find(F02, "F-02", OTHER)],
			])
			.mockResolvedValueOnce([[]]);

		// A Guardian who personally found nothing still gets the full index.
		const state = await mission.getIndexState(ADV);
		expect(state.found).toBe(2);
		expect(state.entries.map((e) => e.id)).toEqual(["F-01", "F-02"]);
		expect(state.entries.map((e) => e.foundBy)).toEqual([GID, OTHER]);
		// State is fetched per adventure — a guardian id is never even passed in.
		expect(pool.query.mock.calls[0][1]).toEqual([M3, ADV]);
	});

	test("re-reporting a card another Guardian already found credits the finder", async () => {
		pool.query
			.mockResolvedValueOnce([{ affectedRows: 0 }]) // INSERT IGNORE — already there
			.mockResolvedValueOnce([[find(F01, "F-01", OTHER)]])
			.mockResolvedValueOnce([[]]);

		const res = await mission.reportIndexCode(ADV, GID, F01);
		expect(res.ok).toBe(true);
		expect(res.alreadyFound).toBe(true);
		expect(res.entry.foundBy).toBe(OTHER);
	});

	/* ---- convergences: the story assembles from SETS, not from order ---- */

	test("CONVERGENCE_I fires once the will-not-a-diary set is held", async () => {
		pool.query
			.mockResolvedValueOnce([{ affectedRows: 1 }])
			.mockResolvedValueOnce([
				[find(F01, "F-01"), find(F02, "F-02"), find(F05, "F-05")],
			])
			.mockResolvedValueOnce([[]]) // nothing fired yet
			.mockResolvedValueOnce([{ affectedRows: 1 }]); // INSERT the convergence

		const res = await mission.reportIndexCode(ADV, GID, F05);
		expect(res.newConvergences).toHaveLength(1);
		expect(res.newConvergences[0].id).toBe("CONVERGENCE_I");
		expect(res.newConvergences[0].body).toContain("writing a will");
	});

	test("a convergence already fired is never delivered twice", async () => {
		pool.query
			.mockResolvedValueOnce([{ affectedRows: 0 }])
			.mockResolvedValueOnce([
				[find(F01, "F-01"), find(F02, "F-02"), find(F05, "F-05")],
			])
			.mockResolvedValueOnce([[{ convergence_id: "CONVERGENCE_I" }]]);

		const res = await mission.reportIndexCode(ADV, GID, F01);
		expect(res.newConvergences).toEqual([]);
	});

	test("STUCK_ON_NUMBERS needs five of the seven Keeper numbers", async () => {
		const numbers = [
			["SFCD", "F-19"],
			["JDGN", "F-20"],
			["DEEG", "F-21"],
			["OGAT", "F-22"],
			["UVZE", "F-23"],
		].map(([c, id]) => find(c, id));

		// Four is not enough.
		pool.query
			.mockResolvedValueOnce([{ affectedRows: 1 }])
			.mockResolvedValueOnce([[...numbers.slice(0, 4)]])
			.mockResolvedValueOnce([[]]);
		let res = await mission.reportIndexCode(ADV, GID, "OGAT");
		expect(res.newConvergences).toEqual([]);

		pool.query.mockReset();

		// Five is.
		pool.query
			.mockResolvedValueOnce([{ affectedRows: 1 }])
			.mockResolvedValueOnce([numbers])
			.mockResolvedValueOnce([[]])
			.mockResolvedValueOnce([{ affectedRows: 1 }]);
		res = await mission.reportIndexCode(ADV, GID, "UVZE");
		expect(res.newConvergences.map((c) => c.id)).toEqual(["STUCK_ON_NUMBERS"]);
		expect(res.newConvergences[0].body).toContain("840");
	});

	test("FINALE_UNLOCK is gated behind CONVERGENCE_III, not just the coordinates", async () => {
		// Coordinates in hand, but the combination was never assembled.
		pool.query
			.mockResolvedValueOnce([{ affectedRows: 1 }])
			.mockResolvedValueOnce([[find(F27, "F-27")]])
			.mockResolvedValueOnce([[]]);
		let res = await mission.reportIndexCode(ADV, GID, F27);
		expect(res.newConvergences).toEqual([]);

		pool.query.mockReset();

		// Same card, but the Guardians have already worked out the lock.
		pool.query
			.mockResolvedValueOnce([{ affectedRows: 1 }])
			.mockResolvedValueOnce([[find(F27, "F-27")]])
			.mockResolvedValueOnce([[{ convergence_id: "CONVERGENCE_III" }]])
			.mockResolvedValueOnce([{ affectedRows: 1 }]);
		res = await mission.reportIndexCode(ADV, GID, F27);
		expect(res.newConvergences.map((c) => c.id)).toEqual(["FINALE_UNLOCK"]);
		expect(res.progress.act).toBe(4);
	});

	/* ---- chat is the primary interface ---- */

	test("a code spoken in chat counts as reporting it", async () => {
		pool.query
			.mockResolvedValueOnce([{ affectedRows: 1 }])
			.mockResolvedValueOnce([[find(F01, "F-01")]])
			.mockResolvedValueOnce([[]]);

		const t = await mission.applyIndexMessageTransition(
			ADV,
			GID,
			"athena!! we found a card behind the oven, it says jggt"
		);
		expect(t.kind).toBe("code_accepted");
		expect(t.entry.id).toBe("F-01");
	});

	test("chat without a code produces no transition and no writes", async () => {
		expect(
			await mission.applyIndexMessageTransition(ADV, GID, "where should we look?")
		).toBeNull();
		expect(pool.query).not.toHaveBeenCalled();
	});

	/* ---- the prompt must not be able to leak an unfound card ---- */

	test("prompt context contains ONLY found entries", async () => {
		pool.query
			.mockResolvedValueOnce([[find(F01, "F-01"), find(F02, "F-02")]])
			.mockResolvedValueOnce([[]]);

		const ctx = await mission.getIndexPromptContext(ADV, GID);
		expect(ctx).toMatchObject({ id: M3, foundCount: 2, total: 28, act: 1 });
		expect(ctx.foundEntries.map((e) => e.id)).toEqual(["F-01", "F-02"]);

		// Nothing unfound may appear anywhere in what Athena is handed — not the
		// lock combination, not the reverse of the coordinates card, not a
		// record she hasn't been given.
		const serialized = JSON.stringify(ctx);
		expect(serialized).not.toContain("4702");
		expect(serialized).not.toContain("where the water stops");
		expect(serialized).not.toContain("F-27");
		expect(serialized).not.toContain("Elmwood");
	});

	test("prompt context carries the scripted tell for the lantern card", async () => {
		pool.query
			.mockResolvedValueOnce([{ affectedRows: 1 }])
			.mockResolvedValueOnce([[find("VQAJ", "F-04")]])
			.mockResolvedValueOnce([[]])
			// getIndexPromptContext re-reads state
			.mockResolvedValueOnce([[find("VQAJ", "F-04")]])
			.mockResolvedValueOnce([[]]);

		const t = await mission.applyIndexMessageTransition(ADV, GID, "VQAJ");
		const ctx = await mission.getIndexPromptContext(ADV, GID, t);
		expect(ctx.pendingTell).toBe("LANTERN_DENIAL");
		expect(ctx.latestEntry.note).toContain("This is NOT true");
	});

	test("resetIndex clears the whole adventure's index", async () => {
		pool.query
			.mockResolvedValueOnce([{ affectedRows: 12 }])
			.mockResolvedValueOnce([{ affectedRows: 2 }]);
		expect(await mission.resetIndex(ADV)).toBe(12);
		expect(pool.query.mock.calls[0][1]).toEqual([M3, ADV]);
		expect(pool.query.mock.calls[1][1]).toEqual([M3, ADV]);
	});
});
