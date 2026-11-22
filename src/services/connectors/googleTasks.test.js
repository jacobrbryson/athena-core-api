/**
 * Google Tasks (owner, 2026-11-12): the connector's reads and writes, and the
 * three approval-gated actions that manage a task.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("../consent", () => ({ hasConsentForProfile: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn() }));
jest.mock("../family", () => ({ getFamilyForProfile: jest.fn() }));
jest.mock("../lookRequests", () => ({ create: jest.fn() }));
jest.mock("../memory", () => ({ CATEGORIES: new Set(["other"]), upsertMemoryForProfile: jest.fn() }));
jest.mock("./http", () => ({
	providerGet: jest.fn(),
	providerRequest: jest.fn(),
	isNotConnected: (err) => err && err.code === "not_connected",
}));

const http = require("./http");
const tasks = require("./googleTasks");
const connectorRegistry = require("./registry");
const actions = require("../actions/registry");

const ctx = { profileId: 7 };
const LISTS = { items: [{ id: "L1", title: "My Tasks" }, { id: "L2", title: "House" }] };
const TASKS = {
	L1: [{ id: "t1", title: "Call the dentist", status: "needsAction", due: "2026-11-20T00:00:00.000Z" }],
	L2: [{ id: "t2", title: "Clean gutters", status: "needsAction", notes: "ladder in garage" }],
};

function route(path) {
	if (path === "/users/@me/lists") return LISTS;
	let m = /^\/lists\/(\w+)\/tasks$/.exec(path);
	if (m) return { items: TASKS[m[1]] || [] };
	m = /^\/lists\/(\w+)\/tasks\/(\w+)$/.exec(path);
	if (m) {
		const t = (TASKS[m[1]] || []).find((x) => x.id === m[2]);
		if (t) return t;
		throw Object.assign(new Error("Not Found"), { status: 502, providerStatus: 404 });
	}
	throw new Error(`unexpected ${path}`);
}

beforeEach(() => {
	jest.clearAllMocks();
	http.providerGet.mockImplementation(async (_p, _prov, path) => route(path));
	http.providerRequest.mockResolvedValue({ id: "new1", webViewLink: "https://tasks.google.com/x" });
});

describe("registry", () => {
	test("google_tasks is a Google group member with the tasks scope", () => {
		const p = connectorRegistry.getProvider("google_tasks");
		expect(p.scopes).toContain("https://www.googleapis.com/auth/tasks");
		expect(connectorRegistry.groupOf("google_tasks")).toBe("google");
		expect(connectorRegistry.GROUPS.google.accountKey.google_tasks).toBe("sub");
	});
});

describe("connector", () => {
	test("keyword gate", () => {
		expect(tasks.matches("what's on my to-do list?")).toBe(true);
		expect(tasks.matches("add milk to my tasks")).toBe(true);
		expect(tasks.matches("what's for dinner")).toBe(false);
	});

	test("context covers every list, dated tasks first, ids included", async () => {
		const text = await tasks.buildContext(7);
		expect(text).toMatch(/2 open tasks across "My Tasks", "House"/);
		expect(text.indexOf("Call the dentist")).toBeLessThan(text.indexOf("Clean gutters"));
		expect(text).toMatch(/\[task_id t1\]/);
		expect(text).toMatch(/notes: ladder in garage/);
	});

	test("a not-connected failure is not swallowed as an unreadable list", async () => {
		http.providerGet.mockImplementation(async (_p, _prov, path) => {
			if (path === "/users/@me/lists") return LISTS;
			throw Object.assign(new Error("gone"), { code: "not_connected" });
		});
		await expect(tasks.buildContext(7)).rejects.toThrow("gone");
	});

	test("updateTask reopening clears completed", async () => {
		await tasks.updateTask(7, { task_id: "t1", list_id: "L1", done: false });
		expect(http.providerRequest).toHaveBeenCalledWith(7, "google_tasks", "/lists/L1/tasks/t1", {
			method: "PATCH",
			body: { status: "needsAction", completed: null },
		});
	});
});

describe("add_google_task", () => {
	const action = actions.get("add_google_task");

	test("adds to the default list with a due date", async () => {
		expect(action).toMatchObject({ provider: "google_tasks", consentType: "action_authority" });
		const p = await action.normalize({ title: "Buy stamps", task_due: "2026-12-01" }, ctx);
		expect(p).toEqual({ title: "Buy stamps", due: "2026-12-01", list_id: "L1", list_title: "My Tasks" });
		expect(action.summarize(p)).toBe('Add "Buy stamps" to your Google Tasks list "My Tasks", due 2026-12-01');
		await action.execute(7, p);
		expect(http.providerRequest).toHaveBeenCalledWith(7, "google_tasks", "/lists/L1/tasks", {
			method: "POST",
			body: { title: "Buy stamps", due: "2026-12-01T00:00:00.000Z" },
		});
	});

	test("finds a named list and refuses an unknown one, a bad date or a duplicate", async () => {
		expect((await action.normalize({ title: "Fix fence", task_list: "house" }, ctx)).list_id).toBe("L2");
		await expect(action.normalize({ title: "x", task_list: "Work" }, ctx)).rejects.toThrow(/no task list called/);
		await expect(action.normalize({ title: "x", task_due: "next week" }, ctx)).rejects.toThrow(/YYYY-MM-DD/);
		await expect(action.normalize({ title: "Clean the gutters", task_list: "House" }, ctx)).rejects.toThrow(/already on/);
		await expect(action.normalize({}, ctx)).rejects.toThrow(/title/);
	});
});

describe("update_google_task", () => {
	const action = actions.get("update_google_task");

	test("asks every time; ticks off a task found on any list", async () => {
		expect(action.standing).toBe(false);
		const p = await action.normalize({ task_id: "t2", task_done: true }, ctx);
		expect(p).toMatchObject({ task_id: "t2", list_id: "L2", done: true });
		expect(action.summarize(p)).toBe('"Clean gutters" on your Google Tasks list "House": tick it off');
		await action.execute(7, p);
		expect(http.providerRequest).toHaveBeenCalledWith(7, "google_tasks", "/lists/L2/tasks/t2", {
			method: "PATCH",
			body: { status: "completed" },
		});
	});

	test("appends notes and refuses unknown tasks and no-ops", async () => {
		const p = await action.normalize({ task_id: "t2", task_notes: "borrow Joe's" }, ctx);
		expect(p.notes).toBe("ladder in garage\n\nborrow Joe's");
		await expect(action.normalize({ task_id: "nope", task_done: true }, ctx)).rejects.toThrow(/isn't on/);
		await expect(action.normalize({ task_id: "t1", task_done: false }, ctx)).rejects.toThrow(/already/);
		await expect(action.normalize({ task_done: true }, ctx)).rejects.toThrow(/task_id/);
	});
});

describe("delete_google_task", () => {
	const action = actions.get("delete_google_task");

	test("never standing, irreversible, checks the task exists", async () => {
		expect(action).toMatchObject({ standing: false, reversible: false });
		const p = await action.normalize({ task_id: "t1" }, ctx);
		expect(action.summarize(p)).toMatch(/Delete "Call the dentist" from your Google Tasks list "My Tasks"/);
		await action.execute(7, p);
		expect(http.providerRequest).toHaveBeenCalledWith(7, "google_tasks", "/lists/L1/tasks/t1", { method: "DELETE" });
		await expect(action.normalize({ task_id: "zzz" }, ctx)).rejects.toThrow(/isn't on/);
	});
});

describe("Tasks card checkbox (direct actions)", () => {
	const tick = actions.get("complete_google_task");
	const reopen = actions.get("reopen_google_task");

	test("are direct only and never standing", () => {
		expect(tick).toMatchObject({ direct: true, standing: false, provider: "google_tasks" });
		expect(reopen).toMatchObject({ direct: true, standing: false });
		expect(actions.ACTIONS.some((a) => a.id === "complete_google_task")).toBe(false);
	});

	test("tick finds the task on its list and completes it; refuses one already done", async () => {
		const p = await tick.normalize({ task_id: "t1", task_list: "L1" }, ctx);
		expect(p).toEqual({ task_id: "t1", list_id: "L1", list_title: "My Tasks", title: "Call the dentist" });
		await tick.execute(7, p);
		expect(http.providerRequest).toHaveBeenCalledWith(7, "google_tasks", "/lists/L1/tasks/t1", { method: "PATCH", body: { status: "completed" } });
		await expect(reopen.normalize({ task_id: "t1" }, ctx)).rejects.toThrow(/already open/);
		await expect(tick.normalize({ task_id: "zzz" }, ctx)).rejects.toThrow(/isn't on/);
	});
});

describe("Tasks card Add task drawer (direct action)", () => {
	const create = actions.get("create_google_task");

	test("is direct only, never standing, and vouches like add_google_task", async () => {
		expect(create).toMatchObject({ direct: true, standing: false, provider: "google_tasks" });
		expect(actions.ACTIONS.some((a) => a.id === "create_google_task")).toBe(false);
		const p = await create.normalize({ title: "Buy salt", task_list: "L2" }, ctx);
		expect(p).toEqual({ title: "Buy salt", list_id: "L2", list_title: "House" });
		await expect(create.normalize({ title: "Clean gutters", task_list: "L2" }, ctx)).rejects.toThrow(/already on/);
		await expect(create.normalize({ title: "x", task_list: "nope" }, ctx)).rejects.toThrow(/no task list/);
		http.providerRequest.mockResolvedValueOnce({ id: "new1" });
		await expect(create.execute(7, p)).resolves.toMatchObject({ ref: "new1" });
		expect(http.providerRequest).toHaveBeenLastCalledWith(7, "google_tasks", "/lists/L2/tasks", { method: "POST", body: { title: "Buy salt" } });
	});
});
