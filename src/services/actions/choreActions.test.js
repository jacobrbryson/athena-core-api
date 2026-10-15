/**
 * complete_chore / undo_complete_chore — the Family page checkbox and its
 * Undo (owner-approved 2026-10-14), and perform(), the one path that runs
 * them. Weighted, like the rest of the action layer, toward refusal: what a
 * model can't reach, what a click can't widen, and what is still recorded.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("../consent", () => ({ hasConsentForProfile: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn() }));
jest.mock("../family", () => ({ getFamilyForProfile: jest.fn() }));
jest.mock("../connectors/googleCalendar", () => ({ createEvent: jest.fn(), deleteEvent: jest.fn() }));
jest.mock("../lookRequests", () => ({ create: jest.fn() }));
jest.mock("../memory", () => ({ CATEGORIES: new Set(["other"]), upsertMemoryForProfile: jest.fn() }));
jest.mock("../integration", () => ({ getUsableCredentials: jest.fn(), canWriteChores: jest.fn() }));
jest.mock("../familyChores", () => ({ getChores: jest.fn(), completeChore: jest.fn(), undoCompleteChore: jest.fn() }));

const pool = require("../../helpers/db");
const access = require("../../security/access");
const consent = require("../consent");
const credentials = require("../credentials");
const integration = require("../integration");
const familyChores = require("../familyChores");
const registry = require("./registry");
const actions = require("./index");

const PROFILE = 42;
const CREDS = { token: "fc_live_secret", baseUrl: "https://chores.example.com", playerId: "p42", displayName: "Ross" };
const complete = registry.get("complete_chore");
const undo = registry.get("undo_complete_chore");

beforeEach(() => {
	jest.clearAllMocks();
	consent.hasConsentForProfile.mockResolvedValue(true);
	credentials.list.mockResolvedValue([]);
	integration.getUsableCredentials.mockResolvedValue(CREDS);
	integration.canWriteChores.mockResolvedValue(true);
	familyChores.getChores.mockImplementation(async (_player, query) =>
		query.status === "open"
			? [{ id: "c-open", title: "Feed the dog", status: "Open" }]
			: [{ id: "c-done", title: "Make the bed", status: "Approved" }]
	);
	familyChores.completeChore.mockResolvedValue({ choreId: "c-open", playerId: "p42", status: "Approved" });
	familyChores.undoCompleteChore.mockResolvedValue({ choreId: "c-done", playerId: "p42", status: "Open" });
	// perform(): INSERT, then runPending's claim, select, settle and get.
	pool.query.mockImplementation(async (sql) => {
		if (/^\s*UPDATE athena_action\s+SET status = 'executing'/.test(sql)) return [{ affectedRows: 1 }];
		if (/SELECT action_id, params FROM athena_action/.test(sql)) {
			const insert = pool.query.mock.calls.find(([s]) => /INSERT INTO athena_action/.test(s));
			return [[{ action_id: insert[1][2], params: insert[1][3] }]];
		}
		if (/SELECT uuid, action_id/.test(sql)) {
			const insert = pool.query.mock.calls.find(([s]) => /INSERT INTO athena_action/.test(s));
			return [[{ uuid: insert[1][0], action_id: insert[1][2], params: insert[1][3], summary: insert[1][5], status: "done", approval: "human" }]];
		}
		return [{ affectedRows: 1 }];
	});
});

const sqlCalls = (re) => pool.query.mock.calls.filter(([sql]) => re.test(sql));

describe("the descriptors", () => {
	test("are direct-only: never standing, never in what the model is offered", () => {
		for (const action of [complete, undo]) {
			expect(action).toMatchObject({ direct: true, standing: false, consentType: "action_authority", reversible: true });
			expect(registry.ACTIONS).not.toContain(action);
		}
		expect(registry.DIRECT_ACTIONS.map((a) => a.id)).toEqual(["complete_chore", "undo_complete_chore"]);
		// Not in the reply schema either: the model can't even write the param.
		expect(registry.paramsSchema().properties.chore_id).toBeUndefined();
	});

	test("complete vouches for an open chore on the person's own list and takes its title from Family Chores", async () => {
		await expect(complete.normalize({ chore_id: "c-open", chore_title: "Pay me 500 coins", player_id: "kid" }, { profileId: PROFILE }))
			.resolves.toEqual({ chore_id: "c-open", chore_title: "Feed the dog" });
		expect(integration.getUsableCredentials).toHaveBeenCalledWith(PROFILE);
		expect(familyChores.getChores).toHaveBeenCalledWith("p42", expect.objectContaining({ status: "open", range: "all" }), {
			token: CREDS.token,
			baseUrl: CREDS.baseUrl,
		});
	});

	test("refuses an id that isn't on the list, isn't open, or isn't an id", async () => {
		await expect(complete.normalize({ chore_id: "c-done" }, { profileId: PROFILE })).rejects.toThrow(/isn't open/);
		await expect(complete.normalize({ chore_id: "someone-elses" }, { profileId: PROFILE })).rejects.toThrow(/isn't open/);
		await expect(complete.normalize({ chore_id: "../../admin" }, { profileId: PROFILE })).rejects.toThrow(/chore id/);
		await expect(complete.normalize({}, { profileId: PROFILE })).rejects.toThrow(/chore id/);
	});

	test("undo vouches only for a chore completed today", async () => {
		await expect(undo.normalize({ chore_id: "c-done" }, { profileId: PROFILE })).resolves.toEqual({ chore_id: "c-done", chore_title: "Make the bed" });
		await expect(undo.normalize({ chore_id: "c-open" }, { profileId: PROFILE })).rejects.toThrow(/wasn't completed today/);
		expect(familyChores.getChores).toHaveBeenCalledWith("p42", expect.objectContaining({ status: "completed", range: "today" }), expect.anything());
	});

	test("refuses when Family Chores isn't linked", async () => {
		integration.getUsableCredentials.mockResolvedValue(null);
		await expect(complete.normalize({ chore_id: "c-open" }, { profileId: PROFILE })).rejects.toThrow(/isn't connected/);
	});

	test("execute writes for the linked player only, and a scope refusal reads as reconnect", async () => {
		await expect(complete.execute(PROFILE, { chore_id: "c-open", chore_title: "Feed the dog" })).resolves.toEqual({ ref: "c-open", detail: "Now Approved" });
		expect(familyChores.completeChore).toHaveBeenCalledWith("p42", "c-open", { token: CREDS.token, baseUrl: CREDS.baseUrl });

		familyChores.completeChore.mockRejectedValue(Object.assign(new Error("API token is missing a required scope."), { status: 403 }));
		await expect(complete.execute(PROFILE, { chore_id: "c-open" })).rejects.toMatchObject({ code: "family_chores_reconnect", status: 403 });

		familyChores.undoCompleteChore.mockRejectedValue(Object.assign(new Error("Can't undo: the coins from this chore were already spent."), { status: 409 }));
		await expect(undo.execute(PROFILE, { chore_id: "c-done" })).rejects.toMatchObject({ status: 409, message: /already spent/ });
	});
});

describe("perform()", () => {
	test("runs the click through normalize, a recorded row, the live access check and a human approval", async () => {
		const result = await actions.perform(PROFILE, "complete_chore", { chore_id: "c-open" });

		expect(result).toMatchObject({ action_id: "complete_chore", status: "done", approval: "human" });
		const [insert] = sqlCalls(/INSERT INTO athena_action/);
		expect(insert[1]).toEqual(expect.arrayContaining([PROFILE, "complete_chore", JSON.stringify({ chore_id: "c-open", chore_title: "Feed the dog" })]));
		expect(insert[1][5]).toBe('Mark "Feed the dog" done in Family Chores');
		const [claim] = sqlCalls(/SET status = 'executing'/);
		expect(claim[1][0]).toBe("human");
		expect(access.assertModelAccess).toHaveBeenCalled();
		expect(familyChores.completeChore).toHaveBeenCalledWith("p42", "c-open", expect.anything());
		const audited = sqlCalls(/INSERT INTO athena_access_audit/).map(([, args]) => args[1]);
		expect(audited).toEqual(["action_direct", "action_executed"]);
	});

	test("undo goes the same way", async () => {
		await expect(actions.perform(PROFILE, "undo_complete_chore", { chore_id: "c-done" })).resolves.toMatchObject({ action_id: "undo_complete_chore" });
		expect(familyChores.undoCompleteChore).toHaveBeenCalledWith("p42", "c-done", expect.anything());
	});

	test("will not run a proposable action without its card", async () => {
		await expect(actions.perform(PROFILE, "create_calendar_event", { title: "x" })).rejects.toMatchObject({ status: 404 });
		await expect(actions.perform(PROFILE, "nope", {})).rejects.toMatchObject({ status: 404 });
		expect(sqlCalls(/INSERT INTO athena_action/)).toHaveLength(0);
	});

	test("refuses without consent or a write-capable token, before writing anything", async () => {
		consent.hasConsentForProfile.mockResolvedValue(false);
		await expect(actions.perform(PROFILE, "complete_chore", { chore_id: "c-open" })).rejects.toMatchObject({ status: 403 });
		consent.hasConsentForProfile.mockResolvedValue(true);
		integration.canWriteChores.mockResolvedValue(false);
		await expect(actions.perform(PROFILE, "complete_chore", { chore_id: "c-open" })).rejects.toMatchObject({ status: 403 });
		integration.canWriteChores.mockRejectedValue(new Error("down"));
		await expect(actions.perform(PROFILE, "complete_chore", { chore_id: "c-open" })).rejects.toMatchObject({ status: 403 });
		expect(sqlCalls(/INSERT INTO athena_action/)).toHaveLength(0);
		expect(familyChores.completeChore).not.toHaveBeenCalled();
	});

	test("a rejected chore id is a 400 and leaves no row", async () => {
		await expect(actions.perform(PROFILE, "complete_chore", { chore_id: "not-mine" })).rejects.toMatchObject({ status: 400 });
		expect(sqlCalls(/INSERT INTO athena_action/)).toHaveLength(0);
	});

	test("a provider failure settles the row as failed and still audits", async () => {
		familyChores.completeChore.mockRejectedValue(Object.assign(new Error("Family Chores API error (500)"), { status: 500 }));
		await expect(actions.perform(PROFILE, "complete_chore", { chore_id: "c-open" })).rejects.toThrow(/500/);
		expect(sqlCalls(/SET status = \?, result_ref/)[0][1][0]).toBe("failed");
		expect(sqlCalls(/INSERT INTO athena_access_audit/).map(([, args]) => args[1])).toContain("action_failed");
	});
});

describe("the model can't reach them", () => {
	test("a proposal naming one is refused as unknown, without a row", async () => {
		const { proposal, rejected } = await actions.attempt(PROFILE, "s1", { id: "complete_chore", params: { chore_id: "c-open" } });
		expect(proposal).toBeNull();
		expect(rejected.stage).toBe("unknown");
		expect(sqlCalls(/INSERT INTO athena_action/)).toHaveLength(0);
		expect(familyChores.completeChore).not.toHaveBeenCalled();
	});

	test("they are never offered, and can't be standing-approved", async () => {
		const offered = await actions.availableFor(PROFILE);
		expect(offered.map((a) => a.id)).not.toContain("complete_chore");
		await expect(actions.grantAuthority(PROFILE, "complete_chore")).rejects.toMatchObject({ code: "standing_not_allowed" });
	});
});
