jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
const pool = require("../../helpers/db");
const badges = require("./badges");

/** Answers by the SQL's first words; records inserts. */
function db({ badge, kids = [], athena = { id: 1 } }) {
	pool.query.mockReset();
	pool.query.mockImplementation(async (sql) => {
		if (/FROM athena_gm_badge WHERE mission_id/.test(sql)) return [badge ? [badge] : []];
		if (/FROM athena_gm_mission_step/.test(sql)) return [kids.map((id) => ({ id }))];
		if (/kind = 'assistant'/.test(sql)) return [athena ? [athena] : []];
		return [{ affectedRows: 1 }];
	});
}
const awarded = () => pool.query.mock.calls.filter(([sql]) => /INSERT IGNORE INTO athena_gm_badge_award/.test(sql)).map(([, p]) => p[1]);

describe("mission badges", () => {
	test("each kid who did their part earns a finished mission's badge, and Athena when it's shared with her", async () => {
		db({ badge: { id: 9, with_athena: 1 }, kids: [3, 4] });
		await expect(badges.awardMission({ id: 46, family_id: 1, status: "completed" })).resolves.toEqual([3, 4, 1]);
		expect(awarded()).toEqual([3, 4, 1]);
	});

	test("a badge that isn't hers goes to the kids only", async () => {
		db({ badge: { id: 2, with_athena: 0 }, kids: [3] });
		await badges.awardMission({ id: 50, family_id: 1, status: "completed" });
		expect(awarded()).toEqual([3]);
	});

	test("a stopped mission, or one with no badge, gives nothing", async () => {
		db({ badge: { id: 9, with_athena: 1 }, kids: [3] });
		await expect(badges.awardMission({ id: 46, family_id: 1, status: "stopped" })).resolves.toEqual([]);
		db({ badge: null, kids: [3] });
		await expect(badges.awardMission({ id: 47, family_id: 1, status: "completed" })).resolves.toEqual([]);
		expect(awarded()).toEqual([]);
	});
});
