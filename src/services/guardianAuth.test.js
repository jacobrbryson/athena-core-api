jest.mock("../helpers/db", () => ({ query: jest.fn() }));

const pool = require("../helpers/db");
const { resolveActiveAdventure } = require("./guardianAuth");

const GUARDIAN_ID = "20250202";
const PRIMARY = "lake_norman_guardians";
const ENROLLMENTS = [
	{ adventure_key: PRIMARY },
	{ adventure_key: "rescue_ratatouille" },
];

beforeEach(() => {
	pool.query.mockReset();
});

describe("guardian campaign scheduling", () => {
	test("keeps a dual-enrolled guardian in their primary campaign before Ratatouille starts", async () => {
		pool.query
			.mockResolvedValueOnce([ENROLLMENTS])
			.mockResolvedValueOnce([
				[
					{ adventure_key: PRIMARY, state: "active", has_started: 1, has_ended: 0 },
					{
						adventure_key: "rescue_ratatouille",
						state: "pending",
						has_started: 0,
						has_ended: 0,
					},
				],
			]);

		await expect(resolveActiveAdventure(GUARDIAN_ID, PRIMARY)).resolves.toBe(PRIMARY);
		expect(pool.query).toHaveBeenCalledTimes(2);
	});

	test("activates and selects Ratatouille on the first login inside its window", async () => {
		pool.query
			.mockResolvedValueOnce([ENROLLMENTS])
			.mockResolvedValueOnce([
				[
					{ adventure_key: PRIMARY, state: "active", has_started: 1, has_ended: 0 },
					{
						adventure_key: "rescue_ratatouille",
						state: "pending",
						has_started: 1,
						has_ended: 0,
					},
				],
			])
			.mockResolvedValueOnce([{ affectedRows: 1 }]);

		await expect(resolveActiveAdventure(GUARDIAN_ID, PRIMARY)).resolves.toBe(
			"rescue_ratatouille"
		);
	});

	test("ends Ratatouille and returns to the primary campaign after its window", async () => {
		pool.query
			.mockResolvedValueOnce([ENROLLMENTS])
			.mockResolvedValueOnce([
				[
					{ adventure_key: PRIMARY, state: "active", has_started: 1, has_ended: 0 },
					{
						adventure_key: "rescue_ratatouille",
						state: "active",
						has_started: 1,
						has_ended: 1,
					},
				],
			])
			.mockResolvedValueOnce([{ affectedRows: 1 }]);

		await expect(resolveActiveAdventure(GUARDIAN_ID, PRIMARY)).resolves.toBe(PRIMARY);
		expect(pool.query.mock.calls[2][0]).toContain("SET state = 'ended'");
	});
});
