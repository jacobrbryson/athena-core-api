jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./connectors/gmail", () => ({ history: jest.fn(), mailboxHistoryId: jest.fn(), listInbox: jest.fn(), getMessage: jest.fn() }));
jest.mock("./emailTriage", () => ({ alreadyTriaged: jest.fn(), insertPending: jest.fn() }));
const pool = require("../helpers/db");
const gmail = require("./connectors/gmail");
const triage = require("./emailTriage");
const { sync, syncIfStale, changesFrom } = require("./emailSync");

let state, leaseFree, openRows, updates;
beforeEach(() => {
	jest.clearAllMocks();
	state = { profile_id: 7, history_id: "100", synced_at: null };
	leaseFree = true;
	openRows = [];
	updates = [];
	pool.query.mockImplementation(async (sql, args) => {
		if (sql.startsWith("INSERT IGNORE INTO email_sync_state")) return [{}];
		if (sql.includes("SET lease_until = DATE_ADD")) return [{ affectedRows: leaseFree ? 1 : 0 }];
		if (sql.startsWith("SELECT * FROM email_sync_state")) return [[state]];
		if (sql.startsWith("SELECT synced_at")) return [[state]];
		if (sql.includes("SELECT gmail_message_id FROM email_triage")) return [openRows.map((id) => ({ gmail_message_id: id }))];
		if (sql.startsWith("UPDATE email_triage SET status")) {
			updates.push({ to: args[0], from: args[2], ids: args[3] });
			return [{ affectedRows: args[3].length }];
		}
		if (sql.startsWith("UPDATE email_sync_state")) {
			updates.push({ state: sql, args });
			return [{}];
		}
		throw new Error(`unexpected SQL: ${sql}`);
	});
	triage.alreadyTriaged.mockResolvedValue(new Set());
	triage.insertPending.mockImplementation(async (_p, ids) => ids.length);
});

const added = (id, labelIds = ["INBOX", "UNREAD"]) => ({ messagesAdded: [{ message: { id, labelIds } }] });
const labelled = (kind, id, labelIds) => ({ [kind]: [{ message: { id }, labelIds }] });

test("history is read in order: the last word on each message wins", () => {
	const where = changesFrom([
		added("a"),
		added("sent", ["SENT"]),
		labelled("labelsRemoved", "b", ["INBOX"]),
		labelled("labelsRemoved", "c", ["INBOX"]),
		labelled("labelsAdded", "c", ["INBOX"]),
		labelled("labelsAdded", "d", ["TRASH"]),
		{ messagesDeleted: [{ message: { id: "e" } }] },
	]);
	expect(Object.fromEntries(where)).toEqual({ a: "in", b: "out", c: "in", d: "out", e: "out" });
});

test("an incremental pass marks archived mail gone, restores returned mail and records new mail as pending", async () => {
	gmail.history.mockResolvedValue({ historyId: "150", history: [added("new1"), added("known"), labelled("labelsRemoved", "old", ["INBOX"])] });
	triage.alreadyTriaged.mockResolvedValue(new Set(["known"]));
	const r = await sync(7);
	expect(r).toMatchObject({ mode: "incremental", added: 1, deferred: 0 });
	expect(gmail.history).toHaveBeenCalledWith(7, { startHistoryId: "100", pageToken: undefined });
	expect(updates).toEqual(expect.arrayContaining([
		{ to: "gone", from: "new", ids: ["old"] },
		{ to: "new", from: "gone", ids: ["new1", "known"] },
	]));
	expect(triage.insertPending).toHaveBeenCalledWith(7, ["new1"]);
	const saved = updates.find((u) => u.state?.includes("history_id = ?"));
	expect(saved.args).toEqual(["150", 7]);
});

test("more new mail than a pass takes is deferred to the next Scan more, not lost", async () => {
	gmail.history.mockResolvedValue({ historyId: "150", history: ["a", "b", "c"].map((id) => added(id)) });
	const r = await sync(7, { maxNew: 2 });
	expect(triage.insertPending).toHaveBeenCalledWith(7, ["a", "b"]);
	expect(r.deferred).toBe(1);
});

test("a history too long for one pass resumes after the last record read", async () => {
	gmail.history.mockImplementation(async (_p, { pageToken }) => ({
		historyId: "999", nextPageToken: "more", history: [{ id: String(200 + (Number(pageToken?.slice(1)) || 0)), ...added(`m${pageToken || 0}`) }],
	}));
	await sync(7);
	expect(gmail.history).toHaveBeenCalledTimes(10);
	const saved = updates.find((u) => u.state?.includes("history_id = ?"));
	expect(saved.args[0]).not.toBe("999");
});

test("an expired cursor starts over: historyId is taken before the inbox is listed, and closed mail is marked gone", async () => {
	gmail.history.mockRejectedValue(Object.assign(new Error("not found"), { providerStatus: 404 }));
	const order = [];
	gmail.mailboxHistoryId.mockImplementation(async () => { order.push("historyId"); return "500"; });
	gmail.listInbox.mockImplementation(async () => { order.push("list"); return { messages: [{ id: "x" }] }; });
	openRows = ["x", "archived"];
	const r = await sync(7);
	expect(order).toEqual(["historyId", "list"]);
	expect(r).toMatchObject({ mode: "bootstrap", gone: 1, unverified: 0 });
	expect(updates).toContainEqual({ to: "gone", from: "new", ids: ["archived"] });
	const saved = updates.find((u) => u.state?.includes("history_id = ?"));
	expect(saved.state).toContain("reconciled_at = NOW(3)");
	expect(saved.args).toEqual(["500", 7]);
});

test("an inbox too big to list fully checks unlisted rows one by one, and says how many it could not", async () => {
	state.history_id = null;
	gmail.mailboxHistoryId.mockResolvedValue("500");
	gmail.listInbox.mockResolvedValue({ messages: [{ id: "x" }], nextPageToken: "always" });
	gmail.getMessage.mockImplementation(async (_p, id) => {
		if (id === "deleted") throw Object.assign(new Error("gone"), { providerStatus: 404 });
		return { labelIds: id === "still" ? ["INBOX"] : ["CATEGORY_UPDATES"] };
	});
	openRows = ["x", "still", "archived", "deleted", "unchecked"];
	const r = await sync(7, { verifyLimit: 3 });
	expect(updates).toContainEqual({ to: "gone", from: "new", ids: ["archived", "deleted"] });
	expect(r.unverified).toBe(1);
	const saved = updates.find((u) => u.state?.includes("history_id = ?"));
	expect(saved.state).not.toContain("reconciled_at");
});

test("another pass holding the lease means this one reads nothing", async () => {
	leaseFree = false;
	expect(await sync(7)).toEqual({ skipped: "busy" });
	expect(gmail.history).not.toHaveBeenCalled();
});

test("a failure releases the lease, records why and still throws", async () => {
	gmail.history.mockRejectedValue(Object.assign(new Error("quota"), { providerStatus: 429 }));
	await expect(sync(7)).rejects.toThrow("quota");
	const failed = updates.find((u) => u.state?.includes("last_error = ?"));
	expect(failed.args).toEqual(["quota", 7]);
});

test("the dashboard only syncs when the last pass is over five minutes old", async () => {
	state.synced_at = new Date(Date.now() - 60_000);
	expect(await syncIfStale(7)).toEqual({ skipped: "fresh" });
	state.synced_at = new Date(Date.now() - 6 * 60_000);
	gmail.history.mockResolvedValue({ historyId: "101", history: [] });
	expect(await syncIfStale(7)).toMatchObject({ mode: "incremental" });
});
