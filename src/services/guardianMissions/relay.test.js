jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
const pool = require("../../helpers/db");
const relay = require("./relay");
const team = require("./team");

const NOW = new Date("2026-11-24T18:00:00Z");

describe("Signal Relay runs", () => {
	beforeEach(() => pool.query.mockReset());

	test("a run from the tablet keeps its id, and its time is clamped to now", () => {
		const run = relay.cleanRun({ id: "8f1c2d3e-aaaa-bbbb", at: "2026-11-25T00:00:00Z", messages: 5, wpm: 6.4 }, NOW);
		expect(run).toEqual({ id: "8f1c2d3e-aaaa-bbbb", finishedAt: NOW, messages: 5, wpm: 6 });
	});

	test("a run that can't be one is dropped: bad id, no messages, too old, no time", () => {
		expect(relay.cleanRun({ id: "x", at: NOW, messages: 5 }, NOW)).toBeNull();
		expect(relay.cleanRun({ id: "abc123; DROP", at: NOW, messages: 5 }, NOW)).toBeNull();
		expect(relay.cleanRun({ id: "abcdef12", at: NOW, messages: 0 }, NOW)).toBeNull();
		expect(relay.cleanRun({ id: "abcdef12", at: "2026-09-01T00:00:00Z", messages: 5 }, NOW)).toBeNull();
		expect(relay.cleanRun({ id: "abcdef12", at: "never", messages: 5 }, NOW)).toBeNull();
		expect(relay.cleanRun(null, NOW)).toBeNull();
	});

	test("runs are written for the kid's own actor, and a repeat is ignored by the database", async () => {
		pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
		const out = await relay.record({ id: 7 }, [{ id: "run-aaaa-1", at: NOW.toISOString(), messages: 5, wpm: 7 }, { id: "bad" }], NOW);
		expect(out).toEqual({ saved: 1 });
		const [sql, [rows]] = pool.query.mock.calls[0];
		expect(sql).toMatch(/INSERT IGNORE INTO athena_gm_relay_run/);
		expect(rows).toEqual([[7, "run-aaaa-1", NOW, 5, 7]]);
	});

	test("nothing usable posts nothing", async () => {
		expect(await relay.record({ id: 7 }, "nope", NOW)).toEqual({ saved: 0 });
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("counted runs cap each day in SQL, and a missing table counts none", async () => {
		pool.query.mockResolvedValueOnce([[{ actor_id: 3, runs: "4" }]]);
		expect(await relay.countedRuns([3, 3, 9])).toEqual(new Map([[3, 4]]));
		expect(pool.query.mock.calls[0][1]).toEqual([relay.RELAY_RUNS_PER_DAY, [3, 9]]);
		pool.query.mockRejectedValueOnce(new Error("ER_NO_SUCH_TABLE"));
		expect(await relay.countedRuns([3])).toEqual(new Map());
		expect(await relay.countedRuns([])).toEqual(new Map());
	});

	test("each counted run is five points", () => {
		expect(team.standing({ relays: 1 })).toMatchObject({ level: 1, xp: 5 });
		expect(team.standing({ relays: 5 })).toMatchObject({ level: 2, xp: 0 });
	});
});
