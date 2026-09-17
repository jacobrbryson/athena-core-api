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

	test("re-stated known facts don't crowd out new ones", async () => {
		// The prompt lists what Athena already knows, and the model dutifully
		// re-states all of it before getting to anything new. Those duplicates
		// must not consume the per-extraction write budget.
		const known = Array.from({ length: 8 }, (_, i) => ({ category: "family", key: `known-${i}`, value: `same-${i}`, confidence: 100 }));
		const fresh = [
			{ category: "family", key: "spouse", value: "Ashlynn, a Physical Therapist", confidence: 100 },
			{ category: "goal", key: "long-term vision", value: "Athena as the kids' Overwatch", confidence: 100 },
		];
		memory.getFactSlot.mockImplementation(async (_p, _c, key) =>
			key.startsWith("known-") ? { source: "ai", memory_value: `same-${key.slice(6)}` } : null
		);

		const r = await extract.applyExtraction(session, { facts: [...known, ...fresh], moments: [], forget: [] }, { audience: "adult" });

		expect(r.facts).toBe(2);
		expect(memory.upsertMemoryForProfile.mock.calls.map(([, , f]) => f.key)).toEqual(["spouse", "long-term vision"]);
	});

	test("at most 8 facts are written per extraction", async () => {
		const facts = Array.from({ length: 12 }, (_, i) => ({ category: "family", key: `new-${i}`, value: `v${i}`, confidence: 90 }));
		const r = await extract.applyExtraction(session, { facts, moments: [], forget: [] }, { audience: "adult" });
		expect(r.facts).toBe(8);
		expect(memory.upsertMemoryForProfile).toHaveBeenCalledTimes(8);
	});

	test("an unchanged value is not rewritten", async () => {
		memory.getFactSlot.mockResolvedValue({ source: "ai", memory_value: "Biscuit" });
		const r = await extract.applyExtraction(session, { facts: [{ category: "pet", key: "dog", value: "Biscuit", confidence: 100 }], moments: [], forget: [] }, { audience: "adult" });
		expect(r.facts).toBe(0);
		expect(memory.upsertMemoryForProfile).not.toHaveBeenCalled();
	});

	test("a soft-deleted slot is refilled rather than treated as curated", async () => {
		memory.getFactSlot.mockResolvedValue({ source: "parent", memory_value: "Rex", deleted_at: "2026-09-01 00:00:00" });
		await extract.applyExtraction(session, { facts: [{ category: "pet", key: "dog", value: "Max", confidence: 90 }], moments: [], forget: [] }, { audience: "adult" });
		expect(memory.upsertMemoryForProfile).toHaveBeenCalledWith(42, 3, expect.objectContaining({ value: "Max" }));
	});

	test.each([
		["no key", { category: "pet", value: "Max", confidence: 90 }],
		["blank key", { category: "pet", key: "   ", value: "Max", confidence: 90 }],
		["non-string value", { category: "pet", key: "dog", value: { name: "Max" }, confidence: 90 }],
		["null entry", null],
	])("malformed fact (%s) is skipped, not thrown on", async (_label, bad) => {
		const r = await extract.applyExtraction(session, { facts: [bad], moments: [], forget: [] }, { audience: "adult" });
		expect(r.facts).toBe(0);
		expect(memory.upsertMemoryForProfile).not.toHaveBeenCalled();
	});

	test("confidence exactly at the threshold is kept", async () => {
		await extract.applyExtraction(session, { facts: [{ category: "work", key: "job", value: "teacher", confidence: 50 }], moments: [], forget: [] }, { audience: "adult" });
		expect(memory.upsertMemoryForProfile).toHaveBeenCalledWith(42, 3, expect.objectContaining({ confidence: 50 }));
	});

	test("at most 2 moments per extraction, blank summaries dropped", async () => {
		const r = await extract.applyExtraction(
			session,
			{
				facts: [],
				moments: [
					{ title: "a", summary: "first", importance: 5 },
					{ title: "b", summary: "second", importance: 5 },
					{ title: "c", summary: "third", importance: 9 },
				],
				forget: [],
			},
			{ audience: "adult", occurredAt: "2026-09-10 12:00:00" }
		);
		expect(r.moments).toBe(2);

		const blank = await extract.applyExtraction(session, { facts: [], moments: [{ title: "d", summary: "   ", importance: 5 }], forget: [] }, { audience: "adult" });
		expect(blank.moments).toBe(0);
	});

	test("missing arrays are treated as empty, not crashes", async () => {
		const r = await extract.applyExtraction(session, {}, { audience: "adult" });
		expect(r).toEqual({ facts: 0, moments: 0, forgotten: 0 });
	});

	test("the child prompt forbids personal details", () => {
		const p = extract.buildPrompt({ lines: ["[person] hi"], knownFacts: [], audience: "child" });
		expect(p).toMatch(/THIS IS A CHILD/);
		expect(p).toMatch(/NEVER store: other people's names, addresses/);
	});
});

describe("extraction sweep and cursor", () => {
	const memory = require("../memory");
	const messageService = require("../message");
	const extract = require("./extract");

	const CURSOR_SELECT = /SELECT last_created_at FROM memory_extraction_cursor/;
	const CURSOR_WRITE = /INTO memory_extraction_cursor/;
	const PENDING_SELECT = /FROM session s/;

	const msg = (text, isHuman, createdAt) => ({ uuid: `m-${text}`, text, is_human: isHuman ? 1 : 0, created_at: createdAt });
	const emptyExtraction = { facts: [], moments: [], forget: [] };

	/** Route pool.query by statement; `pending` seeds the nightly session list. */
	function fakeDb({ cursor = null, pending = [] } = {}) {
		pool.query.mockImplementation(async (sql) => {
			if (CURSOR_SELECT.test(sql)) return [cursor ? [{ last_created_at: cursor }] : []];
			if (PENDING_SELECT.test(sql)) return [pending];
			return [{ affectedRows: 1, insertId: 1 }];
		});
	}
	const cursorWrites = () => pool.query.mock.calls.filter(([sql]) => CURSOR_WRITE.test(sql));

	beforeEach(() => {
		jest.spyOn(memory, "getFactSlot").mockResolvedValue(null);
		jest.spyOn(memory, "upsertMemoryForProfile").mockResolvedValue({});
		jest.spyOn(memory, "forgetFactsByKey").mockResolvedValue(0);
		jest.spyOn(memory, "getMemorySummaryForProfileId").mockResolvedValue([]);
		jest.spyOn(messageService, "getMessagesSince").mockResolvedValue([]);
		llm.embed.mockResolvedValue({ vectors: [[1]], space: "test:space", dims: 1 });
		llm.generateJson.mockResolvedValue({ data: emptyExtraction, endpointId: "test", tier: "frontier" });
	});
	afterEach(() => jest.restoreAllMocks());

	test("the cursor advances to the newest processed message", async () => {
		fakeDb();
		messageService.getMessagesSince.mockResolvedValue([
			msg("hi", true, "2026-09-16 10:00:00"),
			msg("hello", false, "2026-09-16 10:00:05"),
		]);
		await extract.extractSession({ id: 7, profile_id: 42 }, { audience: "adult" });
		expect(cursorWrites()).toHaveLength(1);
		expect(cursorWrites()[0][1]).toEqual([7, "2026-09-16 10:00:05"]);
	});

	test("a failed extraction leaves the cursor alone so the messages are retried", async () => {
		fakeDb();
		messageService.getMessagesSince.mockResolvedValue([msg("remember my sister moved", true, "2026-09-16 10:00:00")]);
		llm.generateJson.mockRejectedValue(new Error("no endpoint could serve extract"));

		await expect(extract.extractSession({ id: 7, profile_id: 42 }, { audience: "adult" })).rejects.toThrow(/no endpoint/);
		expect(cursorWrites()).toHaveLength(0);
	});

	test("only messages newer than the cursor are sent to the model", async () => {
		fakeDb({ cursor: "2026-09-16 09:00:00" });
		messageService.getMessagesSince.mockResolvedValue([msg("new thing", true, "2026-09-16 10:00:00")]);
		await extract.extractSession({ id: 7, profile_id: 42 }, { audience: "adult" });
		expect(messageService.getMessagesSince).toHaveBeenCalledWith(7, "2026-09-16 09:00:00", 40);
		expect(llm.generateJson.mock.calls[0][0].contents).toContain("new thing");
	});

	test("a window with no human messages costs nothing", async () => {
		fakeDb();
		messageService.getMessagesSince.mockResolvedValue([msg("just me talking", false, "2026-09-16 10:00:00")]);
		const r = await extract.extractSession({ id: 7, profile_id: 42 }, { audience: "adult" });
		expect(r).toEqual({ facts: 0, moments: 0, forgotten: 0 });
		expect(llm.generateJson).not.toHaveBeenCalled();
		expect(cursorWrites()).toHaveLength(0);
	});

	test("the nightly sweep skips profiles with memory turned off", async () => {
		fakeDb({ pending: [{ id: 7, profile_id: 42, family_id: 3 }] });
		messageService.getMessagesSince.mockResolvedValue([msg("hi", true, "2026-09-16 10:00:00")]);
		const audienceFor = Object.assign(async () => "adult", { memoryEnabled: async () => false });

		const totals = await extract.extractPendingSessions({ audienceFor });

		expect(totals.sessions).toBe(0);
		expect(llm.generateJson).not.toHaveBeenCalled();
	});

	test("one broken session doesn't abort the sweep", async () => {
		fakeDb({
			pending: [
				{ id: 7, profile_id: 42, family_id: 3 },
				{ id: 8, profile_id: 43, family_id: 3 },
			],
		});
		messageService.getMessagesSince.mockResolvedValue([msg("hi", true, "2026-09-16 10:00:00")]);
		llm.generateJson
			.mockRejectedValueOnce(new Error("model down"))
			.mockResolvedValueOnce({
				data: { facts: [{ category: "pet", key: "dog", value: "Biscuit", confidence: 90 }], moments: [], forget: [] },
				endpointId: "test",
				tier: "frontier",
			});
		jest.spyOn(console, "warn").mockImplementation(() => {});

		const totals = await extract.extractPendingSessions({ audienceFor: async () => "adult" });

		expect(totals).toMatchObject({ sessions: 1, facts: 1, failed: 1 });
	});

	test("sweep totals add up across sessions", async () => {
		fakeDb({
			pending: [
				{ id: 7, profile_id: 42, family_id: 3 },
				{ id: 8, profile_id: 43, family_id: 3 },
			],
		});
		messageService.getMessagesSince.mockResolvedValue([msg("hi", true, "2026-09-16 10:00:00")]);
		memory.forgetFactsByKey.mockResolvedValue(1);
		llm.generateJson.mockResolvedValue({
			data: {
				facts: [{ category: "pet", key: "dog", value: "Biscuit", confidence: 90 }],
				moments: [{ title: "t", summary: "s", importance: 5 }],
				forget: ["old job"],
			},
			endpointId: "test",
			tier: "frontier",
		});

		const totals = await extract.extractPendingSessions({ audienceFor: async () => "adult" });

		expect(totals).toEqual({ sessions: 2, facts: 2, moments: 2, forgotten: 2, failed: 0 });
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
