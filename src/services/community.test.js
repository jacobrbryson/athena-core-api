jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./news", () => ({ getNews: jest.fn() }));
jest.mock("./connectors/googleContacts", () => ({ listContacts: jest.fn() }));

const db = require("../helpers/db");
const news = require("./news");
const googleContacts = require("./connectors/googleContacts");
const community = require("./community");

const HOME = {
	uuid: "p-home", name: "Home", kind: "home", address: "148 RUSHING WATER LN, TROUTMAN, NC, 28166",
	notes: null, latitude: 35.67, longitude: -80.9, radius_miles: 3, enabled: 1,
};
const CHURCH = {
	uuid: "p-church", name: "Troutman ARP Church", kind: "church", address: null,
	notes: "Wednesday suppers", latitude: 35.7, longitude: -80.88, radius_miles: 1, enabled: 1,
};

/** A household row, with its database id so links can point at it. */
const household = (id, fields = {}) => ({
	id, uuid: `n-${id}`, name: null, address: null, latitude: null, longitude: null,
	place_uuid: null, where_text: null, contact: null, notes: null, ...fields,
});

function mockDb({ places = [HOME, CHURCH], neighbors = [], links = [], events = [], elsewhere = [], existing = { id: 1 }, insertId = 9 } = {}) {
	db.query.mockImplementation(async (sql) => {
		if (/FROM athena_watch_place/.test(sql)) return [places];
		if (/COUNT\(\*\)/.test(sql)) return [[{ n: 0 }]];
		if (/SELECT id FROM athena_neighbor/.test(sql)) return [existing ? [existing] : []];
		if (/neighbor_id <> \?/.test(sql)) return [elsewhere];
		if (/SELECT c.contact_id, n.uuid/.test(sql)) return [[]];
		if (/SELECT neighbor_id, contact_id, contact_name/.test(sql)) return [links];
		if (/FROM athena_neighbor/.test(sql)) return [neighbors];
		if (/FROM athena_community_event/.test(sql)) return [events];
		if (/^\s*INSERT INTO athena_neighbor\b/.test(sql) && !/athena_neighbor_contact/.test(sql)) return [{ insertId, affectedRows: 1 }];
		return [{ affectedRows: 1 }];
	});
}

beforeEach(() => jest.resetAllMocks());

describe("occurrence", () => {
	const hamDay = { startsOn: "2026-09-26", endsOn: null, repeats: "yearly" };

	it("keeps a yearly event on this year's date while it is recent", () => {
		expect(community.occurrence(hamDay, "2026-10-04").on).toBe("2026-09-26");
	});

	it("rolls a yearly event to next year once it is well past", () => {
		expect(community.occurrence(hamDay, "2026-11-20").on).toBe("2027-09-26");
	});

	it("never invents a year before the first one", () => {
		expect(community.occurrence({ ...hamDay, startsOn: "2027-05-01" }, "2026-10-04").on).toBe("2027-05-01");
	});

	it("leaves a one-off on its own date", () => {
		expect(community.occurrence({ startsOn: "2026-01-02", endsOn: null, repeats: "none" }, "2026-10-04").on).toBe("2026-01-02");
	});

	it("carries a multi-day span to the next year", () => {
		const fair = { startsOn: "2025-10-10", endsOn: "2025-10-12", repeats: "yearly" };
		expect(community.occurrence(fair, "2026-10-04")).toEqual({ on: "2026-10-10", endsOn: "2026-10-12" });
	});
});

describe("townOf", () => {
	it("reads the town from a Census-style address", () => {
		expect(community.townOf("148 RUSHING WATER LN, TROUTMAN, NC, 28166")).toBe("Troutman");
		expect(community.townOf("12 Main St, Mooresville, NC 28115")).toBe("Mooresville");
	});
	it("returns null when there is no town", () => {
		expect(community.townOf(null)).toBeNull();
		expect(community.townOf("Current location")).toBeNull();
	});
});

describe("pickLocal", () => {
	const places = [
		{ name: "Home", address: "148 RUSHING WATER LN, TROUTMAN, NC, 28166" },
		{ name: "Troutman ARP Church", address: null },
	];
	it("keeps headlines that name a town or a distinctive place", () => {
		const items = [
			{ title: "Ham Day draws record crowd in Troutman", summary: "" },
			{ title: "Charlotte council votes on budget", summary: "" },
			{ title: "Supper at Troutman ARP Church", summary: "" },
		];
		const out = community.pickLocal(items, places);
		expect(out.map((i) => i.title)).toEqual(["Ham Day draws record crowd in Troutman", "Supper at Troutman ARP Church"]);
		expect(out[0].matched).toBe("Troutman");
	});
	it("never searches for a generic name like Home", () => {
		expect(community.pickLocal([{ title: "Home prices rise", summary: "" }], [{ name: "Home", address: null }])).toEqual([]);
	});
});

describe("streetKey", () => {
	it("treats spellings of one street line as one house", () => {
		expect(community.streetKey("152 Rushing Water Lane, Troutman NC")).toBe("152 rushing water ln");
		expect(community.streetKey("152 RUSHING WATER LN, TROUTMAN, NC, 28166")).toBe("152 rushing water ln");
		expect(community.streetKey("10 N. Main Street Apt 4, Mooresville")).toBe("10 n main st");
	});
	it("needs a house number", () => {
		expect(community.streetKey("the blue house")).toBeNull();
		expect(community.streetKey("Rushing Water Ln")).toBeNull();
	});
});

describe("saveNeighbor / saveEvent", () => {
	it("requires an address with a house number", async () => {
		mockDb();
		await expect(community.saveNeighbor(1, { name: "The Hendersons" })).rejects.toMatchObject({ status: 400 });
		await expect(community.saveNeighbor(1, { name: "The Hendersons", address: "two doors down" })).rejects.toMatchObject({ status: 400 });
	});
	it("keys a new household on its street line, name optional", async () => {
		mockDb();
		await community.saveNeighbor(1, { address: "152 Rushing Water Lane, Troutman, NC" });
		const insert = db.query.mock.calls.find(([sql]) => /INSERT INTO athena_neighbor\s*\(/.test(sql));
		expect(insert[1].slice(2, 5)).toEqual([null, "152 Rushing Water Lane, Troutman, NC", "152 rushing water ln"]);
	});
	it("refuses a second household at the same address", async () => {
		db.query.mockImplementation(async (sql) => {
			if (/COUNT/.test(sql)) return [[{ n: 0 }]];
			if (/INSERT INTO athena_neighbor\s*\(/.test(sql)) throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" });
			return [[]];
		});
		await expect(community.saveNeighbor(1, { address: "152 Rushing Water Ln" })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/already have a household at 152 Rushing Water Ln/) });
	});
	it("scopes an edit to the caller's own row", async () => {
		mockDb({ existing: null });
		await expect(community.saveNeighbor(7, { uuid: "n-1", address: "152 Rushing Water Ln" })).rejects.toMatchObject({ status: 404 });
		const lookup = db.query.mock.calls.find(([sql]) => /SELECT id FROM athena_neighbor/.test(sql));
		expect(lookup[1]).toEqual([7, "n-1"]);
	});
	it("rejects an event without a real date or with a non-web link", async () => {
		mockDb();
		await expect(community.saveEvent(1, { title: "Ham Day", startsOn: "Saturday" })).rejects.toMatchObject({ status: 400 });
		await expect(community.saveEvent(1, { title: "Ham Day", startsOn: "2026-09-26", url: "javascript:alert(1)" })).rejects.toMatchObject({ status: 400 });
	});
	it("rejects an end before the start", async () => {
		mockDb();
		await expect(community.saveEvent(1, { title: "Fair", startsOn: "2026-10-10", endsOn: "2026-10-09" })).rejects.toMatchObject({ status: 400 });
	});
});

describe("promptBlock", () => {
	const now = new Date("2026-10-04T16:00:00Z");

	it("is null when nothing has been saved", async () => {
		mockDb({ places: [] });
		expect(await community.promptBlock(1, now)).toBeNull();
	});

	it("names places, neighbours and a recent yearly event", async () => {
		mockDb({
			neighbors: [household(1, { name: "The Hendersons", address: "152 Rushing Water Ln, Troutman, NC", place_uuid: "p-home", where_text: "two doors down", contact: "704-555-0100", notes: "have a generator" })],
			events: [{ uuid: "e-1", title: "Ham Day", starts_on: "2026-09-26", ends_on: null, time_text: "9am-3pm", place_uuid: null, location_text: "Downtown Troutman", repeats: "yearly", url: null, notes: null }],
		});
		const block = await community.promptBlock(1, now);
		expect(block).toContain("# Their community");
		expect(block).toContain("Troutman ARP Church (church; 1 mi ring) — Wednesday suppers");
		expect(block).toContain("The Hendersons (152 Rushing Water Ln; two doors down, near Home) — have a generator");
		expect(block).toContain("Just happened:");
		expect(block).toMatch(/Ham Day — Sat, Sep 26 \(8 days ago\), 9am-3pm at Downtown Troutman \(every year\)/);
		// A neighbour's phone number is kept for the page, not recited to the model.
		expect(block).not.toContain("704-555-0100");
	});

	it("leaves out events far in the future", async () => {
		mockDb({
			events: [{ uuid: "e-2", title: "Spring Fling", starts_on: "2027-04-10", ends_on: null, time_text: null, place_uuid: null, location_text: null, repeats: "none", url: null, notes: null }],
		});
		expect(await community.promptBlock(1, now)).not.toContain("Spring Fling");
	});
});

describe("overview", () => {
	it("still answers when the news can't be read", async () => {
		mockDb();
		news.getNews.mockRejectedValue(new Error("down"));
		const out = await community.overview(1);
		expect(out.places).toHaveLength(2);
		expect(out.localNews).toBeNull();
		expect(out.kinds).toContain("church");
	});
});

describe("Google Contacts links", () => {
	const BILL = {
		contactId: "111", name: "Bill Henderson", givenName: "Bill", familyName: "Henderson", nicknames: [],
		emails: [{ value: "bill@example.com" }], phones: [{ value: "+17045550100" }],
		addresses: [{ value: "152 Rushing Water Ln, Troutman, NC" }], photoUrl: "https://lh3.example/bill",
	};
	const CAROL = { ...BILL, contactId: "222", name: "Carol Henderson", givenName: "Carol", emails: [], phones: [] };
	// Each test uses its own profile id: the address book is cached per person.
	let profile = 100;
	const next = () => ++profile;

	it("searches by name, email and phone digits", async () => {
		mockDb();
		googleContacts.listContacts.mockResolvedValue([CAROL, BILL]);
		const id = next();
		expect((await community.searchContacts(id, "hend")).matches.map((m) => m.name)).toEqual(["Bill Henderson", "Carol Henderson"]);
		expect((await community.searchContacts(id, "bill@")).matches.map((m) => m.contactId)).toEqual(["111"]);
		expect((await community.searchContacts(id, "555-0100")).matches.map((m) => m.contactId)).toEqual(["111"]);
		// One read of the address book for all three searches.
		expect(googleContacts.listContacts).toHaveBeenCalledTimes(1);
	});

	it("says when Contacts isn't connected", async () => {
		googleContacts.listContacts.mockResolvedValue(null);
		expect(await community.searchContacts(next(), "bill")).toEqual({ linked: false, matches: [] });
	});

	it("rejects a malformed contact id", async () => {
		mockDb();
		await expect(community.saveNeighbor(next(), { address: "152 Rushing Water Ln", contacts: [{ contactId: "people/c1" }] })).rejects.toMatchObject({ status: 400 });
	});

	it("links several contacts to one household, names from Google", async () => {
		mockDb();
		googleContacts.listContacts.mockResolvedValue([BILL, CAROL]);
		await community.saveNeighbor(next(), { address: "152 Rushing Water Ln", contacts: [{ contactId: "111" }, { contactId: "222" }, { contactId: "111" }] });
		const inserts = db.query.mock.calls.filter(([sql]) => /INSERT INTO athena_neighbor_contact/.test(sql));
		expect(inserts.map(([, params]) => [params[2], params[3]])).toEqual([["111", "Bill Henderson"], ["222", "Carol Henderson"]]);
		const cleanup = db.query.mock.calls.find(([sql]) => /DELETE FROM athena_neighbor_contact/.test(sql));
		expect(cleanup[1][2]).toEqual(["111", "222"]);
	});

	it("refuses a contact already at another household, by name", async () => {
		mockDb({ elsewhere: [{ contact_id: "111", contact_name: "Bill Henderson", name: "The Hendersons", address: "152 Rushing Water Ln" }] });
		await expect(community.saveNeighbor(next(), { address: "160 Rushing Water Ln", contacts: [{ contactId: "111" }] }))
			.rejects.toMatchObject({ status: 400, message: "Bill Henderson is already linked to The Hendersons. Unlink them there first." });
	});

	it("suggests contacts whose Google address is the household's street line", async () => {
		mockDb();
		const MARIA = { ...BILL, contactId: "333", name: "Maria Lopez", addresses: [{ value: "140 Rushing Water Lane, Troutman NC 28166" }] };
		googleContacts.listContacts.mockResolvedValue([BILL, CAROL, MARIA]);
		const { matches } = await community.contactsAtAddress(next(), "152 RUSHING WATER LN, TROUTMAN, NC, 28166");
		expect(matches.map((m) => m.name)).toEqual(["Bill Henderson", "Carol Henderson"]);
	});

	it("fills each linked contact with current details, and keeps a missing one marked", async () => {
		mockDb({
			neighbors: [household(1, { name: "The Hendersons", address: "152 Rushing Water Ln" })],
			links: [{ neighbor_id: 1, contact_id: "111", contact_name: "Bill" }, { neighbor_id: 1, contact_id: "999", contact_name: "Old friend" }],
		});
		news.getNews.mockResolvedValue({ items: [] });
		googleContacts.listContacts.mockResolvedValue([BILL]);
		const { neighbors } = await community.overview(next());
		expect(neighbors[0].contacts[0]).toMatchObject({ name: "Bill Henderson", status: "ok", card: { phone: "+17045550100" } });
		expect(neighbors[0].contacts[1]).toMatchObject({ contactId: "999", name: "Old friend", card: null, status: "missing" });
		// The renamed snapshot is refreshed.
		expect(db.query.mock.calls.some(([sql, params]) => /UPDATE athena_neighbor_contact SET contact_name/.test(sql) && params[0] === "Bill Henderson")).toBe(true);
	});

	it("never drops a link because Google couldn't be read", async () => {
		mockDb({ neighbors: [household(1, { address: "152 Rushing Water Ln" })], links: [{ neighbor_id: 1, contact_id: "111", contact_name: "Bill Henderson" }] });
		news.getNews.mockResolvedValue({ items: [] });
		googleContacts.listContacts.mockRejectedValue(new Error("403"));
		const { neighbors } = await community.overview(next());
		expect(neighbors[0].contacts[0]).toMatchObject({ contactId: "111", name: "Bill Henderson", status: "unreadable" });
	});

	it("tells Athena who lives there, without their details or a call to Google", async () => {
		mockDb({
			neighbors: [household(1, { name: "The Hendersons", address: "152 Rushing Water Ln, Troutman" }), household(2, { address: "140 Rushing Water Ln" })],
			links: [{ neighbor_id: 1, contact_id: "111", contact_name: "Bill Henderson" }, { neighbor_id: 1, contact_id: "222", contact_name: "Carol Henderson" }, { neighbor_id: 2, contact_id: "333", contact_name: "Maria Lopez" }],
		});
		const block = await community.promptBlock(next(), new Date("2026-10-04T16:00:00Z"));
		expect(block).toContain("The Hendersons (152 Rushing Water Ln) [Bill Henderson, Carol Henderson — in their Google Contacts]");
		expect(block).toContain("- Maria Lopez (140 Rushing Water Ln) [in their Google Contacts]");
		expect(googleContacts.listContacts).not.toHaveBeenCalled();
	});
});
