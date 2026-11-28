jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../llm", () => ({ generateJson: jest.fn(), decide: jest.fn() }));
jest.mock("../family", () => ({ getFamilyForProfile: jest.fn().mockResolvedValue(null), listChildren: jest.fn().mockResolvedValue([]) }));
// The registry pulls these in; mocked as in actions/actions.test.js.
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("../consent", () => ({ hasConsentForProfile: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn() }));
jest.mock("../connectors/googleCalendar", () => ({ createEvent: jest.fn(), deleteEvent: jest.fn() }));
jest.mock("../lookRequests", () => ({ create: jest.fn() }));
jest.mock("../codeAgents", () => ({ REPOS: { core_api: { full: "o/core", about: "backend" } }, mayUse: jest.fn(async () => false) }));
jest.mock("../memory", () => ({ CATEGORIES: new Set(["interest", "routine", "other"]), upsertMemoryForProfile: jest.fn() }));
jest.mock("../push", () => ({ sendMediaControl: jest.fn(), hasReachablePhone: jest.fn() }));

const pool = require("../../helpers/db");
const llm = require("../llm");
const collections = require("./index");
const entities = require("../entities");
const actions = require("./actions");
const registry = require("../actions/registry");

const NOW = new Date("2026-11-28T15:00:00Z");
const action = (id) => actions.find((a) => a.id === id);

beforeEach(() => {
	jest.clearAllMocks();
	jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("who do you mean", () => {
	const everyone = [
		{ key: "k-sky", name: "Skylar Bryson", names: ["skylar", "bryson"], relationWords: [] },
		{ key: "k-tom", name: "Thomas Bryson", names: ["thomas", "bryson"], relationWords: [] },
		{ key: "k-mw", name: "Mark Watson", names: ["mark", "watson"], relationWords: ["uncle"] },
		{ key: "k-mk", name: "Mark Kennedy", names: ["mark", "kennedy"], relationWords: [] },
		{ key: "k-mom", name: "Cindy Bryson", names: ["cindy", "bryson"], relationWords: ["mother", "mom", "mum", "mama", "mommy"] },
	];

	test("a name only one person has wins outright", () => {
		expect(entities.decide(entities.score("Skylar", everyone)).person.key).toBe("k-sky");
	});

	test("a shared surname alone is not enough to pick anyone", () => {
		expect(entities.decide(entities.score("the Brysons", everyone)).person).toBeUndefined();
	});

	test("two people with the same first name means asking", () => {
		const out = entities.decide(entities.score("Mark", everyone));
		expect(out.ambiguous.map((p) => p.key).sort()).toEqual(["k-mk", "k-mw"]);
	});

	test("a relation word breaks the tie", () => {
		expect(entities.decide(entities.score("my uncle Mark", everyone)).person.key).toBe("k-mw");
	});

	test("a confirmed alias is decisive", () => {
		const confirmed = [{ alias: "mark", person_key: "k-mk" }];
		expect(entities.decide(entities.score("Mark", everyone, confirmed)).person.key).toBe("k-mk");
	});

	test("mom resolves by relation", () => {
		expect(entities.decide(entities.score("Mom", everyone)).person.key).toBe("k-mom");
	});

	test("aliases are stored as plain words", () => {
		expect(entities.aliasKey("My Uncle Mark!")).toBe("uncle mark");
	});
});

describe("definitions", () => {
	test("a Christmas list definition is accepted and shaped", () => {
		const def = collections.normalizeDefinition(
			{
				name: "Christmas list 2026",
				perPerson: true,
				statuses: ["Idea", "bought", "given", "suggested"],
				fields: [{ name: "Price", type: "money" }, { name: "link", type: "link" }, { name: "title", type: "text" }],
				endsOn: "2026-12-26",
				home: "top",
			},
			{ now: NOW }
		);
		expect(def.statuses).toEqual(["idea", "bought", "given"]);
		expect(def.fields.map((f) => f.name)).toEqual(["price", "link"]); // reserved "title" dropped
		expect(def).toMatchObject({ perPerson: true, home: "top", endsOn: "2026-12-26" });
	});

	test("unknown field types, past end dates and missing names are refused", () => {
		expect(() => collections.normalizeDefinition({ name: "x", fields: [{ name: "a", type: "blob" }] }, { now: NOW })).toThrow(/unknown type/);
		expect(() => collections.normalizeDefinition({ name: "x", endsOn: "2026-01-01" }, { now: NOW })).toThrow(/already past/);
		expect(() => collections.normalizeDefinition({}, { now: NOW })).toThrow(/needs a name/);
	});

	test("a choice field needs real choices", () => {
		expect(() => collections.normalizeDefinition({ name: "x", fields: [{ name: "size", type: "choice", choices: ["S"] }] }, { now: NOW })).toThrow(/2 to 12 choices/);
	});

	test("values are checked against field types", () => {
		const def = collections.normalizeDefinition({ name: "x", fields: [{ name: "price", type: "money", required: true }, { name: "link", type: "link" }] }, { now: NOW });
		expect(collections.normalizeValues(def, [{ field: "price", value: "$120.50" }])).toEqual({ price: 120.5 });
		expect(() => collections.normalizeValues(def, [{ field: "price", value: "lots" }])).toThrow(/must be a number/);
		expect(() => collections.normalizeValues(def, [{ field: "colour", value: "red" }])).toThrow(/isn't a field/);
		expect(() => collections.normalizeValues(def, [])).toThrow(/needs price/);
		expect(() => collections.normalizeValues(def, [{ field: "link", value: "javascript:alert(1)" }], { partial: true })).toThrow(/link/);
	});
});

describe("the five actions", () => {
	test("all five are registered; only the item actions may be standing", () => {
		const standing = Object.fromEntries(["define_collection", "add_item", "update_item", "remove_item", "archive_collection"].map((id) => [id, registry.get(id)?.standing]));
		expect(standing).toEqual({ define_collection: false, add_item: true, update_item: true, remove_item: true, archive_collection: false });
	});

	test("define_collection resolves the people and refuses someone unknown", async () => {
		pool.query.mockImplementation(async (sql) => {
			if (/FROM user_memory/.test(sql)) return [[
				{ uuid: "11111111-1111-1111-1111-111111111111", category: "family", memory_key: "daughter", memory_value: "Skylar Bryson; loves horses" },
				{ uuid: "22222222-2222-2222-2222-222222222222", category: "family", memory_key: "son", memory_value: "Thomas Bryson" },
			]];
			if (/athena_entity_alias/.test(sql)) return [[]];
			if (/FROM athena_collection/.test(sql)) return [[]];
			return [[]];
		});
		const out = await action("define_collection").normalize(
			{ collection_name: "Christmas list 2026", collection_people: ["Skylar", "Thomas"], collection_statuses: ["idea", "bought", "given"], collection_ends_on: "2026-12-26" },
			{ profileId: 1 }
		);
		expect(out.people.map((p) => p.label)).toEqual(["Skylar Bryson", "Thomas Bryson"]);
		expect(out.definition.perPerson).toBe(true);
		expect(action("define_collection").summarize(out)).toBe('Start "Christmas list 2026": Skylar Bryson, Thomas Bryson, until 2026-12-26');
		await expect(action("define_collection").normalize({ collection_name: "List", collection_people: ["Zelda"] }, { profileId: 1 })).rejects.toMatchObject({
			code: "invalid_action_params",
		});
	});

	test("add_item on a per-person list needs to know who it is for", async () => {
		const row = { id: 9, uuid: "c-9", slug: "christmas-list-2026", name: "Christmas list 2026", version: 1, ends_on: null, archived_at: null, definition: JSON.stringify({ perPerson: true, statuses: ["idea", "bought"], fields: [] }) };
		pool.query.mockImplementation(async (sql) => (/FROM athena_collection\b/.test(sql) ? [[row]] : [[]]));
		await expect(action("add_item").normalize({ collection: "Christmas", collection_item: "Telescope" }, { profileId: 1 })).rejects.toThrow(/Who is it for/);
	});
});

describe("capture from chat", () => {
	test("writes a suggestion only for someone already on the list, and never twice", async () => {
		const capture = require("./capture");
		const row = { id: 9, uuid: "c-9", slug: "christmas-list-2026", name: "Christmas list 2026", version: 1, ends_on: null, archived_at: null, definition: JSON.stringify({ perPerson: true, statuses: ["idea", "bought"], fields: [] }) };
		const inserts = [];
		pool.query.mockImplementation(async (sql, args) => {
			if (/FROM athena_collection\b/.test(sql)) return [[row]];
			if (/FROM athena_collection_subject/.test(sql)) return [[{ id: 3, uuid: "s-3", person_key: "k", label: "Thomas Bryson", done_at: null }]];
			if (/LOWER\(title\)/.test(sql)) return [[{ subject_id: 3, t: "lego set" }]];
			if (/COUNT\(\*\)/.test(sql)) return [[{ n: 0 }]];
			if (/INSERT INTO athena_collection_item/.test(sql)) {
				inserts.push(args);
				return [{ affectedRows: 1 }];
			}
			return [[]];
		});
		llm.generateJson.mockResolvedValue({
			data: {
				claims: [
					{ list: "l1", person: "Thomas", title: "Telescope", reason: "said he's into astronomy" },
					{ list: "l1", person: "Thomas", title: "Lego set", reason: "already there" },
					{ list: "l1", person: "Grandma", title: "Scarf", reason: "not on the list" },
				],
			},
		});
		const out = await capture.fromChat(1, "Thomas has been obsessed with the stars lately, he'd love a telescope");
		expect(out.written).toBe(1);
		expect(inserts[0]).toEqual(expect.arrayContaining(["Telescope", "suggested", "chat"]));
	});

	test("a short message or no lists costs no model call", async () => {
		const capture = require("./capture");
		pool.query.mockResolvedValue([[]]);
		expect((await capture.fromChat(1, "ok")).written).toBe(0);
		expect((await capture.fromChat(1, "what's the weather like tomorrow?")).written).toBe(0);
		expect(llm.generateJson).not.toHaveBeenCalled();
	});
});
