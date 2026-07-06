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
