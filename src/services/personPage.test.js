/**
 * A person's page: who may be read, name matching for memories and health,
 * and the page's own writes. The database is mocked.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./familyPeople", () => ({ ownFact: jest.fn() }));
jest.mock("./family", () => ({
	getFamilyForProfile: jest.fn(async () => ({ id: 7 })),
	listChildren: jest.fn(async () => [{ uuid: "11111111-1111-1111-1111-111111111111", display_name: "Maya" }]),
}));

const pool = require("../helpers/db");
const familyPeople = require("./familyPeople");
const page = require("./personPage");

const FACT = "22222222-2222-2222-2222-222222222222";
const OTHER = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
	pool.query.mockReset();
	familyPeople.ownFact.mockReset().mockImplementation(async (_p, uuid) =>
		[FACT, OTHER].includes(uuid) ? { uuid, category: "person", memory_key: "Skylar" } : null
	);
});

/** Answer each query by what it reads, so the parallel reads don't depend on order. */
function db(answers = {}) {
	pool.query.mockImplementation(async (sql) => {
		for (const [needle, rows] of Object.entries(answers)) if (sql.includes(needle)) return [rows];
		if (/^\s*(INSERT|UPDATE)/.test(sql)) return [{ affectedRows: 1 }];
		return [[]];
	});
}

describe("who can be read", () => {
	it("refuses a memory that isn't the caller's", async () => {
		await expect(page.read(1, "44444444-4444-4444-4444-444444444444")).rejects.toMatchObject({ status: 404 });
		expect(pool.query).not.toHaveBeenCalled();
	});

	it("refuses anything that isn't a uuid or a child key", async () => {
		await expect(page.read(1, "1 OR 1=1")).rejects.toMatchObject({ status: 404 });
	});

	it("reads a child on the family's profiles by child key", async () => {
		db();
		const out = await page.read(1, "child:11111111-1111-1111-1111-111111111111");
		expect(out.key).toBe("child:11111111-1111-1111-1111-111111111111");
	});
});

describe("nameTokens", () => {
	it("keeps up to four plain name words and drops anything else", () => {
		expect(page.nameTokens("Skylar,sky,%,bryson,a,o'neil,x;drop,more,extra")).toEqual(["skylar", "sky", "bryson", "o'neil"]);
		expect(page.nameTokens(undefined)).toEqual([]);
	});
});

describe("read", () => {
	it("keeps only memories that mention them as a whole word", async () => {
		db({
			"FROM memory_event": [
				{ uuid: "m1", kind: "conversation", title: null, content: "Skylar loved robotics club", occurred_at: new Date(), importance: 8, source: "ai" },
				{ uuid: "m2", kind: "conversation", title: null, content: "Skylarks were singing", occurred_at: new Date(), importance: 3, source: "ai" },
			],
		});
		const out = await page.read(1, FACT, { names: "skylar" });
		expect(out.memories.map((m) => m.uuid)).toEqual(["m1"]);
	});

	it("reads no memories or health without names to match", async () => {
		db();
		const out = await page.read(1, FACT, {});
		expect(out.memories).toEqual([]);
		expect(out.health).toEqual([]);
		expect(pool.query.mock.calls.some(([sql]) => sql.includes("memory_event"))).toBe(false);
	});

	it("lists every health watch on them by name, ended ones too", async () => {
		db({
			family_health_status: [
				{ uuid: "h1", person_name: "Skylar", symptom: "fever", severity: "mild", status: "active", started_at: new Date("2026-11-22") },
				{ uuid: "h2", person_name: "Skylar Bryson", symptom: "cough", severity: "mild", status: "resolved", started_at: new Date("2026-10-01"), resolved_at: new Date("2026-10-03") },
				{ uuid: "h3", person_name: "Thomas", symptom: "ear ache", severity: "severe", status: "active", started_at: new Date("2026-11-18") },
			],
		});
		const out = await page.read(1, FACT, { names: "skylar" });
		expect(out.health.map((h) => h.uuid)).toEqual(["h1", "h2"]);
	});

	it("still answers when one part can't be read", async () => {
		pool.query.mockImplementation(async (sql) => {
			if (sql.includes("memory_event")) throw new Error("boom");
			return [[]];
		});
		const out = await page.read(1, FACT, { names: "skylar" });
		expect(out.memories).toEqual([]);
	});
});

describe("writes", () => {
	it("refuses an interest already on the list", async () => {
		db({ athena_person_interest: [{ uuid: "i1", label: "Basketball", icon: "ball" }] });
		await expect(page.addInterest(1, FACT, { label: "basketball" })).rejects.toMatchObject({ status: 409 });
	});

	it("stores an unknown icon as none", async () => {
		db();
		await page.addInterest(1, FACT, { label: "Tacos", icon: "<script>" });
		const insert = pool.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO athena_person_interest"));
		expect(insert[1].slice(3, 5)).toEqual(["Tacos", null]);
	});

	it("relates only someone else of the caller's", async () => {
		db();
		await expect(page.addRelated(1, FACT, { otherKey: FACT, label: "Self" })).rejects.toMatchObject({ status: 400 });
		await expect(page.addRelated(1, FACT, { otherKey: "55555555-5555-5555-5555-555555555555", label: "Brother" })).rejects.toMatchObject({ status: 404 });
		await page.addRelated(1, FACT, { otherKey: OTHER, label: "Brother" });
		expect(pool.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO athena_person_relation"))).toBe(true);
	});

	it("keeps the relation when only the write-up changes", async () => {
		db({ "FROM athena_person WHERE": [{ about: "old", relation: "Daughter" }] });
		await page.saveAbout(1, FACT, { about: "Our creative 4th grader" });
		const upsert = pool.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO athena_person "));
		expect(upsert[1].slice(2)).toEqual(["Our creative 4th grader", "Daughter"]);
	});
});
