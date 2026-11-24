jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
const pool = require("../../helpers/db");
const missions = require("./index");

const UUID = "dfea9943-3d54-4a2b-b30b-2d104d4175f4";

/** Every read of the mission returns this row; writes are recorded. */
function withMission(row) {
	pool.query.mockReset();
	pool.query.mockImplementation(async (sql) => (/^SELECT/.test(sql) ? [/athena_gm_mission WHERE/.test(sql) ? [{ id: 46, uuid: UUID, family_id: 1, source: "athena", ...row }] : []] : [{ affectedRows: 1, insertId: 1 }]));
}
const writes = () => pool.query.mock.calls.filter(([sql]) => /^UPDATE athena_gm_mission SET planned_for/.test(sql));

describe("a mission's planned start (the kids' countdown)", () => {
	test("an approved mission that hasn't gone live takes a time, and only the time changes", async () => {
		withMission({ status: "running", phase: "prep" });
		const at = new Date(Date.now() + 86400000).toISOString();
		await missions.setPlannedFor(1, UUID, at, 2);
		expect(writes()).toHaveLength(1);
		expect(writes()[0][1][0].toISOString()).toBe(at);
	});

	test("clearing it writes null", async () => {
		withMission({ status: "running", phase: "ready" });
		await missions.setPlannedFor(1, UUID, null, 2);
		expect(writes()[0][1][0]).toBeNull();
	});

	test("a live, finished or legacy mission, a bad date or one too far out is refused", async () => {
		const soon = new Date(Date.now() + 3600000).toISOString();
		for (const row of [{ status: "running", phase: "live" }, { status: "completed", phase: "debrief" }, { status: "completed", source: "legacy" }]) {
			withMission(row);
			await expect(missions.setPlannedFor(1, UUID, soon)).rejects.toMatchObject({ status: 409 });
		}
		withMission({ status: "running", phase: "prep" });
		await expect(missions.setPlannedFor(1, UUID, "not a date")).rejects.toMatchObject({ status: 400 });
		await expect(missions.setPlannedFor(1, UUID, new Date(Date.now() + 100 * 86400000).toISOString())).rejects.toMatchObject({ status: 400 });
		expect(writes()).toHaveLength(0);
	});
});
