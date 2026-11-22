/**
 * The Tasks card's Add task drawer on the Jira side (owner, 2026-11-20): the
 * create_jira_issue direct action and the connector writes behind it.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("../consent", () => ({ hasConsentForProfile: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn(), get: jest.fn() }));
jest.mock("../family", () => ({ getFamilyForProfile: jest.fn() }));
jest.mock("../lookRequests", () => ({ create: jest.fn() }));
jest.mock("../memory", () => ({ CATEGORIES: new Set(["other"]), upsertMemoryForProfile: jest.fn() }));

const credentials = require("../credentials");
const actions = require("../actions/registry");

const ctx = { profileId: 7 };
const SITE = "https://acme.atlassian.net";
let calls;

function reply(body, status = 200) {
	return { ok: status < 400, status, json: async () => body };
}

beforeEach(() => {
	calls = [];
	credentials.get.mockResolvedValue({ kind: "api_key", accessToken: "tok", externalAccountId: "acme.atlassian.net", displayName: "me@example.com" });
	global.fetch = jest.fn(async (url, opts = {}) => {
		const path = String(url).replace(SITE, "");
		calls.push({ path, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : undefined });
		if (path.startsWith("/rest/api/3/project/search")) return reply({ values: [{ key: "RED", name: "Red Team" }, { key: "bad key", name: "x" }] });
		if (path.startsWith("/rest/api/3/issue/createmeta/RED/issuetypes")) return reply({ issueTypes: [{ id: "1", name: "Epic" }, { id: "5", name: "Sub-task", subtask: true }, { id: "3", name: "Task" }] });
		if (path.startsWith("/rest/agile/1.0/board?")) return reply({ values: [{ id: 12 }] });
		if (path.startsWith("/rest/agile/1.0/board/12/sprint")) return reply({ values: [{ id: 99, name: "Sprint 40", state: "active" }] });
		if (path === "/rest/api/3/myself") return reply({ accountId: "acc-1" });
		if (path === "/rest/api/3/issue") return reply({ key: "RED-7" }, 201);
		if (path === "/rest/agile/1.0/sprint/99/issue") return reply(null, 204);
		throw new Error(`unexpected ${path}`);
	});
});

describe("create_jira_issue", () => {
	const create = actions.get("create_jira_issue");

	test("is direct only and never standing", () => {
		expect(create).toMatchObject({ direct: true, standing: false, provider: "jira" });
		expect(actions.ACTIONS.some((a) => a.id === "create_jira_issue")).toBe(false);
	});

	test("vouches for the project, picks Task in code, and finds the active sprint", async () => {
		const p = await create.normalize({ summary: "  Fix login  ", project_key: "RED", in_sprint: true, issue_type_id: "1" }, ctx);
		expect(p).toEqual({ summary: "Fix login", project_key: "RED", project_name: "Red Team", issue_type_id: "3", issue_type: "Task", sprint_id: 99, sprint_name: "Sprint 40" });
		await expect(create.normalize({ summary: "x", project_key: "OTHER" }, ctx)).rejects.toThrow(/can't create/);
		await expect(create.normalize({ summary: "", project_key: "RED" }, ctx)).rejects.toThrow(/summary/);
	});

	test("creates the issue assigned to the caller, then moves it into the sprint", async () => {
		const p = await create.normalize({ summary: "Fix login", project_key: "RED", in_sprint: true, description: "line one\nline two" }, ctx);
		const result = await create.execute(7, p);
		expect(result).toEqual({ ref: "RED-7", detail: { link: `${SITE}/browse/RED-7` } });
		const post = calls.find((c) => c.path === "/rest/api/3/issue");
		expect(post.body.fields).toMatchObject({ project: { key: "RED" }, issuetype: { id: "3" }, summary: "Fix login", assignee: { accountId: "acc-1" } });
		expect(post.body.fields.description.content).toHaveLength(2);
		expect(calls.find((c) => c.path === "/rest/agile/1.0/sprint/99/issue").body).toEqual({ issues: ["RED-7"] });
	});

	test("an OAuth (read-only) link can't create", async () => {
		credentials.get.mockResolvedValue({ kind: "oauth", accessToken: "x" });
		await expect(create.availableTo(7)).resolves.toBe(false);
		await expect(create.normalize({ summary: "x", project_key: "RED" }, ctx)).rejects.toThrow(/API-token/);
	});
});
