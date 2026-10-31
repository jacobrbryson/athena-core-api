jest.mock("./credentials", () => ({ list: jest.fn(), get: jest.fn() }));
jest.mock("./workplaces", () => ({ list: jest.fn() }));

const credentials = require("./credentials");
const workplaces = require("./workplaces");
const dash = require("./workspaceDashboard");

const space = (connections) => [{ uuid: "w-1", name: "Vivacity Tech PBC", connections }];
const conn = (provider) => ({ credentialUuid: `c-${provider}`, provider, status: "active" });

beforeEach(() => {
	jest.resetAllMocks();
	global.fetch = jest.fn();
});

it("404s for a workspace that isn't the caller's", async () => {
	workplaces.list.mockResolvedValue(space([]));
	await expect(dash.read(7, "nope")).rejects.toMatchObject({ status: 404 });
});

it("reports not_connected when the workspace has no GitHub or Jira link, without reading tokens", async () => {
	workplaces.list.mockResolvedValue(space([]));
	const out = await dash.read(7, "w-1");
	expect(out.pullRequests).toMatchObject({ items: [], error: "not_connected" });
	expect(out.epics).toMatchObject({ items: [], error: "not_connected" });
	expect(credentials.get).not.toHaveBeenCalled();
});

it("reads pull requests with the workspace's own GitHub key", async () => {
	workplaces.list.mockResolvedValue(space([conn("github")]));
	credentials.list.mockResolvedValue([{ uuid: "c-github", external_account_id: "workplace:w-1" }]);
	credentials.get.mockResolvedValue({ uuid: "c-github", status: "active", accessToken: "tok" });
	global.fetch.mockImplementation(async (url) => ({
		ok: true,
		json: async () => /\/user$/.test(url) ? { login: "ross" } : {
			items: [{ id: 1, number: 4, title: "Fix", html_url: "https://github.com/v/Dream-Backend/pull/4", repository_url: "https://api.github.com/repos/v/Dream-Backend", user: { login: "ross" }, draft: false, comments: 2 }],
		},
	}));
	const out = await dash.read(7, "w-1");
	expect(credentials.get).toHaveBeenCalledWith(7, "github", expect.objectContaining({ externalAccountId: "workplace:w-1" }));
	expect(out.pullRequests.items[0]).toMatchObject({ repo: "Dream-Backend", mine: true, number: 4 });
});

it("includes PRs awaiting your review even when nothing else involves you", async () => {
	workplaces.list.mockResolvedValue(space([conn("github")]));
	credentials.list.mockResolvedValue([{ uuid: "c-github", external_account_id: "workplace:w-1" }]);
	credentials.get.mockResolvedValue({ uuid: "c-github", status: "active", accessToken: "tok" });
	const pr = { id: 9, number: 12, title: "Review me", html_url: "https://github.com/v/Dream-Frontend/pull/12", repository_url: "https://api.github.com/repos/v/Dream-Frontend", user: { login: "sam" } };
	global.fetch.mockImplementation(async (url) => ({
		ok: true,
		json: async () => /\/user$/.test(url) ? { login: "ross" } : { items: /review-requested/.test(decodeURIComponent(url)) ? [pr] : [] },
	}));
	const out = await dash.read(7, "w-1");
	expect(out.pullRequests.items).toHaveLength(1);
	expect(out.pullRequests.items[0]).toMatchObject({ number: 12, mine: false, reviewRequested: true });
});

it("lists every open PR in the key's organizations, not only yours", async () => {
	workplaces.list.mockResolvedValue(space([conn("github")]));
	credentials.list.mockResolvedValue([{ uuid: "c-github", external_account_id: "workplace:w-1" }]);
	credentials.get.mockResolvedValue({ uuid: "c-github", status: "active", accessToken: "tok" });
	const pr = { id: 5, number: 30, title: "Someone else's", html_url: "https://github.com/v/Dream-Backend/pull/30", repository_url: "https://api.github.com/repos/v/Dream-Backend", user: { login: "sam" } };
	global.fetch.mockImplementation(async (url) => ({
		ok: true,
		json: async () => /\/user$/.test(url) ? { login: "ross" }
			: /\/user\/orgs/.test(url) ? [{ login: "v" }, { login: "bad login!" }]
			: { items: /org:v/.test(decodeURIComponent(url).replace(/\+/g, " ")) ? [pr] : [] },
	}));
	const out = await dash.read(7, "w-1");
	expect(out.pullRequests.items).toEqual([expect.objectContaining({ number: 30, mine: false, reviewRequested: false })]);
	expect(global.fetch.mock.calls.some(([u]) => /bad/.test(decodeURIComponent(u)))).toBe(false);
});

it("won't read epics through a non-API-token Jira link", async () => {
	workplaces.list.mockResolvedValue(space([conn("jira")]));
	credentials.list.mockResolvedValue([{ uuid: "c-jira", external_account_id: "cloud-id" }]);
	credentials.get.mockResolvedValue({ uuid: "c-jira", status: "active", kind: "oauth2", accessToken: "t", externalAccountId: "cloud-id" });
	const out = await dash.read(7, "w-1");
	expect(out.epics.error).toBe("unsupported");
	expect(global.fetch).not.toHaveBeenCalled();
});
