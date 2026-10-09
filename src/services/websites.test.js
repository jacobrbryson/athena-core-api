jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./connectors/http", () => ({ providerGet: jest.fn(), providerRequest: jest.fn(), isNotConnected: (e) => e && e.code === "not_connected" }));
jest.mock("./connectors/context", () => ({ technicalDetail: (e) => (e && (e.providerDetail || e.message)) || null }));
jest.mock("./connectors/googleWebsites", () => {
	const real = jest.requireActual("./connectors/googleWebsites");
	return { ...real, listSearchSites: jest.fn(), listProperties: jest.fn(), searchSummary: jest.fn(), analyticsSummary: jest.fn() };
});

const db = require("../helpers/db");
const google = require("./connectors/googleWebsites");
const websites = require("./websites");

const row = (fields = {}) => ({
	id: 1, uuid: "s-1", domain: "orcwood.com", label: null, search_site: null, ga_property: null,
	notes: null, last_checked_at: null, last_error: null, updated_at: null, ...fields,
});

beforeEach(() => jest.resetAllMocks());

describe("change", () => {
	it("is a whole-number percentage, and null with nothing to compare", () => {
		expect(websites.change(120, 100)).toBe(20);
		expect(websites.change(80, 100)).toBe(-20);
		expect(websites.change(5, 0)).toBeNull();
		expect(websites.change(5, undefined)).toBeNull();
	});
});

describe("normalize", () => {
	it("cleans the domain and validates the two Google ids", () => {
		const f = websites.normalize({ domain: "https://www.Orcwood.com/x", searchSite: "sc-domain:orcwood.com", gaProperty: "properties/55" });
		expect(f).toMatchObject({ domain: "orcwood.com", search_site: "sc-domain:orcwood.com", ga_property: "55" });
	});
	it("rejects what is not a domain or a property, with a message safe to show", () => {
		expect(() => websites.normalize({ domain: "hello" })).toThrow(/domain/);
		expect(() => websites.normalize({ domain: "a.com", gaProperty: "abc" })).toThrow(/GA4/);
		expect(() => websites.normalize({ domain: "a.com", searchSite: "a.com" })).toThrow(/Search Console/);
	});
	it("keeps stored values when a field is omitted and clears one sent empty", () => {
		const existing = { domain: "a.com", label: "A", searchSite: "sc-domain:a.com", gaProperty: "9", notes: null };
		expect(websites.normalize({}, existing)).toMatchObject({ label: "A", search_site: "sc-domain:a.com", ga_property: "9" });
		expect(websites.normalize({ gaProperty: "" }, existing).ga_property).toBeNull();
	});
});

describe("save", () => {
	it("refuses a second entry for the same domain", async () => {
		db.query.mockImplementation(async (sql) => {
			if (/COUNT\(\*\)/.test(sql)) return [[{ n: 1 }]];
			if (/SELECT uuid FROM athena_site/.test(sql)) return [[{ uuid: "other" }]];
			return [[]];
		});
		await expect(websites.save(7, { domain: "orcwood.com" })).rejects.toMatchObject({ status: 400 });
	});
	it("404s an edit of a site that is not theirs", async () => {
		db.query.mockResolvedValue([[]]);
		await expect(websites.save(7, { uuid: "nope", domain: "a.com" })).rejects.toMatchObject({ status: 404 });
	});
});

describe("refresh", () => {
	function mockSite(site) {
		db.query.mockImplementation(async (sql) => {
			if (/FROM athena_site_snapshot s/.test(sql)) return [[]];
			if (/SELECT id FROM athena_site/.test(sql)) return [[{ id: 1 }]];
			if (/FROM athena_site WHERE/.test(sql)) return [[site]];
			return [{ affectedRows: 1 }];
		});
	}
	it("stores a snapshot per source and clears the error", async () => {
		mockSite(row({ search_site: "sc-domain:orcwood.com", ga_property: "55" }));
		google.searchSummary.mockResolvedValue({ clicks: 1 });
		google.analyticsSummary.mockResolvedValue({ users: 2 });
		await websites.refresh(7);
		const inserts = db.query.mock.calls.filter(([sql]) => /INSERT INTO athena_site_snapshot/.test(sql));
		expect(inserts.map(([, p]) => p[1]).sort()).toEqual(["analytics", "search"]);
		const update = db.query.mock.calls.find(([sql]) => /UPDATE athena_site SET last_checked_at/.test(sql));
		expect(update[1][0]).toBeNull();
	});
	it("keeps going when one source fails, records why, and writes nothing for the failed one", async () => {
		mockSite(row({ search_site: "sc-domain:orcwood.com", ga_property: "55" }));
		google.searchSummary.mockRejectedValue(Object.assign(new Error("denied"), { providerDetail: "User does not have sufficient permission", providerStatus: 403 }));
		google.analyticsSummary.mockResolvedValue({ users: 2 });
		await websites.refresh(7);
		const inserts = db.query.mock.calls.filter(([sql]) => /INSERT INTO athena_site_snapshot/.test(sql));
		expect(inserts.map(([, p]) => p[1])).toEqual(["analytics"]);
		const update = db.query.mock.calls.find(([sql]) => /UPDATE athena_site SET last_checked_at/.test(sql));
		expect(update[1][0]).toMatch(/Search Console: .*sufficient permission/);
	});
	it("skips sites with nothing to read", async () => {
		mockSite(row());
		await websites.refresh(7);
		expect(google.searchSummary).not.toHaveBeenCalled();
	});
});

describe("discover", () => {
	it("says not linked when Google access is absent", async () => {
		google.listSearchSites.mockResolvedValue(null);
		google.listProperties.mockResolvedValue(null);
		expect(await websites.discover(7)).toMatchObject({ linked: false });
	});
	it("suggests a property whose name holds the domain's name, and never links it", async () => {
		google.listSearchSites.mockResolvedValue([{ site: "sc-domain:orcwood.com", host: "orcwood.com", permission: "siteOwner" }]);
		google.listProperties.mockResolvedValue([{ property: "11", name: "Family Chores" }, { property: "22", name: "Orcwood Games site" }]);
		const out = await websites.discover(7);
		expect(out.searchSites[0].suggestedProperty).toBe("22");
	});
	it("still lists Search Console sites when the Analytics Admin API is off", async () => {
		google.listSearchSites.mockResolvedValue([{ site: "sc-domain:a.com", host: "a.com", permission: "siteOwner" }]);
		google.listProperties.mockRejectedValue(Object.assign(new Error("API disabled"), { code: "provider_error", providerDetail: "Analytics Admin API has not been used" }));
		const out = await websites.discover(7);
		expect(out.linked).toBe(true);
		expect(out.propertiesError).toMatch(/Analytics Admin API/);
	});
});
