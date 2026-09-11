/**
 * Memory v2 tests: time ranges, recall intent + ranking + honesty, extraction
 * safety rules, and the news feed parser.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }));
jest.mock("../llm", () => ({
	embed: jest.fn(),
	embeddingSpace: () => "test:space",
	generateJson: jest.fn(),
}));

const pool = require("../../helpers/db");
const llm = require("../llm");
const { parseTimeRange } = require("./timeRange");
const recallModule = require("./recall");
const vectorIndex = require("./vectorIndex");

beforeEach(() => {
	pool.query.mockReset();
	llm.embed.mockReset();
	llm.generateJson.mockReset();
	vectorIndex._reset();
});

describe("parseTimeRange (America/New_York)", () => {
	// Thursday 2026-09-10 15:00 EDT
	const now = new Date("2026-09-10T19:00:00Z");
	const tz = "America/New_York";
	const iso = (d) => d.toISOString();

	test("yesterday is the previous LOCAL day", () => {
		const r = parseTimeRange("what did we talk about yesterday?", { now, tz });
		expect(iso(r.from)).toBe("2026-09-09T04:00:00.000Z");
		expect(iso(r.to)).toBe("2026-09-10T04:00:00.000Z");
	});

	test("last week is the previous Sunday-to-Sunday week", () => {
		const r = parseTimeRange("remember last week?", { now, tz });
		expect(iso(r.from)).toBe("2026-08-30T04:00:00.000Z");
		expect(iso(r.to)).toBe("2026-09-06T04:00:00.000Z");
	});

	test("'in June' said in September means this year's June", () => {
		const r = parseTimeRange("the trip in june", { now, tz });
		expect(r.from.getUTCMonth()).toBe(5);
		expect(r.from.getUTCFullYear()).toBe(2026);
	});

	test("'in December' said in September means last December", () => {
		const r = parseTimeRange("that party in december", { now, tz });
		expect(r.from.getUTCFullYear()).toBe(2025);
	});

	test("'on Tuesday' said on Thursday is two days back", () => {
		const r = parseTimeRange("what did I say on tuesday", { now, tz });
		expect(iso(r.from)).toBe("2026-09-08T04:00:00.000Z");
	});

	test("N days ago gets a window around the day", () => {
		const r = parseTimeRange("3 days ago", { now, tz });
		expect(r.from < new Date("2026-09-07T12:00:00Z")).toBe(true);
		expect(r.to > new Date("2026-09-07T12:00:00Z")).toBe(true);
	});

	test("no time phrase -> null", () => {
		expect(parseTimeRange("tell me about dinosaurs", { now, tz })).toBeNull();
	});
});

describe("recall intent", () => {
	test.each([
		"Do you remember what my dog's name is?",
		"remember when we talked about Iceland?",
		"What do you know about my sister?",
		"did I ever tell you about the lake house",
		"what did we decide about the car",
	])("detects %p", (t) => expect(recallModule.detectRecallIntent(t)).toBe(true));

	test.each(["what's the weather like", "I love pizza", "tell me a joke"])("ignores %p", (t) =>
		expect(recallModule.detectRecallIntent(t)).toBe(false)
	);
});

describe("formatForPrompt honesty", () => {
	test("an explicit recall question with no hits tells Athena to admit it", () => {
		const block = recallModule.formatForPrompt({ intent: true, items: [], timeRange: null });
		expect(block).toMatch(/Nothing in your long-term memory matches/);
		expect(block).toMatch(/never invent a memory/);
	});

	test("ordinary chat with nothing relevant adds no block at all", () => {
		expect(recallModule.formatForPrompt({ intent: false, items: [] })).toBeNull();
	});
});

describe("vector index", () => {
	test("float32 encode/decode round trip is normalized", () => {
		const buf = vectorIndex.encode([3, 4]);
		const v = vectorIndex.decodeNormalized(buf);
		expect(v[0]).toBeCloseTo(0.6);
		expect(v[1]).toBeCloseTo(0.8);
	});
});

/**
 * A tiny fake of the tables recall touches, answering by SQL shape.
 */
function fakeDb({ embeddings = [], events = [], facts = [], ftEvents = [], ftFacts = [] }) {
	pool.query.mockImplementation(async (sql, params) => {
		if (sql.includes("FROM memory_embedding")) return [embeddings];
		if (sql.includes("MATCH(title, content)")) return [ftEvents];
		if (sql.includes("MATCH(memory_key, memory_value)")) return [ftFacts];
		if (sql.includes("FROM memory_event") && sql.includes("id IN")) {
			const ids = params.slice(0, -1).map(Number);
			return [events.filter((e) => ids.includes(e.id))];
		}
		if (sql.includes("FROM memory_event") && sql.includes("occurred_at >= ?")) {
			return [events.filter((e) => e.windowed).map((e) => ({ id: e.id }))];
		}
		if (sql.includes("FROM user_memory") && sql.includes("id IN")) {
			const ids = params.slice(0, -1).map(Number);
			return [facts.filter((f) => ids.includes(f.id))];
		}
		if (sql.includes("FROM message m")) return [[]];
		if (sql.startsWith("UPDATE memory_event")) return [{ affectedRows: 1 }];
		return [[]];
	});
}

const vecRow = (id, type, memoryId, vector) => ({
	id,
	memory_type: type,
	memory_id: memoryId,
	vector: vectorIndex.encode(vector),
});

describe("recall ranking", () => {
	const now = new Date("2026-09-10T19:00:00Z").getTime();

	test("semantic match outranks an unrelated but recent memory", async () => {
		fakeDb({
			embeddings: [vecRow(1, "event", 10, [1, 0, 0]), vecRow(2, "event", 11, [0, 1, 0])],
			events: [
				{ id: 10, uuid: "e10", kind: "photo", title: "Wrightsville Beach", content: "Sunset at the beach", occurred_at: "2026-08-01 20:00:00", importance: 6 },
				{ id: 11, uuid: "e11", kind: "conversation", title: "Tax paperwork", content: "Talked about taxes", occurred_at: "2026-09-10 12:00:00", importance: 6 },
			],
		});
		llm.embed.mockResolvedValue({ vectors: [[0.9, 0.1, 0]], space: "test:space", dims: 3 });
		const r = await recallModule.recall(42, "do you remember the beach?", { now });
		expect(r.intent).toBe(true);
		expect(r.semantic).toBe(true);
		expect(r.items[0].uuid).toBe("e10");
		expect(r.items.map((i) => i.uuid)).not.toContain("e11");
	});

	test("a stated time window is a hard filter on episodes", async () => {
		fakeDb({
			embeddings: [vecRow(1, "event", 10, [1, 0]), vecRow(2, "event", 11, [1, 0])],
			events: [
				{ id: 10, uuid: "in-window", kind: "conversation", title: "Hike", content: "hike plan", occurred_at: "2026-09-09 15:00:00", importance: 5 },
				{ id: 11, uuid: "too-old", kind: "conversation", title: "Hike", content: "old hike", occurred_at: "2026-06-01 15:00:00", importance: 9 },
			],
		});
		llm.embed.mockResolvedValue({ vectors: [[1, 0]], space: "test:space", dims: 2 });
		const r = await recallModule.recall(42, "what did we say about hiking yesterday", { now, tz: "America/New_York" });
		expect(r.timeRange.label).toBe("yesterday");
		expect(r.items.map((i) => i.uuid)).toEqual(["in-window"]);
	});

	test("keyword recall still works when the embedding tier is down", async () => {
		fakeDb({
			ftFacts: [{ id: 5, kw: 4.2 }],
			facts: [{ id: 5, uuid: "f5", category: "pet", memory_key: "dog's name", memory_value: "Biscuit", confidence: 90, updated_at: "2026-01-01" }],
		});
		llm.embed.mockRejectedValue(new Error("embed endpoint down"));
		const r = await recallModule.recall(42, "what is my dog Biscuit's favorite toy", { now });
		expect(r.semantic).toBe(false);
		expect(r.items[0]).toMatchObject({ type: "fact", title: "dog's name", text: "Biscuit" });
	});

	test("recall never includes another profile's events (hydrate is profile-scoped)", async () => {
		fakeDb({ embeddings: [vecRow(1, "event", 99, [1, 0])], events: [] });
		llm.embed.mockResolvedValue({ vectors: [[1, 0]], space: "test:space", dims: 2 });
		const r = await recallModule.recall(42, "do you remember", { now, includeTranscripts: false });
		expect(r.items).toEqual([]);
		const hydrateCall = pool.query.mock.calls.find(([sql]) => sql.includes("id IN") && sql.includes("memory_event"));
		expect(hydrateCall[0]).toMatch(/profile_id = \? OR scope = 'world'/);
		expect(hydrateCall[1].slice(-1)[0]).toBe(42);
	});
});

describe("extraction safety", () => {
	const memory = require("../memory");
	const extract = require("./extract");

	const session = { id: 7, profile_id: 42, family_id: 3 };

	beforeEach(() => {
		jest.spyOn(memory, "getFactSlot").mockResolvedValue(null);
		jest.spyOn(memory, "upsertMemoryForProfile").mockResolvedValue({});
		jest.spyOn(memory, "forgetFactsByKey").mockResolvedValue(0);
		pool.query.mockResolvedValue([{ affectedRows: 1, insertId: 1 }]);
		llm.embed.mockResolvedValue({ vectors: [[1]], space: "test:space", dims: 1 });
	});
	afterEach(() => jest.restoreAllMocks());

	test("parent-curated facts are never overwritten by AI", async () => {
		memory.getFactSlot.mockResolvedValue({ source: "parent", memory_value: "Rex" });
		await extract.applyExtraction(session, { facts: [{ category: "pet", key: "dog", value: "Max", confidence: 99 }], moments: [], forget: [] }, { audience: "adult" });
		expect(memory.upsertMemoryForProfile).not.toHaveBeenCalled();
	});

	test("user-entered facts need a high-confidence restatement", async () => {
		memory.getFactSlot.mockResolvedValue({ source: "user", memory_value: "Rex" });
		await extract.applyExtraction(session, { facts: [{ category: "pet", key: "dog", value: "Max", confidence: 70 }], moments: [], forget: [] }, { audience: "adult" });
		expect(memory.upsertMemoryForProfile).not.toHaveBeenCalled();
		await extract.applyExtraction(session, { facts: [{ category: "pet", key: "dog", value: "Max", confidence: 90 }], moments: [], forget: [] }, { audience: "adult" });
		expect(memory.upsertMemoryForProfile).toHaveBeenCalledWith(42, 3, expect.objectContaining({ value: "Max", source: "ai", visibility: "private" }));
	});

	test("low-confidence guesses are dropped", async () => {
		await extract.applyExtraction(session, { facts: [{ category: "work", key: "job", value: "maybe a teacher?", confidence: 30 }], moments: [], forget: [] }, { audience: "adult" });
		expect(memory.upsertMemoryForProfile).not.toHaveBeenCalled();
	});

	test("moments become conversation events; forget requests soft-delete", async () => {
		memory.forgetFactsByKey.mockResolvedValue(1);
		const r = await extract.applyExtraction(
			session,
			{ facts: [], moments: [{ title: "Iceland trip", summary: "Planning Iceland in March", importance: 7 }], forget: ["old job"] },
			{ audience: "adult", occurredAt: "2026-09-10 12:00:00" }
		);
		expect(r).toEqual({ facts: 0, moments: 1, forgotten: 1 });
		expect(memory.forgetFactsByKey).toHaveBeenCalledWith(42, ["old job"]);
		const insert = pool.query.mock.calls.find(([sql]) => sql.includes("INTO memory_event"));
		expect(insert[1]).toEqual(expect.arrayContaining(["conversation", "Iceland trip", "Planning Iceland in March"]));
	});

	test("the child prompt forbids personal details", () => {
		const p = extract.buildPrompt({ lines: ["[person] hi"], knownFacts: [], audience: "child" });
		expect(p).toMatch(/THIS IS A CHILD/);
		expect(p).toMatch(/NEVER store: other people's names, addresses/);
	});
});

describe("news feed parser", () => {
	const { parseFeed } = require("./news");

	test("parses RSS items with CDATA and entities", () => {
		const xml = `<rss><channel><item><title><![CDATA[Storm hits &amp; floods coast]]></title>
      <link>https://ex.com/a</link><description>&lt;p&gt;Heavy rain&lt;/p&gt;</description>
      <pubDate>Wed, 09 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
		expect(parseFeed(xml)).toEqual([
			{ title: "Storm hits & floods coast", link: "https://ex.com/a", summary: "Heavy rain", published: "Wed, 09 Sep 2026 10:00:00 GMT" },
		]);
	});

	test("parses Atom entries with href links", () => {
		const xml = `<feed><entry><title>Launch day</title><link href="https://ex.com/b"/><summary>Rocket up</summary><updated>2026-09-09T10:00:00Z</updated></entry></feed>`;
		expect(parseFeed(xml)[0]).toMatchObject({ title: "Launch day", link: "https://ex.com/b", summary: "Rocket up" });
	});
});
