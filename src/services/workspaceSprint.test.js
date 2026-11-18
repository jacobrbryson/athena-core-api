jest.mock("./workplaces", () => ({ list: jest.fn() }));
jest.mock("./workspaceDashboard", () => ({ credentialFor: jest.fn() }));

const workplaces = require("./workplaces");
const { credentialFor } = require("./workspaceDashboard");
const sprint = require("./workspaceSprint");

describe("statusOf", () => {
	it("is complete at 64 done", () => expect(sprint.statusOf({ done: 64, inProgress: 0, notStarted: 0 }, 0.5)).toBe("complete"));
	it("is on track early in the sprint with enough work", () => expect(sprint.statusOf({ done: 3, inProgress: 58, notStarted: 5 }, 0.1)).toBe("on_track"));
	it("is behind when what's left exceeds the time left", () => expect(sprint.statusOf({ done: 13, inProgress: 25, notStarted: 64 }, 0.6)).toBe("behind"));
	it("flags too little work in the sprint", () => {
		expect(sprint.statusOf({ done: 0, inProgress: 12.8, notStarted: 12 }, 0.05)).toBe("at_risk");
		expect(sprint.statusOf({ done: 20, inProgress: 12.8, notStarted: 12 }, 0.5)).toBe("behind");
	});
	it("says everyone not done is behind at the very end", () => expect(sprint.statusOf({ done: 60, inProgress: 4, notStarted: 0 }, 1)).toBe("behind"));
});

describe("matchLogin", () => {
	const members = [
		{ login: "jsavageaddams", name: null },
		{ login: "eareese-v", name: "Emily Reese" },
		{ login: "caleb-graves", name: null },
		{ login: "rossbryson", name: "Ross Bryson" },
	];
	it("matches by GitHub name", () => expect(sprint.matchLogin("Emily Reese", members)).toBe("eareese-v"));
	it("matches initial+surname logins", () => expect(sprint.matchLogin("Joseph Savage-Addams", members)).toBe("jsavageaddams"));
	it("matches first-last logins", () => expect(sprint.matchLogin("Caleb Graves", members)).toBe("caleb-graves"));
	it("returns null when nobody fits", () => expect(sprint.matchLogin("Ronald Coello", members)).toBeNull());
});

describe("elapsedFraction", () => {
	it("counts working days", () => {
		// Mon 2026-11-02 → Mon 2026-11-16 is 10 working days; Mon 11-09 is half way.
		expect(sprint.elapsedFraction("2026-11-02T00:00:00Z", "2026-11-16T00:00:00Z", new Date("2026-11-09T00:00:00Z"))).toBe(0.5);
		expect(sprint.elapsedFraction("2026-11-02T00:00:00Z", "2026-11-16T00:00:00Z", new Date("2026-11-01T00:00:00Z"))).toBe(0);
		expect(sprint.elapsedFraction("2026-11-02T00:00:00Z", "2026-11-16T00:00:00Z", new Date("2026-12-01T00:00:00Z"))).toBe(1);
	});
});

describe("read", () => {
	const space = { uuid: "w-1", name: "Vivacity Tech PBC", primary: true, connections: [] };
	const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
	const NAMES = { me: "Ross Bryson", em: "Emily Reese", bt: "Blue Teamer" };
	const issue = (key, who, cat, sp, team = "Red Team") => ({
		key, fields: {
			assignee: who && { accountId: who, displayName: NAMES[who] },
			customfield_10001: team ? { id: team, name: team } : null,
			status: { statusCategory: { key: cat } }, customfield_10016: sp,
			customfield_10020: [{ id: 7, name: "Sprint 42", state: "active", startDate: "2026-11-02T00:00:00Z", endDate: "2026-11-16T00:00:00Z" }],
		},
	});

	beforeEach(() => {
		workplaces.list.mockResolvedValue([space]);
		credentialFor.mockImplementation(async (_p, _w, provider) => provider === "jira"
			? { kind: "api_key", externalAccountId: "viv.atlassian.net", displayName: "me@viv.com", accessToken: "t" }
			: { accessToken: "g" });
		global.fetch = jest.fn((url) => {
			if (url.endsWith("/rest/api/3/field")) return json([
				{ id: "customfield_10020", name: "Sprint", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } },
				{ id: "customfield_10016", name: "Story point estimate", schema: { custom: "com.pyxis.greenhopper.jira:jsw-story-points" } },
				{ id: "customfield_10001", name: "Team", schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team" } },
			]);
			if (url.endsWith("/rest/api/3/myself")) return json({ accountId: "me", displayName: "Ross Bryson" });
			if (url.includes("/search/jql")) return json({ issues: [issue("A-1", "me", "done", 40), issue("A-2", "me", "indeterminate", 20), issue("A-3", "em", "new", 64), issue("A-4", null, "new", 5), issue("A-5", "bt", "done", 30, "Blue Team"), issue("A-6", "em", "done", 3, null), issue("A-7", null, "new", 8, "Blue Team")], isLast: true });
			if (url.endsWith("/user")) return json({ login: "rossbryson" });
			if (url.includes("/user/orgs")) return json([{ login: "viv" }]);
			if (url.includes("/orgs/viv/members")) return json([{ login: "eareese-v" }]);
			if (url.includes("/users/eareese-v")) return json({ name: "Emily Reese" });
			if (url.includes("/search/issues")) return json({ total_count: url.includes("reviewed-by") ? 4 : 2 });
			return json({}, 404);
		});
	});

	it("reads the sprint, splits points and flags who is behind", async () => {
		const out = await sprint.read("p-1", "primary");
		expect(out.error).toBeNull();
		expect(out.sprint.name).toBe("Sprint 42");
		expect(out.me).toMatchObject({ done: 40, inProgress: 20, notStarted: 0, github: { login: "rossbryson", created: 2, reviewed: 4 } });
		// Only the Red team: Blue Teamer is left out; Emily's issue with no team still counts, she's Red.
		expect(out.teamFilter).toBe("Red");
		expect(out.team.size).toBe(1);
		expect(out.team.average.status).toBe(out.people.find((p) => p.id === "em").status);
		expect(out.people.map((p) => p.id).sort()).toEqual(["em", "me"]);
		expect(out.people.find((p) => p.id === "em")).toMatchObject({ done: 3, notStarted: 64, github: { login: "eareese-v" } });
		expect(out.unassigned).toBe(5);
		// No token ever lands in a URL.
		for (const [url] of global.fetch.mock.calls) expect(url).not.toMatch(/token|g$|t$/);
	});

	it("finds the org and teammates for a fine-grained key that lists neither", async () => {
		const base = global.fetch;
		global.fetch = jest.fn((url) => {
			if (url.includes("/user/orgs") || url.includes("/orgs/viv/members")) return json([]);
			if (url.includes("/user/repos")) return json([{ owner: { login: "viv", type: "Organization" } }]);
			if (url.includes("/search/issues") && url.includes("per_page=100")) return json({ items: [{ user: { login: "eareese-v" } }] });
			return base(url);
		});
		const out = await sprint.read("p-4", "w-1");
		expect(out.people.find((p) => p.id === "em").github.login).toBe("eareese-v");
		expect(out.github.note).toBeNull();
		expect(global.fetch.mock.calls.some(([u]) => decodeURIComponent(u).includes("org:viv"))).toBe(true);
	});

	it("reads again after the GitHub key is replaced instead of serving the old key's result", async () => {
		await sprint.read("p-6", "w-1");
		const userCalls = () => global.fetch.mock.calls.filter(([u]) => u.endsWith("/user")).length;
		const before = userCalls();
		await sprint.read("p-6", "w-1");
		expect(userCalls()).toBe(before); // same key: cached
		credentialFor.mockImplementation(async (_p, _w, provider) => provider === "jira"
			? { kind: "api_key", externalAccountId: "viv.atlassian.net", displayName: "me@viv.com", accessToken: "t" }
			: { accessToken: "new-key" });
		await sprint.read("p-6", "w-1");
		expect(userCalls()).toBe(before + 1);
	});

	it("reports a missing Jira link without calling out", async () => {
		credentialFor.mockResolvedValue(null);
		workplaces.list.mockResolvedValue([{ ...space, uuid: "w-2" }]);
		const out = await sprint.read("p-2", "w-2");
		expect(out.error).toBe("not_connected");
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("404s an unknown workspace", async () => {
		await expect(sprint.read("p-3", "nope")).rejects.toMatchObject({ status: 404 });
	});
});

describe("jiraRedEpics", () => {
	const json = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
	const key = { kind: "api_key", externalAccountId: "red.atlassian.net", displayName: "me@red.com", accessToken: "t" };
	const epic = (k, due, team, extra = {}) => ({ key: k, fields: { summary: `Epic ${k}`, status: { name: "In Progress", statusCategory: { key: "indeterminate" } }, project: { name: "Dream" }, duedate: due, labels: [], customfield_10001: team ? { name: team } : null, ...extra } });
	const kid = (parent, cat, sp) => ({ key: `${parent}-k`, fields: { parent: { key: parent }, status: { statusCategory: { key: cat } }, customfield_10016: sp } });

	beforeEach(() => {
		global.fetch = jest.fn((url) => {
			const u = decodeURIComponent(url.replace(/\+/g, " "));
			if (u.endsWith("/rest/api/3/field")) return json([
				{ id: "customfield_10016", name: "Story point estimate", schema: { custom: "com.pyxis.greenhopper.jira:jsw-story-points" } },
				{ id: "customfield_10001", name: "Team", schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team" } },
				{ id: "customfield_10023", name: "Target end", schema: { type: "date" } },
			]);
			if (u.includes("issuetype = Epic")) return json({ issues: [
				epic("DR-1", "2026-12-20", "Red Team"),
				epic("DR-2", null, "Blue Team"),
				epic("DR-3", null, null, { customfield_10023: "2026-11-30" }),
				epic("DR-4", "2026-11-25", null),
			], isLast: true });
			if (u.includes("parent in")) return json({ issues: [kid("DR-1", "done", 3), kid("DR-1", "new", 1), kid("DR-3", "done", 0), kid("DR-3", "indeterminate", 0)], isLast: true });
			return json({});
		});
	});

	it("keeps Red's epics (by team, or by the Red sprint's parents), soonest due first, with progress", async () => {
		const out = await sprint.jiraRedEpics(key, ["DR-3"]);
		expect(out.error).toBeNull();
		// D-2 is Blue's; D-4 has no team and no Red work under it.
		expect(out.items.map((e) => e.key)).toEqual(["DR-3", "DR-1"]);
		expect(out.items[0]).toMatchObject({ due: "2026-11-30", by: "issues", done: 1, inProgress: 1, total: 2, percent: 50, via: "sprint" });
		expect(out.items[1]).toMatchObject({ due: "2026-12-20", by: "points", pointsDone: 3, points: 4, percent: 75, via: "team" });
	});

	it("says when there's no Jira key", async () => {
		expect(await sprint.jiraRedEpics(null)).toEqual({ items: [], error: "not_connected" });
	});
});
