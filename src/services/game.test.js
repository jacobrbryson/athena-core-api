/**
 * Go Fish engine tests. The DB is mocked — these assert the RULES, because the
 * whole point of moving the game server-side is that the rules are enforced
 * rather than improvised by a language model.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./memory", () => ({
	getMemorySummaryForProfileId: jest.fn().mockResolvedValue([]),
	upsertMemoryForProfile: jest.fn().mockResolvedValue({}),
}));

const pool = require("../helpers/db");
const memory = require("./memory");
const game = require("./game");

beforeEach(() => {
	pool.query.mockReset();
	memory.getMemorySummaryForProfileId.mockReset().mockResolvedValue([]);
	memory.upsertMemoryForProfile.mockReset().mockResolvedValue({});
});

/** A hand-built state so tests are deterministic (no shuffle involved). */
const mkState = (over = {}) => ({
	pond: ["5H", "5D", "5C"],
	athena: ["7H", "7D", "KS"],
	player: ["9H", "9D", "9C", "2S"],
	athenaBooks: [],
	playerBooks: [],
	turn: "player",
	...over,
});

describe("go fish — dealing", () => {
	test("deals seven each from a 52-card deck", () => {
		const { state } = game.deal();
		expect(state.athena).toHaveLength(7);
		expect(state.player).toHaveLength(7);
		expect(state.pond).toHaveLength(52 - 14);
		expect(state.turn).toBe("player");
	});

	test("every card is unique across pond and both hands", () => {
		const { state } = game.deal();
		const all = [...state.pond, ...state.athena, ...state.player];
		expect(new Set(all).size).toBe(all.length);
	});

	test("a four-of-a-kind dealt into a hand books immediately", () => {
		const hand = ["3H", "3D", "3C", "3S", "9H"];
		const books = [];
		expect(game.claimBooks(hand, books)).toEqual(["3"]);
		expect(books).toEqual(["3"]);
		expect(hand).toEqual(["9H"]);
	});
});

describe("go fish — the child's turn", () => {
	test("asking for a rank Athena holds takes ALL of them and keeps the turn", () => {
		const state = mkState({ player: ["7S", "2S"] });
		const events = [];
		game.playerAsks(state, "7", events);

		expect(state.player).toEqual(expect.arrayContaining(["7S", "7H", "7D"]));
		expect(state.athena).toEqual(["KS"]);
		expect(state.turn).toBe("player"); // a hit means go again
		expect(events[0]).toMatchObject({ type: "player_asks", rank: "7", hit: true, count: 2 });
	});

	test("you may only ask for a rank you already hold, and it costs no turn", () => {
		const state = mkState({ player: ["2S"] });
		const events = [];
		game.playerAsks(state, "7", events);

		expect(events[0]).toMatchObject({ type: "illegal_ask", rank: "7" });
		expect(state.athena).toEqual(["7H", "7D", "KS"]); // nothing changed hands
		expect(state.turn).toBe("player");
	});

	test("a miss sends them fishing and passes the turn", () => {
		const state = mkState({ player: ["9H", "9D"], pond: ["KH"] });
		const events = [];
		game.playerAsks(state, "9", events);

		expect(events[0]).toMatchObject({ hit: false });
		expect(state.player).toContain("KH");
		expect(state.turn).toBe("athena");
	});

	test("fishing up exactly what you asked for earns another turn", () => {
		const state = mkState({ player: ["9H"], pond: ["9S"] });
		const events = [];
		game.playerAsks(state, "9", events);

		expect(state.turn).toBe("player");
		expect(events.find((e) => e.type === "go_fish")).toMatchObject({ lucky: true });
	});

	test("completing a set books it out of the hand", () => {
		const state = mkState({
			player: ["9H", "9D", "9C"],
			athena: ["9S", "KS"],
		});
		const events = [];
		game.playerAsks(state, "9", events);

		expect(state.playerBooks).toEqual(["9"]);
		expect(state.player.some((c) => c.startsWith("9"))).toBe(false);
		expect(events).toContainEqual({ type: "book", who: "player", rank: "9" });
	});
});

describe("go fish — Athena's turn", () => {
	test("she asks for a rank she actually holds", () => {
		const state = mkState({ turn: "athena", player: ["2S"], pond: ["KH"] });
		const events = [];
		game.athenaTurn(state, events);

		const ask = events.find((e) => e.type === "athena_asks");
		expect(["7", "K"]).toContain(ask.rank);
		expect(state.athena.length).toBeGreaterThan(0);
	});

	test("she keeps asking while she hits, then passes on a miss", () => {
		const state = mkState({
			turn: "athena",
			athena: ["7H", "7D"],
			player: ["7S", "7C", "2S"],
			pond: ["KH"],
		});
		const events = [];
		game.athenaTurn(state, events);

		// She hits the sevens, books them, then misses and fishes.
		expect(state.athenaBooks).toEqual(["7"]);
		expect(state.turn).toBe("player");
	});

	test("she never takes a card she was not given", () => {
		const state = mkState({ turn: "athena", athena: ["KS"], player: ["2S"], pond: [] });
		const before = [...state.player];
		const events = [];
		game.athenaTurn(state, events);

		// Player held no kings, so nothing may move.
		expect(state.player).toEqual(before);
		expect(state.turn).toBe("player");
	});

	test("an empty hand is refilled from the pond rather than knocked out", () => {
		const state = mkState({ turn: "athena", athena: [], player: ["2S"], pond: ["KH", "QD"] });
		const events = [];
		game.athenaTurn(state, events);
		expect(state.athena.length).toBeGreaterThan(0);
		expect(events.some((e) => e.type === "refill")).toBe(true);
	});
});

describe("go fish — what Athena is allowed to see", () => {
	test("she sees her own hand but only the SIZE of theirs", () => {
		const state = mkState();
		const ctx = game.buildContext(state, [], "in_progress");

		expect(ctx.yourHand).toHaveLength(3);
		expect(ctx.theirHandCount).toBe(4);
		// Their actual cards must not appear anywhere in what she is handed.
		const blob = JSON.stringify(ctx);
		expect(blob).not.toContain("9H");
		expect(blob).not.toContain("2S");
		expect(ctx).not.toHaveProperty("player");
		expect(ctx).not.toHaveProperty("pond");
	});

	test("the pond is a count, never a list", () => {
		const ctx = game.buildContext(mkState(), [], "in_progress");
		expect(ctx.pondCount).toBe(3);
		expect(JSON.stringify(ctx)).not.toContain("5H");
	});
});

describe("go fish — reading the child's message", () => {
	test.each([
		["do you have any sevens?", "7"],
		["got any 7s", "7"],
		["do you have a king", "K"],
		["any aces?", "A"],
		["gimme your tens", "10"],
		["do you have any queens", "Q"],
		["10s?", "10"],
	])("%s -> %s", (msg, rank) => {
		expect(game.parseRank(msg)).toBe(rank);
	});

	test("a message with no rank in it is not a move", () => {
		expect(game.parseRank("this is fun!")).toBeNull();
		expect(game.parseRank("what should we do now")).toBeNull();
	});

	test("a new game only starts on an explicit request", async () => {
		pool.query.mockResolvedValue([[]]); // no existing game
		expect(await game.applyGameMessage(1, "I saw a goldfish today")).toBeNull();
		expect(await game.applyGameMessage(1, "tell me about fish")).toBeNull();
	});

	test("'let's play go fish' deals a game", async () => {
		pool.query
			.mockResolvedValueOnce([[]]) // loadGame — none
			.mockResolvedValueOnce([{}]); // saveGame
		const ctx = await game.applyGameMessage(1, "can we play go fish?");
		expect(ctx.status).toBe("started");
		expect(ctx.yourHand).toHaveLength(7);
		expect(ctx.theirHandCount).toBe(7);
	});

	test("chatting mid-game keeps the hand without making a move", async () => {
		pool.query.mockResolvedValueOnce([
			[{ state: JSON.stringify(mkState()), status: "active" }],
		]);
		const ctx = await game.applyGameMessage(1, "this is fun");
		expect(ctx.status).toBe("in_progress");
		expect(ctx.events).toEqual([]);
		expect(ctx.yourHand).toHaveLength(3);
	});

	test("quitting clears the game", async () => {
		pool.query
			.mockResolvedValueOnce([[{ state: JSON.stringify(mkState()), status: "active" }]])
			.mockResolvedValueOnce([{}]); // delete
		const ctx = await game.applyGameMessage(1, "i quit");
		expect(ctx.status).toBe("ended");
	});
});

describe("go fish — the running record in Athena's memory", () => {
	test("a first win is written as a fresh tally", async () => {
		await game.recordResult(42, "player_wins");

		const [profileId, familyId, payload] =
			memory.upsertMemoryForProfile.mock.calls[0];
		expect(profileId).toBe(42);
		expect(familyId).toBeNull();
		expect(payload).toMatchObject({ key: "go_fish", source: "ai" });
		expect(payload.value).toContain("they have won 1, Athena 0");
		expect(payload.value).toContain("[tally 1/1/0]");
	});

	test("an existing tally is read back and incremented", async () => {
		memory.getMemorySummaryForProfileId.mockResolvedValue([
			{
				category: "interest",
				key: "go_fish",
				value:
					"Plays Go Fish with Athena. 6 games so far — they have won 4, Athena 2. " +
					"Last played 2026-07-01. [tally 6/4/2]",
			},
		]);

		await game.recordResult(42, "athena_wins");
		const payload = memory.upsertMemoryForProfile.mock.calls[0][2];
		expect(payload.value).toContain("7 games so far");
		expect(payload.value).toContain("they have won 4, Athena 3");
		expect(payload.value).toContain("[tally 7/4/3]");
	});

	test("a session with no profile writes nothing", async () => {
		await game.recordResult(null, "player_wins");
		expect(memory.upsertMemoryForProfile).not.toHaveBeenCalled();
	});

	test("a memory failure never breaks the game", async () => {
		memory.getMemorySummaryForProfileId.mockRejectedValue(new Error("db down"));
		memory.upsertMemoryForProfile.mockRejectedValue(new Error("db down"));
		await expect(game.recordResult(42, "player_wins")).resolves.toBeUndefined();
	});
});

describe("go fish — a full game always terminates with 13 books", () => {
	test("100 random games all finish cleanly", () => {
		for (let n = 0; n < 100; n++) {
			const { state } = game.deal();
			let guard = 0;
			while (
				state.athenaBooks.length + state.playerBooks.length < 13 &&
				guard++ < 500
			) {
				const events = [];
				if (state.turn === "player") {
					const ranks = state.player.map((c) => c.slice(0, -1));
					if (ranks.length) {
						game.playerAsks(state, ranks[Math.floor(Math.random() * ranks.length)], events);
					} else {
						state.turn = "athena";
					}
				}
				if (state.turn === "athena") game.athenaTurn(state, events);
			}
			expect(state.athenaBooks.length + state.playerBooks.length).toBe(13);
			// No card is ever lost or duplicated.
			const all = [...state.pond, ...state.athena, ...state.player];
			expect(new Set(all).size).toBe(all.length);
		}
	});
});
