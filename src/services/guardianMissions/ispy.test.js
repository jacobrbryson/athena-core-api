jest.mock("../../helpers/db", () => ({ query: jest.fn(), getConnection: jest.fn(async () => ({ query: jest.fn(async () => [[{ locked: 1 }]]), release: jest.fn() })) }));
const ispy = require("./ispy");
const planning = require("./planning");
const runner = require("./runner");

describe("I Spy", () => {
	test("a guess matches the answer whatever the articles, plurals or case", () => {
		expect(ispy.matches("The red ball", "red ball")).toBe(true);
		expect(ispy.matches("balls", "ball")).toBe(true);
		expect(ispy.matches("a CUP", "cup")).toBe(true);
	});

	test("one of Athena's other names counts, and a different thing doesn't", () => {
		expect(ispy.matches("sofa", "couch", ["sofa", "settee"])).toBe(true);
		expect(ispy.matches("lamp", "couch", ["sofa"])).toBe(false);
		expect(ispy.matches("", "couch")).toBe(false);
	});

	test("turns go round the players in the plan's order", () => {
		const players = ["thomas", "skylar", "athena"];
		expect([1, 2, 3, 4, 12].map((n) => ispy.spyFor(players, n))).toEqual(["thomas", "skylar", "athena", "thomas", "athena"]);
	});

	test("twelve rounds give each player four spying turns, and both others alternate guesses", () => {
		const players = [{ id: 3 }, { id: 4 }, { id: 9 }];
		const spies = Array.from({ length: 12 }, (_, i) => ispy.spyFor(players, i + 1).id);
		for (const p of players) expect(spies.filter(id => id === p.id)).toHaveLength(4);
		for (const [spy, first, second] of [[3, 4, 9], [4, 9, 3], [9, 3, 4]]) {
			const round = { spy_actor_id: spy, guesses: [] };
			expect(ispy.guesserFor(players, round).id).toBe(first);
			round.guesses.push({ by: first, right: null });
			expect(ispy.guesserFor(players, round).id).toBe(first);
			round.guesses[0].right = false;
			expect(ispy.guesserFor(players, round).id).toBe(second);
			round.guesses.push({ by: second, right: false });
			expect(ispy.guesserFor(players, round).id).toBe(first);
		}
	});

	test("the kids alternate providing photos on Athena's four spying turns", () => {
		const players = [{ id: 3, kind: "kid" }, { id: 4, kind: "kid" }, { id: 9, kind: "assistant" }];
		expect([3, 6, 9, 12].map(n => ispy.photographerFor(players, n).id)).toEqual([3, 4, 3, 4]);
		expect([1, 2, 4, 5].map(n => ispy.photographerFor(players, n).id)).toEqual([3, 4, 3, 4]);
	});

	test("the other child cannot submit Athena's next photo", async () => {
		const pool = require("../../helpers/db");
		const missions = require("./index");
		const players = { thomas: { id: 3, kind: "kid", family_id: 1, display_name: "Thomas" }, skylar: { id: 4, kind: "kid", family_id: 1, display_name: "Skylar" }, athena: { id: 9, kind: "assistant", family_id: 1, display_name: "Athena" } };
		const actors = jest.spyOn(missions, "actorByKey").mockImplementation(async (_f, key) => players[key]);
		pool.query.mockReset();
		pool.query.mockImplementation(async sql => {
			if (/FROM athena_gm_mission m/.test(sql)) return [[{ id: 7, family_id: 1, plan: { game: { kind: "ispy", rounds: 12, players: Object.keys(players) } } }]];
			if (/FROM athena_gm_mission_step/.test(sql)) return [[]];
			if (/FROM athena_gm_ispy_round WHERE mission_id/.test(sql)) return [Array.from({ length: 5 }, (_, i) => ({ round_no: i + 1, outcome: "guessed" }))];
			throw Error(`Unexpected query: ${sql}`);
		});
		const llm = { generateJson: jest.fn() };
		try {
			await expect(ispy.athenaSpies(players.thomas, {}, llm)).rejects.toMatchObject({ status: 409, message: "It's Skylar's turn to give Athena a photo." });
			expect(llm.generateJson).not.toHaveBeenCalled();
			expect(pool.query.mock.calls.some(([sql]) => /^INSERT/.test(sql))).toBe(false);
		} finally { actors.mockRestore(); pool.query.mockReset(); }
	});

	test("Athena's jokes settle over the game while every stage still asks for a real visible guess", () => {
		expect(ispy.playStyle(1)).toContain("over-the-top silly");
		expect(ispy.playStyle(3)).toContain("real object name");
		expect(ispy.playStyle(6)).toContain("getting the hang");
		expect(ispy.playStyle(12)).toContain("careful, observant");
	});

	test("a plan keeps its game only when it names enough players", () => {
		const base = { title: "Teach Athena I Spy", goal: "g", reason: "r", steps: [], safety: {} };
		expect(planning.normalize({ ...base, game: { kind: "ispy", rounds: 12, players: ["thomas", "skylar", "athena"] } }, []).plan.game).toEqual({ kind: "ispy", rounds: 12, players: ["thomas", "skylar", "athena"] });
		expect(planning.normalize({ ...base, game: { kind: "ispy", players: ["thomas"] } }, []).plan.game).toBeNull();
		expect(planning.normalize({ ...base, game: { kind: "chess", players: ["a", "b"] } }, []).plan.game).toBeNull();
	});

	test("a game proves only a kid's live step, in a plan that names its game", () => {
		const actors = { thomas: { kind: "kid" }, ross: { kind: "parent" } };
		const step = (over) => ({ key: "play", phase: "live", actor: "thomas", proof: "game", instruction: "Play I Spy with Athena on your tablet.", dueMinutes: 60, ...over });
		const game = { kind: "ispy", rounds: 12, players: ["thomas", "athena"] };
		const problems = (plan) => runner.validatePlan(plan, { actors }).filter((p) => /game/.test(p));
		expect(problems({ steps: [step()], game })).toEqual([]);
		expect(problems({ steps: [step()] })).toHaveLength(1);
		expect(problems({ steps: [step({ actor: "ross" })], game })).toHaveLength(1);
	});
	test("there are twenty clue cards with unique keys, and a given card isn't offered again", () => {
		expect(ispy.CLUES).toHaveLength(20);
		expect(new Set(ispy.CLUES.map((c) => c.key)).size).toBe(20);
		expect(ispy.CLUES.some((c) => c.key === "none")).toBe(false);
		const left = ispy.clueOptions([{ key: "car" }, { key: "none" }]);
		expect(left).toHaveLength(19);
		expect(left.some((c) => c.key === "car")).toBe(false);
		expect(ispy.cluesForPrompt([{ key: "outside" }, { key: "none" }])).toEqual(["Outside", "None (no clue from the list)"]);
	});

	test("clue cards go into Athena's guess, and the clue she gives is only ever one on the list", async () => {
		const image = Buffer.alloc(2000, 1).toString("base64");
		const llm = { generateJson: jest.fn()
			.mockResolvedValueOnce({ data: { guess: "the car seat" } })
			.mockResolvedValueOnce({ data: { key: "soft" } })
			.mockResolvedValueOnce({ data: { key: "made up" } }) };
		await ispy.demoGuess({ imageBase64: image, contentType: "image/jpeg", clue: "something grey", clues: ["car", "bogus"] }, llm);
		const guessPrompt = llm.generateJson.mock.calls[0][0].contents[0].parts[0].text;
		expect(guessPrompt).toContain("In the car");
		expect(guessPrompt).not.toContain("bogus");
		await expect(ispy.demoClue({ imageBase64: image, contentType: "image/jpeg", answer: "pillow", given: ["car"] }, llm)).resolves.toEqual({ key: "soft" });
		const cluePrompt = llm.generateJson.mock.calls[1][0];
		expect(cluePrompt.contents[0].parts[0].text).toContain("Clues you already gave: [\"In the car\"]");
		expect(cluePrompt.schema.properties.key.enum).not.toContain("car");
		await expect(ispy.demoClue({ imageBase64: image, contentType: "image/jpeg", answer: "pillow" }, llm)).resolves.toEqual({ key: "none" });
		await expect(ispy.demoClue({ imageBase64: image, contentType: "image/jpeg", answer: "pillow", given: ["none"] }, llm)).rejects.toMatchObject({ status: 409 });
	});

	test("on a kid's round a miss makes Athena ask for a clue, and the spy's card is saved and in her next guess", async () => {
		const pool = require("../../helpers/db");
		const missions = require("./index");
		const scout = require("./scout");
		const thomas = { id: 3, kind: "kid", family_id: 1, display_name: "Thomas" };
		const athena = { id: 9, kind: "assistant", family_id: 1, display_name: "Athena" };
		const byKey = { thomas, athena };
		jest.spyOn(missions, "actorByKey").mockImplementation(async (_f, k) => byKey[k]);
		jest.spyOn(scout, "readProofPhoto").mockResolvedValue(Buffer.alloc(2000, 1));
		const round = { id: 5, uuid: "r1", mission_id: 7, round_no: 1, spy_actor_id: 3, photo_id: 11, clue: "something grey", answer: "seat", hints: "[]", clues: null, clue_asked_by: null, guesses: JSON.stringify([{ by: 9, text: "rock", right: null }]), outcome: null };
		const updates = [];
		pool.query.mockReset();
		pool.query.mockImplementation(async (sql, args) => {
			if (/FROM athena_gm_mission m/.test(sql)) return [[{ id: 7, uuid: "m", family_id: 1, title: "I Spy", plan: JSON.stringify({ game: { kind: "ispy", rounds: 12, players: ["thomas", "athena"] } }) }]];
			if (/FROM athena_gm_mission_step/.test(sql)) return [[]];
			if (/FROM athena_gm_ispy_round WHERE uuid/.test(sql)) return [[{ ...round }]];
			if (/FROM athena_gm_ispy_round WHERE mission_id/.test(sql)) return [[{ ...round }]];
			if (/FROM athena_gm_photo/.test(sql)) return [[{ object_path: "p", content_type: "image/jpeg" }]];
			if (/^UPDATE athena_gm_ispy_round/.test(sql)) {
				updates.push(args);
				Object.assign(round, { guesses: args[0], hints: args[1], clues: args[2], clue_asked_by: args[3] });
				return [{}];
			}
			throw new Error(`unexpected ${sql}`);
		});
		const llm = { generateJson: jest.fn().mockResolvedValue({ data: { guess: "car seat" } }) };

		const asked = await ispy.judge(thomas, "r1", { right: false }, llm);
		expect(llm.generateJson).not.toHaveBeenCalled();
		expect(round.clue_asked_by).toBe(9);
		expect(asked.round).toMatchObject({ clueAsked: true, awaitingJudge: false, cluesLeft: 20 });
		expect(asked.clueList).toHaveLength(20);

		await expect(ispy.giveClue(thomas, "r1", "bogus", llm)).rejects.toMatchObject({ status: 400 });
		const after = await ispy.giveClue(thomas, "r1", "car", llm);
		expect(JSON.parse(round.clues)).toEqual([expect.objectContaining({ key: "car", by: 3 })]);
		expect(round.clue_asked_by).toBeNull();
		expect(llm.generateJson.mock.calls[0][0].contents[0].parts[0].text).toContain("In the car");
		expect(after.round).toMatchObject({ clueAsked: false, awaitingJudge: true, clues: [{ key: "car", label: "In the car", by: "Thomas", athena: false }] });
		await expect(ispy.requestClue(thomas, "r1", llm)).rejects.toMatchObject({ status: 409 });
		missions.actorByKey.mockRestore();
		scout.readProofPhoto.mockRestore();
		pool.query.mockReset();
	});

	test("a finished game carries the finale: the badge, who really earned it, and all twelve rounds", async () => {
		const pool = require("../../helpers/db");
		const missions = require("./index");
		const thomas = { id: 3, kind: "kid", family_id: 1, display_name: "Thomas" };
		const skylar = { id: 4, kind: "kid", family_id: 1, display_name: "Skylar" };
		const athena = { id: 9, kind: "assistant", family_id: 1, display_name: "Athena" };
		const spies = [3, 4, 9];
		const done = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, uuid: `r${i + 1}`, mission_id: 7, round_no: i + 1, spy_actor_id: spies[i % 3], clue: "something", answer: `thing ${i + 1}`, guesses: "[]", outcome: spies[i % 3] === 9 ? "guessed" : i % 2 ? "taught" : "guessed", solved_by_actor_id: spies[i % 3] === 9 ? 3 : i % 2 ? null : 9 }));
		const actors = jest.spyOn(missions, "actorByKey").mockImplementation(async (_f, key) => ({ thomas, skylar, athena })[key]);
		pool.query.mockReset();
		pool.query.mockImplementation(async (sql) => {
			if (/FROM athena_gm_mission m/.test(sql)) return [[{ id: 7, uuid: "m", family_id: 1, title: "I Spy", status: "completed", plan: { game: { kind: "ispy", rounds: 12, players: ["thomas", "skylar", "athena"] } } }]];
			if (/FROM athena_gm_mission_step/.test(sql)) return [[]];
			if (/FROM athena_gm_ispy_round WHERE mission_id/.test(sql)) return [done];
			if (/FROM athena_gm_badge WHERE mission_id/.test(sql)) return [[{ id: 6, badge_key: "first-sight", name: "First Sight", story: "s", art: "/assets/badges/first-sight.webp" }]];
			if (/FROM athena_gm_badge_award/.test(sql)) return [[{ actor_id: 3 }, { actor_id: 9 }]];
			throw Error(`Unexpected query: ${sql}`);
		});
		try {
			const game = await ispy.state(thomas);
			expect(game.done).toBe(12);
			expect(game.finale.badge).toMatchObject({ key: "first-sight", name: "First Sight" });
			expect(game.finale.earners).toEqual([
				{ name: "Thomas", athena: false, me: true, earned: true },
				{ name: "Skylar", athena: false, me: false, earned: false },
				{ name: "Athena", athena: true, me: false, earned: true },
			]);
			expect(game.finale.rounds).toHaveLength(12);
			expect(game.finale.rounds[0]).toMatchObject({ roundNo: 1, spy: "Thomas", athena: false, answer: "thing 1" });
			expect(game.finale.stats.spotted + game.finale.stats.taught + game.finale.stats.solvedByKids).toBe(12);
			expect(pool.query.mock.calls.some(([sql]) => /^(INSERT|UPDATE)/.test(sql))).toBe(false);
		} finally { actors.mockRestore(); pool.query.mockReset(); }
	});

	test("a failed first look can be retried only by its spy, without another photo or round", async () => {
		const pool = require("../../helpers/db");
		const missions = require("./index");
		const scout = require("./scout");
		const thomas = { id: 3, kind: "kid", family_id: 1, display_name: "Thomas" };
		const skylar = { id: 4, kind: "kid", family_id: 1, display_name: "Skylar" };
		const athena = { id: 9, kind: "assistant", family_id: 1, display_name: "Athena" };
		const round = { id: 5, uuid: "r1", mission_id: 7, round_no: 1, spy_actor_id: 3, photo_id: 11, clue: "something blue", answer: "cup", guesses: JSON.stringify([{ by: 4, text: "lamp", right: false }]), outcome: null };
		const actorLookup = jest.spyOn(missions, "actorByKey").mockImplementation(async (_f, key) => ({ thomas, skylar, athena })[key]);
		const photoRead = jest.spyOn(scout, "readProofPhoto").mockResolvedValue(Buffer.alloc(2000, 1));
		pool.query.mockReset();
		pool.query.mockImplementation(async (sql, args) => {
			if (/FROM athena_gm_mission m/.test(sql)) return [[{ id: 7, uuid: "m", family_id: 1, title: "I Spy", plan: { game: { kind: "ispy", rounds: 12, players: ["thomas", "skylar", "athena"] } } }]];
			if (/FROM athena_gm_mission_step/.test(sql)) return [[]];
			if (/FROM athena_gm_ispy_round WHERE uuid/.test(sql)) {
				expect(args).toEqual(["r1", 7]);
				return [[{ ...round }]];
			}
			if (/FROM athena_gm_ispy_round WHERE mission_id/.test(sql)) return [[{ ...round }]];
			if (/FROM athena_gm_photo/.test(sql)) return [[{ object_path: "existing-photo", content_type: "image/jpeg" }]];
			if (/^UPDATE athena_gm_ispy_round/.test(sql)) { round.guesses = args[0]; return [{}]; }
			throw Error(`Unexpected query: ${sql}`);
		});
		const llm = { generateJson: jest.fn().mockRejectedValueOnce(Error("offline")).mockResolvedValue({ data: { guess: "blue cup" } }) };
		try {
			await expect(ispy.retryGuess(skylar, "r1", llm)).rejects.toMatchObject({ status: 403 });
			expect(llm.generateJson).not.toHaveBeenCalled();
			const busy = { query: jest.fn().mockResolvedValue([[{ locked: 0 }]]), release: jest.fn() };
			pool.getConnection.mockResolvedValueOnce(busy);
			await expect(ispy.retryGuess(thomas, "r1", llm)).rejects.toMatchObject({ status: 409 });
			expect(busy.release).toHaveBeenCalledTimes(1);
			expect(llm.generateJson).not.toHaveBeenCalled();
			await expect(ispy.retryGuess(thomas, "r1", llm)).rejects.toMatchObject({ status: 503 });
			expect(JSON.parse(round.guesses)).toHaveLength(1);
			const result = await ispy.retryGuess(thomas, "r1", llm);
			expect(result.round.awaitingJudge).toBe(true);
			expect(result.round.guesses.at(-1)).toMatchObject({ text: "blue cup", right: null });
			await expect(ispy.retryGuess(thomas, "r1", llm)).rejects.toMatchObject({ status: 409 });
			expect(llm.generateJson).toHaveBeenCalledTimes(2);
			expect(pool.query.mock.calls.some(([sql]) => /^INSERT/.test(sql))).toBe(false);
		} finally { actorLookup.mockRestore(); photoRead.mockRestore(); pool.query.mockReset(); }
	});

	test("a child's round alternates both guessers, hides the secret, and still returns its finished game", async () => {
		const pool = require("../../helpers/db");
		const missions = require("./index");
		const scout = require("./scout");
		const thomas = { id: 3, kind: "kid", family_id: 1, display_name: "Thomas" };
		const skylar = { id: 4, kind: "kid", family_id: 1, display_name: "Skylar" };
		const athena = { id: 9, kind: "assistant", family_id: 1, display_name: "Athena" };
		const round = { id: 5, uuid: "r1", mission_id: 7, round_no: 1, spy_actor_id: 3, photo_id: 11, clue: "something red", answer: "red cup", guesses: "[]", outcome: null };
		let completed = 0;
		const record = jest.spyOn(missions, "recordTest").mockResolvedValue({});
		const actors = jest.spyOn(missions, "actorByKey").mockImplementation(async (_f, key) => ({ thomas, skylar, athena })[key]);
		const photos = jest.spyOn(scout, "readProofPhoto").mockResolvedValue(Buffer.alloc(2000, 1));
		const finish = jest.spyOn(missions, "completeStep").mockImplementation(async () => { completed++; });
		pool.query.mockReset();
		pool.query.mockImplementation(async (sql, args) => {
			if (/FROM athena_gm_mission m/.test(sql)) return completed === 2 && !sql.includes("m.status = 'completed'") ? [[]] : [[{ id: 7, uuid: "m", family_id: 1, title: "I Spy", plan: { game: { kind: "ispy", rounds: 1, players: ["thomas", "skylar", "athena"] } } }]];
			if (/FROM athena_gm_mission_step/.test(sql)) return [[{ id: 101, status: "waiting_kids" }, { id: 102, status: "waiting_kids" }]];
			if (/FROM athena_gm_ispy_round WHERE uuid/.test(sql)) { expect(args).toEqual(["r1", 7]); return [[{ ...round }]]; }
			if (/FROM athena_gm_ispy_round WHERE mission_id/.test(sql)) return [[{ ...round }]];
			if (/FROM athena_gm_photo/.test(sql)) return [[{ object_path: "existing", content_type: "image/jpeg" }]];
			if (/^UPDATE athena_gm_ispy_round/.test(sql)) { Object.assign(round, { guesses: args[0], hints: args[1], clues: args[2], clue_asked_by: args[3], outcome: args[4], solved_by_actor_id: args[5] }); return [{}]; }
			throw Error(`Unexpected query: ${sql}`);
		});
		const llm = { generateJson: jest.fn().mockResolvedValue({ data: { guess: "lamp", aside: "My noodle detector is wobbling!" } }) };
		try {
			await expect(ispy.guess(thomas, "r1", "red cup", llm)).rejects.toMatchObject({ status: 409 });
			expect(llm.generateJson).not.toHaveBeenCalled();
			const missed = await ispy.guess(skylar, "r1", "chair", llm);
			expect(missed).toMatchObject({ right: null, round: { answer: null, awaitingJudge: true } });
			expect(llm.generateJson).not.toHaveBeenCalled();
			await expect(ispy.judge(skylar, "r1", { right: true }, llm)).rejects.toMatchObject({ status: 403 });
			const afterJudgment = await ispy.judge(thomas, "r1", { right: false }, llm);
			expect(afterJudgment.round.guesses.map(g => g.by)).toEqual(["Skylar", "Athena"]);
			expect(llm.generateJson.mock.calls[0][0].contents[0].parts[0].text).not.toContain("red cup");
			await expect(ispy.guess(skylar, "r1", "red cup", llm)).rejects.toMatchObject({ status: 409 });
			await ispy.judge(thomas, "r1", { right: false }, llm);
			const clue = await ispy.giveClue(thomas, "r1", "none", llm);
			expect(clue.round.guesser).toMatchObject({ name: "Skylar", me: false });
			expect(llm.generateJson).toHaveBeenCalledTimes(1);
			const synonym = await ispy.guess(skylar, "r1", "mug", llm);
			expect(synonym).toMatchObject({ right: null, round: { awaitingJudge: true } });
			const won = await ispy.judge(thomas, "r1", { right: true }, llm);
			expect(won).toMatchObject({ done: 1, goal: 1, round: null });
			expect(won.recent[0]).toMatchObject({ solvedBy: "Skylar", answer: "red cup" });
			expect(completed).toBe(2);
			expect(record).toHaveBeenCalledWith(1, "ispy", expect.objectContaining({ passed: false, actorId: 3 }));
		} finally { actors.mockRestore(); photos.mockRestore(); finish.mockRestore(); record.mockRestore(); pool.query.mockReset(); }
	});

	test("a parent's practice round grades like the real game and stores nothing", async () => {
		const pool = require("../../helpers/db");
		pool.query.mockClear();
		expect(ispy.demoCheck({ guess: "the sofa", answer: "couch", aliases: ["sofa"] })).toEqual({ right: true });
		expect(ispy.demoCheck({ guess: "lamp", answer: "couch" })).toEqual({ right: false });
		const image = Buffer.alloc(2000, 1).toString("base64");
		const llm = { generateJson: jest.fn()
			.mockResolvedValueOnce({ data: { guess: "blue cup" } })
			.mockResolvedValueOnce({ data: { answer: "lamp", clue: "yellow", aliases: ["light"], hints: ["on the table"] } }) };
		await expect(ispy.demoGuess({ imageBase64: image, contentType: "image/jpeg", clue: "something blue", wrong: ["sky"] }, llm)).resolves.toMatchObject({ guess: "blue cup" });
		expect(llm.generateJson.mock.calls[0][0].contents[0].parts[0].text).toContain("\"sky\"");
		await expect(ispy.demoPick({ imageBase64: image, contentType: "image/jpeg" }, llm)).resolves.toEqual({ clue: "something yellow", answer: "lamp", aliases: ["light"], hints: ["on the table"] });
		await expect(ispy.demoGuess({ imageBase64: image, clue: "x" }, llm)).rejects.toMatchObject({ status: 400 });
		expect(pool.query).not.toHaveBeenCalled();
	});
});
