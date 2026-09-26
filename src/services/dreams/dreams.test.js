/**
 * Dreaming: Athena runs her own DDL in athena_mind. These tests are about the
 * walls around that, not the quality of her schema:
 *
 *   - her SQL runs on her connection, never the main pool;
 *   - she never gets the main credentials, even by misconfiguration;
 *   - a row can only be built from its own person's facts;
 *   - tables forgetting can't reach are dropped;
 *   - children's memories never enter;
 *   - the chat path reads only this person's rows, and fails silent.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("mysql2/promise", () => ({ createConnection: jest.fn() }));
jest.mock("../llm", () => ({ generateJson: jest.fn(), endpointsFor: jest.fn(() => []), image: jest.fn() }));
jest.mock("../audience", () => ({ audienceForProfile: jest.fn() }));
// The installed uuid is ESM-only in a way jest-runtime can't require(); see
// initiative.test.js.
jest.mock("uuid", () => ({ v4: () => "00000000-0000-0000-0000-000000000000" }));

const pool = require("../../helpers/db");
const mysql = require("mysql2/promise");
const llm = require("../llm");
const { audienceForProfile } = require("../audience");
const mind = require("./mind");
const { dream } = require("./dream");
const recall = require("./recall");
const questions = require("./questions");

const ADULT = 7;
const CHILD = 9;

/** A fake athena_mind connection with a scriptable schema. */
function fakeConn({ tables = [], columns = {} } = {}) {
	const state = { tables: [...tables], columns: { ...columns }, statements: [] };
	const conn = {
		state,
		beginTransaction: jest.fn(async () => undefined),
		commit: jest.fn(async () => undefined),
		rollback: jest.fn(async () => undefined),
		end: jest.fn(async () => undefined),
		query: jest.fn(async (sql) => {
			state.statements.push(sql);
			if (/information_schema\.TABLES/.test(sql) && /TABLE_TYPE/.test(sql)) {
				return [state.tables.map((t) => ({ name: t.name, type: t.view ? "VIEW" : "BASE TABLE" }))];
			}
			if (/information_schema\.COLUMNS/.test(sql)) {
				return [
					Object.entries(state.columns).flatMap(([t, cols]) => cols.map((c) => ({ t, c, type: "text", k: "" }))),
				];
			}
			if (/^SELECT COUNT\(\*\) AS n/.test(sql)) return [[{ n: 0 }]];
			if (/^SELECT _sources/.test(sql)) return [[]];
			if (/^DROP TABLE `(\w+)`/.test(sql)) {
				const name = sql.match(/^DROP TABLE `(\w+)`/)[1];
				state.tables = state.tables.filter((t) => t.name !== name);
				delete state.columns[name];
				return [{}];
			}
			if (/^CREATE TABLE people/.test(sql)) {
				state.tables.push({ name: "people" });
				state.columns.people = ["id", "name", "_profile_id", "_sources"];
				return [{ affectedRows: 0 }];
			}
			if (/^SELECT object_name/.test(sql)) return [[]];
			if (/^INSERT INTO `people`/.test(sql)) return [{ affectedRows: 1 }];
			return [{ affectedRows: 0 }];
		}),
	};
	return conn;
}

function mainDb({ facts = [], pendingQuestions = 0 } = {}) {
	pool.query.mockImplementation(async (sql, params) => {
		if (sql.includes("INSERT INTO athena_dream (")) return [{ insertId: 1 }];
		if (sql.includes("INSERT INTO athena_dream_question")) return [{ insertId: 5 }];
		if (sql.includes("SELECT DISTINCT profile_id FROM user_memory")) return [[{ profile_id: ADULT }, { profile_id: CHILD }]];
		if (sql.includes("FROM user_memory") && sql.includes("profile_id IN")) {
			return [facts.filter((f) => params[0].includes(f.profile_id))];
		}
		if (sql.includes("FROM profile WHERE id IN")) return [[{ id: ADULT, full_name: "Ross Bryson" }]];
		if (sql.includes("COUNT(*) AS n FROM athena_dream_question")) return [[{ n: pendingQuestions }]];
		return [[], {}];
	});
}

const FACTS = [
	{ id: 1, profile_id: ADULT, category: "person", memory_key: "sister", memory_value: "Emma — moved to Denver", updated_at: new Date() },
	{ id: 2, profile_id: CHILD, category: "person", memory_key: "friend", memory_value: "a classmate", updated_at: new Date() },
];

beforeEach(() => {
	jest.clearAllMocks();
	process.env.DB_USER = "owner";
	process.env.ATHENA_MIND_DB_USER = "athena_mind";
	process.env.ATHENA_MIND_DB_PASS = "x".repeat(20);
	audienceForProfile.mockImplementation(async (id) => (Number(id) === ADULT ? "adult" : "child"));
	pool.query.mockResolvedValue([[], {}]);
	recall._reset();
	llm.endpointsFor.mockReturnValue([]);
	llm.image.mockRejectedValue(new Error("no image model in tests"));
	jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------
// Her connection
// ---------------------------------------------------------------------------

describe("connect", () => {
	test("refuses to run without her own credentials", async () => {
		delete process.env.ATHENA_MIND_DB_PASS;
		await expect(mind.connect()).rejects.toThrow(/not set/);
		expect(mysql.createConnection).not.toHaveBeenCalled();
	});

	test("refuses the main database user even if someone configures it", async () => {
		process.env.ATHENA_MIND_DB_USER = "owner";
		await expect(mind.connect()).rejects.toThrow(/never the main one/);
		expect(mysql.createConnection).not.toHaveBeenCalled();
	});

	test("connects to athena_mind with multiple statements off", async () => {
		mysql.createConnection.mockResolvedValue(fakeConn());
		await mind.connect();
		expect(mysql.createConnection).toHaveBeenCalledWith(
			expect.objectContaining({ user: "athena_mind", database: "athena_mind", multipleStatements: false })
		);
	});
});

// ---------------------------------------------------------------------------
// Rows and sources
// ---------------------------------------------------------------------------

describe("rowProblem", () => {
	const owners = { factOwner: new Map([[1, ADULT], [2, 8]]), clarificationOwner: new Map([[3, ADULT]]) };

	test("a row built from its own person's facts and answers is fine", () => {
		expect(mind.rowProblem({ _profile_id: ADULT, _sources: ["f:1", "q:3"] }, owners)).toBeNull();
	});

	test("a row may not borrow someone else's fact", () => {
		expect(mind.rowProblem({ _profile_id: ADULT, _sources: ["f:1", "f:2"] }, owners)).toMatch(/someone else/);
	});

	test("no sources, unknown sources and malformed sources are all refused", () => {
		expect(mind.rowProblem({ _profile_id: ADULT, _sources: [] }, owners)).toMatch(/no _sources/);
		expect(mind.rowProblem({ _profile_id: ADULT, _sources: ["f:999"] }, owners)).toMatch(/unknown/);
		expect(mind.rowProblem({ _profile_id: ADULT, _sources: ["f:1; DROP"] }, owners)).toMatch(/bad source/);
		expect(mind.rowProblem({ _sources: ["f:1"] }, owners)).toMatch(/_profile_id/);
	});
});

describe("upsertRows", () => {
	const owners = { factOwner: new Map([[1, ADULT]]), clarificationOwner: new Map() };

	test("inserts accepted rows as parameters and reports the rejected ones", async () => {
		const conn = fakeConn();
		const out = await mind.upsertRows(
			conn,
			"people",
			[
				{ _profile_id: ADULT, _sources: ["f:1"], name: "Emma" },
				{ _profile_id: ADULT, _sources: ["f:2"], name: "Stranger" },
			],
			owners
		);
		expect(out.inserted).toBe(1);
		expect(out.rejected).toHaveLength(1);
		const [sql, [values]] = conn.query.mock.calls.find((c) => c[0].startsWith("INSERT INTO `people`"));
		expect(sql).not.toContain("Emma");
		expect(values).toEqual([[ADULT, JSON.stringify(["f:1"]), "Emma"]]);
	});

	test("never writes the code's own tables", async () => {
		await expect(mind.upsertRows(fakeConn(), "_fact", [{}], owners)).rejects.toThrow(/bad table/);
	});
});

describe("runStatement", () => {
	test("one statement per step", async () => {
		await expect(mind.runStatement(fakeConn(), "DROP TABLE a; DROP TABLE b")).rejects.toThrow(/one statement/);
	});
});

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

describe("guard", () => {
	test("drops tables forgetting can't reach and _ tables the code didn't make", async () => {
		const conn = fakeConn({
			tables: [{ name: "_fact" }, { name: "_sneaky" }, { name: "people" }, { name: "notes" }, { name: "people_view", view: true }],
			columns: {
				_fact: ["fact_id"],
				_sneaky: ["x"],
				people: ["name", "_profile_id", "_sources"],
				notes: ["text", "_profile_id"],
				people_view: ["name"],
			},
		});
		const dropped = (await mind.guard(conn)).map((a) => a.statement);
		expect(dropped).toEqual(["DROP TABLE `_sneaky`", "DROP TABLE `notes`"]);
	});
});

// ---------------------------------------------------------------------------
// A night
// ---------------------------------------------------------------------------

describe("dream", () => {
	test("is recorded as skipped, not run, without her credentials", async () => {
		delete process.env.ATHENA_MIND_DB_USER;
		mainDb();
		const out = await dream();
		expect(out.status).toBe("skipped");
		expect(mysql.createConnection).not.toHaveBeenCalled();
		expect(llm.generateJson).not.toHaveBeenCalled();
	});

	test("runs her SQL on her connection only, adults only, and logs every step", async () => {
		const conn = fakeConn();
		mysql.createConnection.mockResolvedValue(conn);
		mainDb({ facts: FACTS });
		// Round 2 (the round a failure earns her) finishes cleanly.
		llm.generateJson.mockResolvedValue({ endpointId: "test", tier: "frontier", data: { done: true, summary: "Fixed.", steps: [] } });
		llm.generateJson.mockResolvedValueOnce({
			endpointId: "test",
			tier: "frontier",
			data: {
				thinking: "people first",
				done: true,
				summary: "I made a people table.",
				steps: [
					{ op: "sql", why: "people", statement: "CREATE TABLE people (id INT PRIMARY KEY, name TEXT, _profile_id BIGINT NOT NULL, _sources JSON NOT NULL)" },
					{ op: "upsert", why: "fill", table: "people", rows_json: JSON.stringify([{ _profile_id: ADULT, _sources: ["f:1"], name: "Emma" }]) },
					{ op: "question", why: "child", profile_id: CHILD, question: "Who is your friend?" },
					{ op: "question", why: "unclear", profile_id: ADULT, question: "Is the Emma in Denver your sister?", about: ["f:1"] },
				],
			},
		});

		const out = await dream({ rounds: 3 });
		expect(out.status).toBe("partial"); // the child question failed
		// "done" didn't end the night while a step had failed: she got round 2.
		expect(out.stats.rounds).toBe(2);

		// The child's fact never reached the mirror or the prompt.
		const mirrored = conn.query.mock.calls.find((c) => String(c[0]).startsWith("INSERT INTO _fact"));
		expect(mirrored[1][0].map((r) => r[1])).toEqual([ADULT]);
		expect(llm.generateJson.mock.calls[0][0].contents).not.toContain("classmate");

		// Her DDL ran on her connection and never on the main pool.
		expect(conn.state.statements.some((s) => s.startsWith("CREATE TABLE people"))).toBe(true);
		expect(pool.query.mock.calls.some((c) => String(c[0]).includes("CREATE TABLE people"))).toBe(false);

		// Exactly one question queued, for the adult.
		const asked = pool.query.mock.calls.filter((c) => c[0].includes("INSERT INTO athena_dream_question"));
		expect(asked).toHaveLength(1);
		expect(asked[0][1][1]).toBe(ADULT);

		// Every step is in the log, including the refused one.
		const steps = pool.query.mock.calls.filter((c) => c[0].includes("INSERT INTO athena_dream_step"));
		const kinds = steps.map((c) => c[1][3]);
		expect(kinds).toEqual(expect.arrayContaining(["mirror", "note", "sql", "upsert", "question"]));
		expect(steps.some((c) => c[1][3] === "question" && c[1][6] === 0)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Daytime
// ---------------------------------------------------------------------------

describe("recall.promptBlock", () => {
	function chatDb({ catalogThrows = false, rows = [], pending = [] } = {}) {
		pool.query.mockImplementation(async (sql) => {
			if (sql.includes("`_catalog`")) {
				if (catalogThrows) throw new Error("Unknown database 'athena_mind'");
				return [
					[
						{ object_name: "people", description: "people you've told me about", label_column: "name", triggers: '["people"]' },
						{ object_name: "leaky", description: "no owner column", label_column: null, triggers: '["people"]' },
					],
				];
			}
			if (sql.includes("information_schema.COLUMNS")) {
				return [[{ t: "people", c: "name" }, { t: "people", c: "_profile_id" }, { t: "leaky", c: "name" }]];
			}
			if (sql.includes("FROM athena_dream_question")) return [pending];
			if (sql.includes("FROM `athena_mind`.`people`")) return [rows];
			return [[], {}];
		});
	}

	test("reads only this person's rows, and never a table without _profile_id", async () => {
		chatDb({ rows: [{ name: "Emma", city: "Denver", _profile_id: ADULT, _sources: '["f:1"]' }] });
		const block = await recall.promptBlock(ADULT, "list the people you know", { sessionId: 3 });
		expect(block).toContain("name: Emma; city: Denver");
		expect(block).not.toContain("f:1");
		const reads = pool.query.mock.calls.filter((c) => c[0].includes("`athena_mind`.`"));
		expect(reads.length).toBeGreaterThan(0);
		for (const [sql, params] of reads) {
			if (sql.includes("_catalog")) continue;
			expect(sql).toContain("_profile_id = ?");
			expect(params[0]).toBe(ADULT);
			expect(sql).not.toContain("leaky");
		}
	});

	test("is silent, not broken, before athena_mind exists", async () => {
		chatDb({ catalogThrows: true });
		expect(await recall.promptBlock(ADULT, "list the people you know")).toBeNull();
	});

	test("carries waiting questions and marks them offered in this session", async () => {
		chatDb({ catalogThrows: true, pending: [{ id: 11, question: "Is the Emma in Denver your sister?" }] });
		const block = await recall.promptBlock(ADULT, "hi", { sessionId: 3 });
		expect(block).toContain("Is the Emma in Denver your sister?");
		expect(block).toContain("Can I ask you something?");
		const mark = pool.query.mock.calls.find((c) => c[0].includes("SET offered_at"));
		expect(mark[1]).toEqual([3, 3, [11]]);
	});
});

describe("questions", () => {
	test("won't pile up past the per-person cap", async () => {
		mainDb({ pendingQuestions: 10 });
		await expect(questions.create({ profileId: ADULT, question: "One more?" })).rejects.toThrow(/already 10/);
	});
});

describe("dream_question trigger", () => {
	const triggers = require("../initiative/triggers");
	const trigger = triggers.get("dream_question");

	test("says nothing when nothing is waiting", async () => {
		pool.query.mockResolvedValue([[]]);
		expect(await trigger.evaluate(ADULT)).toBeNull();
	});

	test("one nudge per night, carrying everything still waiting", async () => {
		pool.query.mockResolvedValue([
			[
				{ id: 1, dream_id: 4, question: "Older?" },
				{ id: 2, dream_id: 5, question: "Is the Emma in Denver your sister?" },
			],
		]);
		const hit = await trigger.evaluate(ADULT);
		expect(hit.dedupeKey).toBe("dream:5");
		expect(hit.facts).toEqual({ count: 2, first: "Is the Emma in Denver your sister?" });
		expect(trigger.brief(hit.facts)).toMatch(/Can I ask you something/);
	});
});

// ---------------------------------------------------------------------------
// The dream as a story, and what leaves the log
// ---------------------------------------------------------------------------

describe("narrative", () => {
	test("is told from the redacted log — the facts' values never reach it — and stored", async () => {
		mysql.createConnection.mockResolvedValue(fakeConn());
		mainDb({ facts: FACTS });
		llm.generateJson
			.mockResolvedValueOnce({
				endpointId: "test",
				tier: "frontier",
				data: {
					done: true,
					summary: "I made a people table.",
					steps: [
						{ op: "sql", why: "people", statement: "CREATE TABLE people (id INT PRIMARY KEY, name TEXT, _profile_id BIGINT NOT NULL, _sources JSON NOT NULL)" },
						{ op: "upsert", why: "fill", table: "people", rows_json: JSON.stringify([{ _profile_id: ADULT, _sources: ["f:1"], name: "Emma" }]) },
						{ op: "sql", why: "look", statement: "SELECT * FROM people WHERE name = 'Emma'" },
						{ op: "question", why: "unclear", profile_id: ADULT, question: "Is the Emma in Denver your sister?" },
					],
				},
			})
			.mockResolvedValueOnce({ data: { narrative: "I built a room called `people` and carried one drawer in, then woke." } });

		await dream({ rounds: 1 });

		const story = llm.generateJson.mock.calls[1][0].contents;
		expect(story).toContain("Tell last night as a DREAM");
		expect(story).toContain("CREATE TABLE people");
		expect(story).toContain("UPSERT people — 1 row");
		expect(story).not.toMatch(/Emma|Denver/);

		const close = pool.query.mock.calls.find((c) => c[0].startsWith("UPDATE athena_dream SET"));
		expect(close[1][2]).toMatch(/room called `people`/);
	});

	test("a night no model can narrate still closes, with no narrative", async () => {
		mysql.createConnection.mockResolvedValue(fakeConn());
		mainDb({ facts: FACTS });
		llm.generateJson
			.mockResolvedValueOnce({ endpointId: "t", tier: "f", data: { done: true, summary: "Quiet.", steps: [] } })
			.mockRejectedValueOnce(new Error("no model"));
		const out = await dream({ rounds: 1 });
		expect(out.status).toBe("ok");
		const close = pool.query.mock.calls.find((c) => c[0].startsWith("UPDATE athena_dream SET"));
		expect(close[1][2]).toBeNull();
	});
});

describe("redactStep", () => {
	const { redactStep, redactSql } = require("./redact");

	test("string literals go, identifiers stay", () => {
		expect(redactSql("INSERT INTO `people` (name) VALUES ('Emma'), (\"O'Neil\")")).toBe("INSERT INTO `people` (name) VALUES ('…'), ('…')");
	});

	test("upserts become a shape, questions are only shown to their person", () => {
		expect(redactStep({ kind: "upsert", statement: 'UPSERT people [{"_profile_id":7,"name":"Emma"}]' }).statement).toBe(
			"UPSERT people — 1 row (_profile_id, name)"
		);
		const ask = { kind: "question", statement: "ASK p7: Is Emma your sister?" };
		expect(redactStep(ask, { viewerProfileId: 7 }).statement).toBe("ASK you: Is Emma your sister?");
		expect(redactStep(ask, { viewerProfileId: 8 }).statement).toBe("ASK someone a question");
		expect(redactStep({ kind: "answer", statement: "ANSWER question 3 (answered): yes, same Emma" }).statement).toBe(
			"ANSWER question 3 (answered)"
		);
	});
});

// ---------------------------------------------------------------------------
// ChatGPT, the fallback, and the picture
// ---------------------------------------------------------------------------

describe("which model dreams", () => {
	const ROUND = { endpointId: "openai", tier: "frontier", model: "gpt-5.5", data: { done: true, summary: "Quiet.", steps: [] } };

	test("ChatGPT (task dream) when an endpoint declares a dream model", async () => {
		mysql.createConnection.mockResolvedValue(fakeConn());
		mainDb({ facts: FACTS });
		llm.endpointsFor.mockReturnValue([{ id: "openai" }]);
		llm.generateJson.mockResolvedValueOnce(ROUND).mockResolvedValueOnce({ data: { narrative: "A quiet night of tidy drawers, and then morning came." } });
		await dream({ rounds: 1 });
		expect(llm.generateJson.mock.calls.map((c) => c[0].task)).toEqual(["dream", "dream"]);
	});

	test("falls back to the review chain when ChatGPT fails, and says so in the log", async () => {
		mysql.createConnection.mockResolvedValue(fakeConn());
		mainDb({ facts: FACTS });
		llm.endpointsFor.mockReturnValue([{ id: "openai" }]);
		llm.generateJson
			.mockRejectedValueOnce(new Error("HTTP 429 no credits"))
			.mockResolvedValueOnce({ ...ROUND, endpointId: "gemini", model: "gemini-3.5-flash-lite" })
			.mockResolvedValue({ data: { narrative: null } });
		const out = await dream({ rounds: 1 });
		expect(out.status).toBe("ok");
		expect(llm.generateJson.mock.calls.slice(0, 2).map((c) => c[0].task)).toEqual(["dream", "review"]);
		const note = pool.query.mock.calls.find((c) => c[0].includes("INSERT INTO athena_dream_step") && String(c[1][5]).includes("stood in"));
		expect(note[1][5]).toMatch(/gemini stood in: HTTP 429/);
	});

	test("paints the narrative into the bucket and records the path", async () => {
		const saved = [];
		require("./image")._setStorage({ bucket: (b) => ({ file: (name) => ({ save: async (buf, opts) => saved.push({ b, name, bytes: buf.length, opts }) }) }) });
		mysql.createConnection.mockResolvedValue(fakeConn());
		mainDb({ facts: FACTS });
		llm.generateJson.mockResolvedValueOnce(ROUND).mockResolvedValueOnce({ data: { narrative: "I built a room called `people` and woke to morning light." } });
		llm.image.mockResolvedValue({ images: [{ b64: Buffer.from("png").toString("base64"), mimeType: "image/png" }], model: "gpt-image-2" });

		await dream({ rounds: 1 });

		// Painted from the narrative only.
		expect(llm.image.mock.calls[0][0]).toContain("room called `people`");
		expect(llm.image.mock.calls[0][0]).not.toMatch(/Emma|Denver/);
		expect(saved[0]).toMatchObject({ b: "athena-dreams", bytes: 3 });
		expect(saved[0].name).toMatch(/^dreams\/\d{4}-\d{2}-\d{2}-.+\.png$/);
		const close = pool.query.mock.calls.find((c) => c[0].startsWith("UPDATE athena_dream SET"));
		expect(close[1][3]).toMatch(/^gs:\/\/athena-dreams\/dreams\//);
		expect(close[1][4]).toBe("gpt-image-2");
	});

	test("a picture that fails costs the picture, not the night", async () => {
		mysql.createConnection.mockResolvedValue(fakeConn());
		mainDb({ facts: FACTS });
		llm.generateJson.mockResolvedValueOnce(ROUND).mockResolvedValueOnce({ data: { narrative: "A small dream of sweeping a porch, and then I woke." } });
		const out = await dream({ rounds: 1 });
		expect(out.status).toBe("ok");
		const close = pool.query.mock.calls.find((c) => c[0].startsWith("UPDATE athena_dream SET"));
		expect(close[1][2]).toMatch(/porch/);
		expect(close[1][3]).toBeNull();
	});
});
