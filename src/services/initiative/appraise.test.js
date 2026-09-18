/**
 * Learning which interruptions were wanted.
 *
 * The tests that matter most are the ones about direction. A learning loop
 * that can make Athena quieter is a feature; one that can make her louder, or
 * that can talk itself back into something a person switched off, is a way to
 * lose someone's trust automatically and at scale.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../llm", () => ({ generateJson: jest.fn() }));
// The registry is only consulted to validate a trigger id, and requiring the
// real one drags in the whole connector chain (calendar -> oauth -> secrets).
jest.mock("./triggers", () => ({
	get: (id) => (["calendar_next_up", "calendar_conflict", "recovery_vs_day"].includes(id) ? { id } : null),
}));

const pool = require("../../helpers/db");
const llm = require("../llm");
const appraise = require("./appraise");

const PROFILE = 42;
const TRIGGER = "calendar_next_up";

/** Existing score row, or none at all. */
function db({ score = null, insertRows = [] } = {}) {
	pool.query.mockImplementation(async (sql) => {
		if (sql.includes("FROM athena_trigger_score") && sql.includes("trigger_id = ?")) {
			return [score ? [score] : []];
		}
		if (sql.includes("FROM athena_trigger_score")) return [score ? [score] : []];
		if (sql.includes("FROM athena_nudge")) return [insertRows];
		return [[], { affectedRows: 1 }];
	});
}

/** The score written by the last applyOutcome call. */
function written() {
	const call = pool.query.mock.calls.find((c) =>
		c[0].includes("INSERT INTO athena_trigger_score")
	);
	if (!call) return null;
	return { sql: call[0], score: Number(call[1][2]), samples: Number(call[1][3]) };
}

beforeEach(() => {
	jest.clearAllMocks();
	pool.query.mockResolvedValue([[], {}]);
	jest.spyOn(console, "warn").mockImplementation(() => {});
	jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------
// Direction
// ---------------------------------------------------------------------------

describe("which way the score moves", () => {
	test("a welcomed nudge raises it, a rejection drops it", async () => {
		db();
		await appraise.applyOutcome(PROFILE, TRIGGER, "welcomed");
		const up = written().score;
		jest.clearAllMocks();
		db();
		await appraise.applyOutcome(PROFILE, TRIGGER, "rejected");
		const down = written().score;
		expect(up).toBeGreaterThan(0.5);
		expect(down).toBeLessThan(0.5);
	});

	test("being disliked moves her further than being liked", async () => {
		// Deliberate asymmetry: a welcome nudge is pleasant, an unwanted one
		// costs trust, and she should learn at the speed of the damage.
		db();
		await appraise.applyOutcome(PROFILE, TRIGGER, "welcomed");
		const up = Math.abs(written().score - 0.5);
		jest.clearAllMocks();
		db();
		await appraise.applyOutcome(PROFILE, TRIGGER, "unhelpful");
		const down = Math.abs(written().score - 0.5);
		expect(down).toBeGreaterThan(up * 0.5);
	});

	test("being ignored is the weakest evidence there is", async () => {
		db();
		await appraise.applyOutcome(PROFILE, TRIGGER, "ignored");
		const ignored = Math.abs(written().score - 0.5);
		jest.clearAllMocks();
		db();
		await appraise.applyOutcome(PROFILE, TRIGGER, "dismissed");
		const dismissed = Math.abs(written().score - 0.5);
		// People are busy. One unread notification is not a verdict.
		expect(ignored).toBeLessThan(dismissed);
	});

	test("the score is bounded to [0,1] however many bad outcomes land", async () => {
		db({ score: { score: 0.02, samples: 40, suppressed_at: null } });
		await appraise.applyOutcome(PROFILE, TRIGGER, "rejected");
		expect(written().score).toBeGreaterThanOrEqual(0);
		expect(written().score).toBeLessThanOrEqual(1);
	});

	test("an unknown outcome moves nothing", async () => {
		db();
		expect(await appraise.applyOutcome(PROFILE, TRIGGER, "delighted")).toBeNull();
		expect(written()).toBeNull();
	});

	test("an unknown trigger moves nothing", async () => {
		db();
		expect(await appraise.applyOutcome(PROFILE, "made_up", "welcomed")).toBeNull();
		expect(written()).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

describe("going quiet", () => {
	test("a rejection suppresses immediately, without waiting for an average", async () => {
		// "Stop sending me this" must take effect on the spot. The second
		// unwanted nudge after you asked her to stop is the one that loses you
		// the person.
		db();
		const out = await appraise.applyOutcome(PROFILE, TRIGGER, "rejected", {
			reason: "asked her to stop",
		});
		expect(out.suppressed).toBe(true);
		expect(written().sql).toContain("NOW()");
	});

	test("a low score alone does not suppress until there is enough evidence", async () => {
		db({ score: { score: 0.2, samples: 1, suppressed_at: null } });
		const out = await appraise.applyOutcome(PROFILE, TRIGGER, "dismissed");
		expect(out.suppressed).toBe(false);
	});

	test("a low score with enough evidence does suppress", async () => {
		db({ score: { score: 0.2, samples: 10, suppressed_at: null } });
		const out = await appraise.applyOutcome(PROFILE, TRIGGER, "dismissed");
		expect(out.suppressed).toBe(true);
	});

	test("a good run never un-suppresses on its own", async () => {
		// She backed off because someone did not want it. Deciding on their
		// behalf that they have changed their mind is the behaviour that makes
		// people stop trusting a system like this.
		db({ score: { score: 0.2, samples: 10, suppressed_at: new Date() } });
		await appraise.applyOutcome(PROFILE, TRIGGER, "welcomed");
		expect(written().sql).toContain("suppressed_at = suppressed_at");
	});

	test("only the person can bring it back", async () => {
		db();
		await appraise.resume(PROFILE, TRIGGER);
		const call = pool.query.mock.calls.find((c) => c[0].includes("athena_trigger_score"));
		expect(call[0]).toContain("suppressed_at = NULL");
		// And it comes back at neutral, not at whatever it sank to.
		expect(call[0]).toContain("GREATEST(score, 0.500)");
	});
});

// ---------------------------------------------------------------------------
// Reading a reply
// ---------------------------------------------------------------------------

describe("judging a reply", () => {
	test("a refusal is read as a rejection and acted on", async () => {
		db();
		llm.generateJson.mockResolvedValue({
			data: { reading: "rejected", why: "asked her to stop sending these" },
		});
		const out = await appraise.appraiseReply(
			PROFILE,
			{ uuid: "n1", trigger_id: TRIGGER, text: "Standup in fifteen." },
			"please stop sending me these"
		);
		expect(out.reading).toBe("rejected");
		expect(out.suppressed).toBe(true);
	});

	test("the judgement is stored on the nudge as evidence", async () => {
		db();
		llm.generateJson.mockResolvedValue({ data: { reading: "welcomed", why: "thanked her" } });
		await appraise.appraiseReply(
			PROFILE,
			{ uuid: "n1", trigger_id: TRIGGER, text: "Standup in fifteen." },
			"perfect, thanks"
		);
		const stored = pool.query.mock.calls.find((c) => c[0].includes("SET appraisal = ?"));
		expect(JSON.parse(stored[1][0])).toMatchObject({ source: "reply", reading: "welcomed" });
	});

	test("an empty reply is not evidence", async () => {
		db();
		expect(await appraise.judgeReply("Standup in fifteen.", "   ")).toBeNull();
		expect(llm.generateJson).not.toHaveBeenCalled();
	});

	test("a model outage records NOTHING rather than a neutral outcome", async () => {
		// Recording "tolerated" because a model was down would move a real
		// person's score on the strength of an outage.
		db();
		llm.generateJson.mockRejectedValue(new Error("no model available"));
		const out = await appraise.appraiseReply(
			PROFILE,
			{ uuid: "n1", trigger_id: TRIGGER, text: "Standup in fifteen." },
			"ok"
		);
		expect(out).toBeNull();
		expect(written()).toBeNull();
	});

	test("an unusable reading is rejected by the validator, not coerced", async () => {
		db();
		llm.generateJson.mockImplementation(async ({ check }) => {
			expect(check({ reading: "vibes" })).toMatch(/one of the four/);
			throw new Error("validation failed");
		});
		expect(await appraise.judgeReply("Standup soon.", "sure")).toBeNull();
	});

	test("it runs on the local-first task, not the frontier one", async () => {
		db();
		llm.generateJson.mockResolvedValue({ data: { reading: "tolerated" } });
		await appraise.judgeReply("Standup soon.", "ok");
		expect(llm.generateJson).toHaveBeenCalledWith(expect.objectContaining({ task: "json" }));
	});

	test("appraising never throws into the conversation turn that called it", async () => {
		pool.query.mockRejectedValue(new Error("db down"));
		await expect(
			appraise.appraiseReply(PROFILE, { uuid: "n1", trigger_id: TRIGGER, text: "x" }, "ok")
		).resolves.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// The nightly sweep
// ---------------------------------------------------------------------------

describe("the sweep", () => {
	test("an unanswered nudge that reached someone counts as ignored", async () => {
		db({
			insertRows: [
				{ uuid: "n1", profile_id: PROFILE, trigger_id: TRIGGER, status: "expired" },
			],
		});
		const out = await appraise.sweep();
		expect(out).toMatchObject({ appraised: 1, ignored: 1 });
	});

	test("it only looks at nudges somebody could actually have seen", async () => {
		db();
		await appraise.sweep();
		const [sql] = pool.query.mock.calls[0];
		// Counting nudges that expired undelivered would teach her to stop
		// raising things that are only invisible because push is not set up.
		expect(sql).toContain("delivered_at IS NOT NULL OR pushed_at IS NOT NULL");
		expect(sql).toContain("appraised_at IS NULL");
	});

	test("a nudge is appraised once, ever", async () => {
		db({
			insertRows: [
				{ uuid: "n1", profile_id: PROFILE, trigger_id: TRIGGER, status: "dismissed" },
			],
		});
		await appraise.sweep();
		const marked = pool.query.mock.calls.find((c) => c[0].includes("SET appraisal = ?"));
		expect(marked[0]).toContain("appraised_at = NOW()");
	});
});
