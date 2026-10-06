jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./family", () => ({ getFamilyForProfile: jest.fn(), listChildren: jest.fn() }));
jest.mock("./community", () => ({ contactsFor: jest.fn() }));
jest.mock("./memory", () => ({ memoryEvents: { emit: jest.fn() } }));

const db = require("../helpers/db");
const family = require("./family");
const community = require("./community");
const people = require("./familyPeople");

const LINK = { fact_uuid: "f-1", contact_id: "111", contact_name: "Linda" };
const CONTACT = { contactId: "111", name: "Linda Smith", birthday: "--03-14", phones: [{ value: "+15551234567" }], emails: [], photoUrl: null };

beforeEach(() => jest.resetAllMocks());

describe("isoDay", () => {
	test("keeps a plain date, trims a datetime, reads a Date in local time", () => {
		expect(people.isoDay("2015-05-03")).toBe("2015-05-03");
		expect(people.isoDay("2015-05-03T00:00:00.000Z")).toBe("2015-05-03");
		expect(people.isoDay(new Date(2015, 4, 3))).toBe("2015-05-03");
		expect(people.isoDay(null)).toBeNull();
		expect(people.isoDay("May 3")).toBeNull();
	});
});

describe("overview", () => {
	test("children come from the family profiles with a normalized birthday", async () => {
		family.getFamilyForProfile.mockResolvedValue({ id: 7 });
		family.listChildren.mockResolvedValue([{ uuid: "c1", display_name: "Maya", birthday: new Date(2016, 9, 8), grade: "3" }]);
		db.query.mockResolvedValue([[]]);
		const out = await people.overview(1);
		expect(out.children).toEqual([{ uuid: "c1", name: "Maya", birthday: "2016-10-08", grade: "3" }]);
		expect(out.links).toEqual([]);
	});

	test("no family, no children — and no Google call when nothing is linked", async () => {
		family.getFamilyForProfile.mockResolvedValue(null);
		db.query.mockResolvedValue([[]]);
		const out = await people.overview(1);
		expect(out.children).toEqual([]);
		expect(community.contactsFor).not.toHaveBeenCalled();
	});

	test("a link reads its contact's birthday from Google", async () => {
		family.getFamilyForProfile.mockResolvedValue(null);
		db.query.mockResolvedValue([[LINK]]);
		community.contactsFor.mockResolvedValue([CONTACT]);
		const { links, contactsLinked } = await people.overview(1);
		expect(contactsLinked).toBe(true);
		expect(links[0]).toMatchObject({ factUuid: "f-1", status: "ok", name: "Linda Smith", card: { birthday: "--03-14" } });
	});

	test.each([
		["Contacts not linked", null, "not_connected"],
		["contact deleted in Google", [], "missing"],
	])("%s keeps the link and says why", async (_label, book, status) => {
		family.getFamilyForProfile.mockResolvedValue(null);
		db.query.mockResolvedValue([[LINK]]);
		community.contactsFor.mockResolvedValue(book);
		const { links } = await people.overview(1);
		expect(links[0]).toMatchObject({ contactId: "111", name: "Linda", card: null, status });
	});

	test("a Google outage never drops the link", async () => {
		family.getFamilyForProfile.mockResolvedValue(null);
		db.query.mockResolvedValue([[LINK]]);
		community.contactsFor.mockRejectedValue(new Error("boom"));
		const { links } = await people.overview(1);
		expect(links[0].status).toBe("unreadable");
	});
});

describe("linkContact", () => {
	const mockDb = ({ fact = { uuid: "f-1" }, taken = null } = {}) =>
		db.query.mockImplementation(async (sql) => {
			if (/FROM user_memory WHERE/.test(sql)) return [fact ? [fact] : []];
			if (/fact_uuid <> \?/.test(sql)) return [taken ? [taken] : []];
			return [[]];
		});

	test("rejects ids that are not People API contact ids", async () => {
		await expect(people.linkContact(1, "f-1", { contactId: "1; DROP" })).rejects.toMatchObject({ status: 400 });
		expect(db.query).not.toHaveBeenCalled();
	});

	test("only the caller's own person/family/pet memories can be linked", async () => {
		mockDb({ fact: null });
		await expect(people.linkContact(1, "someone-elses", { contactId: "111" })).rejects.toMatchObject({ status: 404 });
		const [sql, params] = db.query.mock.calls[0];
		expect(sql).toMatch(/profile_id = \?/);
		expect(params).toEqual([1, "someone-elses", ["person", "family", "pet"]]);
	});

	test("a contact already linked to another person is refused", async () => {
		mockDb({ taken: { fact_uuid: "f-2" } });
		await expect(people.linkContact(1, "f-1", { contactId: "111" })).rejects.toMatchObject({ status: 400 });
	});

	test("links, taking the name from the address book", async () => {
		mockDb();
		community.contactsFor.mockResolvedValue([CONTACT]);
		family.getFamilyForProfile.mockResolvedValue(null);
		await people.linkContact(1, "f-1", { contactId: "111", name: "Stale" });
		const insert = db.query.mock.calls.find(([sql]) => /INSERT INTO athena_family_contact/.test(sql));
		expect(insert[1]).toEqual([1, "f-1", "111", "Linda Smith"]);
	});
});

describe("removePerson / mergePeople", () => {
	const memory = require("./memory");
	const A = { id: 1, uuid: "a", category: "person", memory_key: "Name", memory_value: "likes soccer" };
	const B = { id: 2, uuid: "b", category: "person", memory_key: "Skylar", memory_value: "daughter, 8" };
	const mockDb = ({ facts = [A, B], intoLink = null } = {}) =>
		db.query.mockImplementation(async (sql, params) => {
			if (/FROM user_memory\s+WHERE profile_id = \? AND uuid/.test(sql)) return [[facts.find((f) => f.uuid === params[1])].filter(Boolean)];
			if (/SELECT id FROM athena_family_contact/.test(sql)) return [[intoLink]];
			return [[]];
		});
	const ran = (re) => db.query.mock.calls.filter(([sql]) => re.test(sql));

	test("delete forgets the memory and its link, only for the caller's own person", async () => {
		mockDb();
		family.getFamilyForProfile.mockResolvedValue(null);
		await people.removePerson(1, "a");
		expect(ran(/SET deleted_at = NOW/)).toHaveLength(1);
		expect(ran(/DELETE FROM athena_family_contact/)[0][1]).toEqual([1, "a"]);
		expect(memory.memoryEvents.emit).toHaveBeenCalledWith("fact:deleted", { id: 1, profile_id: 1 });
	});

	test("deleting someone that is not theirs is a 404 and writes nothing", async () => {
		mockDb({ facts: [] });
		await expect(people.removePerson(1, "x")).rejects.toMatchObject({ status: 404 });
		expect(ran(/SET deleted_at/)).toHaveLength(0);
	});

	test("merge appends what was known, moves the link, forgets the duplicate", async () => {
		mockDb();
		family.getFamilyForProfile.mockResolvedValue(null);
		await people.mergePeople(1, "a", "b");
		expect(ran(/SET memory_value/)[0][1][0]).toBe("daughter, 8; likes soccer");
		expect(ran(/SET fact_uuid = \?/)[0][1]).toEqual(["b", 1, "a"]);
		expect(ran(/SET deleted_at = NOW/)[0][1]).toEqual([1]);
	});

	test("merge does not repeat what the target already says, and keeps the target's own link", async () => {
		mockDb({ facts: [{ ...A, memory_value: "Daughter, 8" }, B], intoLink: { id: 9 } });
		family.getFamilyForProfile.mockResolvedValue(null);
		await people.mergePeople(1, "a", "b");
		expect(ran(/SET memory_value/)).toHaveLength(0);
		expect(ran(/SET fact_uuid = \?/)).toHaveLength(0);
		expect(ran(/DELETE FROM athena_family_contact/)[0][1]).toEqual([1, "a"]);
	});

	test("merging someone into themselves is refused", async () => {
		await expect(people.mergePeople(1, "a", "a")).rejects.toMatchObject({ status: 400 });
		expect(db.query).not.toHaveBeenCalled();
	});
});
