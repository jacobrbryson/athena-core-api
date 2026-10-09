jest.mock("./http", () => ({ providerGet: jest.fn(), providerRequest: jest.fn(), isNotConnected: (e) => e && e.code === "not_connected" }));
const { providerGet, providerRequest } = require("./http");
const g = require("./googleWebsites");

beforeEach(() => jest.resetAllMocks());

describe("parsing what a person types", () => {
	it("reduces a URL or domain property to the bare host", () => {
		expect(g.hostOf("https://www.Orcwood.com/games")).toBe("orcwood.com");
		expect(g.hostOf("sc-domain:family-chores.app")).toBe("family-chores.app");
		expect(g.hostOf("not a domain")).toBeNull();
		expect(g.hostOf("")).toBeNull();
	});
	it("accepts a GA4 property with or without its prefix, and nothing else", () => {
		expect(g.propertyId("properties/123456")).toBe("123456");
		expect(g.propertyId("123456")).toBe("123456");
		expect(g.propertyId("123/../x")).toBeNull();
		expect(g.propertyId("UA-123-1")).toBeNull();
	});
	it("only accepts a Search Console property in its two real forms", () => {
		expect(g.searchSite("sc-domain:orcwood.com")).toBe("sc-domain:orcwood.com");
		expect(g.searchSite("https://rossbryson.com")).toBe("https://rossbryson.com/");
		expect(g.searchSite("orcwood.com")).toBeNull();
		expect(g.searchSite("ftp://orcwood.com/")).toBeNull();
	});
});

describe("listSearchSites", () => {
	it("hides unverified properties and returns null when not linked", async () => {
		providerGet.mockResolvedValueOnce({
			siteEntry: [
				{ siteUrl: "sc-domain:orcwood.com", permissionLevel: "siteOwner" },
				{ siteUrl: "https://nope.com/", permissionLevel: "siteUnverifiedUser" },
			],
		});
		expect(await g.listSearchSites(1)).toEqual([{ site: "sc-domain:orcwood.com", host: "orcwood.com", permission: "siteOwner" }]);
		providerGet.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "not_connected", reason: "absent" }));
		expect(await g.listSearchSites(1)).toBeNull();
	});
	it("does not read a revoked link as not linked", async () => {
		providerGet.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "not_connected", reason: "revoked" }));
		await expect(g.listSearchSites(1)).rejects.toThrow();
	});
});

describe("searchSummary", () => {
	it("asks for a week, the week before and the top queries, without invalidating the link on one site's 403", async () => {
		providerRequest
			.mockResolvedValueOnce({ rows: [{ clicks: 120, impressions: 4000, ctr: 0.03, position: 8.2 }] })
			.mockResolvedValueOnce({ rows: [{ clicks: 100, impressions: 3500, ctr: 0.028, position: 9 }] })
			.mockResolvedValueOnce({ rows: [{ keys: ["orcwood"], clicks: 40, impressions: 500 }] });
		const out = await g.searchSummary(1, "sc-domain:orcwood.com");
		expect(out.clicks).toBe(120);
		expect(out.previous.clicks).toBe(100);
		expect(out.topQueries).toEqual([{ query: "orcwood", clicks: 40, impressions: 500 }]);
		const [, provider, path, opts] = providerRequest.mock.calls[0];
		expect(provider).toBe("websites");
		expect(path).toBe("/webmasters/v3/sites/sc-domain%3Aorcwood.com/searchAnalytics/query");
		expect(opts).toMatchObject({ method: "POST", api: "search", invalidateOnAuthFailure: false });
	});
	it("treats an empty week as zeros", async () => {
		providerRequest.mockResolvedValue({});
		const out = await g.searchSummary(1, "https://rossbryson.com/");
		expect(out).toMatchObject({ clicks: 0, impressions: 0, previous: { clicks: 0 }, topQueries: [] });
	});
	it("refuses a property it cannot parse before calling Google", async () => {
		await expect(g.searchSummary(1, "evil.com/../x")).rejects.toMatchObject({ status: 400 });
		expect(providerRequest).not.toHaveBeenCalled();
	});
});

describe("analyticsSummary", () => {
	it("splits the two date ranges by their label", async () => {
		providerRequest
			.mockResolvedValueOnce({
				rows: [
					{ dimensionValues: [{ value: "current" }], metricValues: [{ value: "30" }, { value: "50" }, { value: "12" }] },
					{ dimensionValues: [{ value: "previous" }], metricValues: [{ value: "20" }, { value: "40" }, { value: "9" }] },
				],
			})
			.mockResolvedValueOnce({ rows: [{ dimensionValues: [{ value: "/" }], metricValues: [{ value: "77" }] }] });
		const out = await g.analyticsSummary(1, "properties/987");
		expect(out).toMatchObject({ users: 30, sessions: 50, newUsers: 12, previous: { users: 20 }, topPages: [{ path: "/", views: 77 }] });
		expect(providerRequest.mock.calls[0][2]).toBe("/properties/987:runReport");
		expect(providerRequest.mock.calls[0][3]).toMatchObject({ api: "analytics", invalidateOnAuthFailure: false });
	});
});
