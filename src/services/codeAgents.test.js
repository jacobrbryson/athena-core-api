jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./secrets", () => ({ getSecret: jest.fn() }));

const pool = require("../helpers/db");
const secrets = require("./secrets");
const codeAgents = require("./codeAgents");

const PROFILE = 7;
const OWNER = "google-owner-1";

function configure({ token = "ghp_test", ids = `${OWNER}, someone-else` } = {}) {
	secrets.getSecret.mockImplementation(async (name) =>
		name === "GITHUB_AGENT_TOKEN" ? token : name === "CODE_AGENT_GOOGLE_IDS" ? ids : null
	);
}

function respond(body, status = 200) {
	return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
	jest.clearAllMocks();
	codeAgents._reset();
	configure();
	pool.query.mockImplementation(async (sql) => {
		if (sql.includes("FROM profile")) return [[{ google_id: OWNER }]];
		return [[]];
	});
	global.fetch = jest.fn();
});

describe("mayUse", () => {
	test("allows a Google id on the owner's list", async () => {
		expect(await codeAgents.mayUse(PROFILE)).toBe(true);
	});

	test("refuses anyone else, and fails closed", async () => {
		pool.query.mockResolvedValue([[{ google_id: "a-stranger" }]]);
		expect(await codeAgents.mayUse(PROFILE)).toBe(false);

		configure({ ids: "" });
		expect(await codeAgents.mayUse(PROFILE)).toBe(false);

		configure({ token: null });
		expect(await codeAgents.mayUse(PROFILE)).toBe(false);

		configure();
		pool.query.mockRejectedValue(new Error("db down"));
		const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
		expect(await codeAgents.mayUse(PROFILE)).toBe(false);
		warn.mockRestore();

		expect(await codeAgents.mayUse(null)).toBe(false);
	});
});

describe("openInvestigation", () => {
	test("opens a labeled, read-only issue in the named repo", async () => {
		global.fetch.mockResolvedValue(respond({ number: 12, html_url: "https://github.com/x/12" }));
		const out = await codeAgents.openInvestigation({
			repo: "core_api",
			symptom: "The Jira card shows last month's tickets",
			details: "Started after Monday's deploy",
		});
		expect(out).toEqual({ ref: "jacobrbryson/athena-core-api#12", url: "https://github.com/x/12", number: 12 });

		const [url, init] = global.fetch.mock.calls[0];
		expect(url).toBe("https://api.github.com/repos/jacobrbryson/athena-core-api/issues");
		expect(init.method).toBe("POST");
		expect(init.headers.Authorization).toBe("Bearer ghp_test");
		const body = JSON.parse(init.body);
		expect(body.labels).toEqual([codeAgents.LABEL]);
		expect(body.title).toMatch(/^Athena investigate: The Jira card/);
		expect(body.body).toMatch(/read-only investigation/i);
		expect(body.body).toContain("Started after Monday's deploy");
	});

	test("refuses a repo that isn't listed, without calling GitHub", async () => {
		await expect(codeAgents.openInvestigation({ repo: "secrets", symptom: "x".repeat(20) })).rejects.toThrow(/Unknown repository/);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	test("reports a GitHub failure", async () => {
		global.fetch.mockResolvedValue(respond({ message: "Bad credentials" }, 401));
		await expect(codeAgents.openInvestigation({ repo: "companion", symptom: "Broken card here" })).rejects.toThrow(/401/);
	});
});

describe("findings", () => {
	test("reads only marked agent comments, one per agent", async () => {
		global.fetch.mockResolvedValue(
			respond([
				{ body: "Thanks!", created_at: "t0" },
				{ body: "<!-- athena-agent:claude -->\nThe date range is hard-coded in jira.js.", created_at: "t1" },
				{ body: "<!-- athena-agent:codex -->\nSame: `DAYS = 30` in jira.js:41.", created_at: "t2" },
				{ body: "<!-- athena-agent:claude -->\nA second Claude comment.", created_at: "t3" },
			])
		);
		const found = await codeAgents.findings("jacobrbryson/athena-core-api#12");
		expect(found).toEqual([
			{ agent: "claude", text: "The date range is hard-coded in jira.js.", at: "t1" },
			{ agent: "codex", text: "Same: `DAYS = 30` in jira.js:41.", at: "t2" },
		]);
		expect(global.fetch.mock.calls[0][0]).toBe(
			"https://api.github.com/repos/jacobrbryson/athena-core-api/issues/12/comments?per_page=50"
		);
	});

	test("never reads a repo outside the list, whatever the stored ref says", async () => {
		expect(await codeAgents.findings("someone/else#1")).toEqual([]);
		expect(await codeAgents.findings("not a ref")).toEqual([]);
		expect(global.fetch).not.toHaveBeenCalled();
	});
});

describe("promptBlock", () => {
	const row = {
		uuid: "u1",
		params: JSON.stringify({ repo: "core_api", symptom: "The Jira card shows old tickets" }),
		result_ref: "jacobrbryson/athena-core-api#12",
		executed_at: new Date(),
	};

	beforeEach(() => {
		pool.query.mockImplementation(async (sql) => {
			if (sql.includes("FROM profile")) return [[{ google_id: OWNER }]];
			if (sql.includes("FROM athena_action")) return [[row]];
			return [[]];
		});
	});

	test("raises a new finding once, unasked, then only when asked", async () => {
		global.fetch.mockResolvedValue(respond([{ body: "<!-- athena-agent:claude -->\nHard-coded range.", created_at: "t1" }]));

		const first = await codeAgents.promptBlock(PROFILE, "good morning");
		expect(first).toContain("Hard-coded range.");
		expect(first).toContain("(new — mention it)");
		expect(first).toContain("Still waiting on: Codex");
		expect(first).toMatch(/untrusted/);

		expect(await codeAgents.promptBlock(PROFILE, "good morning")).toBeNull();

		const asked = await codeAgents.promptBlock(PROFILE, "what did Claude find?");
		expect(asked).toContain("Hard-coded range.");
		expect(asked).not.toContain("(new — mention it)");
	});

	test("says nothing while nothing has come back and nobody asked", async () => {
		global.fetch.mockResolvedValue(respond([]));
		expect(await codeAgents.promptBlock(PROFILE, "hi")).toBeNull();
		expect(await codeAgents.promptBlock(PROFILE, "any word on that investigation?")).toContain("Still waiting on: Claude Code and Codex");
	});

	test("is null for anyone not on the owner's list, without reading their actions", async () => {
		pool.query.mockResolvedValue([[{ google_id: "a-stranger" }]]);
		expect(await codeAgents.promptBlock(PROFILE, "what did Claude find?")).toBeNull();
		expect(pool.query.mock.calls.some(([sql]) => sql.includes("athena_action"))).toBe(false);
	});

	test("never throws", async () => {
		global.fetch.mockRejectedValue(new Error("network"));
		const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
		await expect(codeAgents.promptBlock(PROFILE, "what did Claude find?")).resolves.toEqual(expect.any(String));
		pool.query.mockRejectedValue(new Error("db down"));
		await expect(codeAgents.promptBlock(PROFILE, "what did Claude find?")).resolves.toBeNull();
		warn.mockRestore();
	});
});

describe("fixes", () => {
	const REF = "jacobrbryson/athena-core-api#20";

	test("openFix opens an athena-fix issue, adding the Codex label only when asked", async () => {
		global.fetch.mockResolvedValue(respond({ number: 20, html_url: "https://github.com/x/20" }));
		const out = await codeAgents.openFix({
			repo: "core_api",
			change: "Use the sprint's own date range in the Jira query",
			investigation: "jacobrbryson/athena-core-api#12",
			agent: "claude",
		});
		expect(out.ref).toBe(REF);
		let body = JSON.parse(global.fetch.mock.calls[0][1].body);
		expect(body.labels).toEqual([codeAgents.FIX_LABEL]);
		expect(body.title).toMatch(/^Athena fix: Use the sprint/);
		expect(body.body).toContain("jacobrbryson/athena-core-api#12");
		expect(body.body).toMatch(/protected-path check/);

		await codeAgents.openFix({ repo: "core_api", change: "Something specific enough", agent: "codex" });
		body = JSON.parse(global.fetch.mock.calls[1][1].body);
		expect(body.labels).toEqual([codeAgents.FIX_LABEL, codeAgents.CODEX_FIX_LABEL]);
	});

	function comments(list) {
		return respond(list.map((body, i) => ({ body, created_at: `t${i}` })));
	}

	test("fixStatus reads each outcome the workflow reports", async () => {
		global.fetch.mockResolvedValueOnce(comments([]));
		expect(await codeAgents.fixStatus(REF)).toEqual({ state: "working" });

		codeAgents._reset();
		global.fetch.mockResolvedValueOnce(comments(["<!-- athena-fix-result:none -->\nNo change made."]));
		expect(await codeAgents.fixStatus(REF)).toEqual({ state: "no_change" });

		codeAgents._reset();
		global.fetch.mockResolvedValueOnce(comments(["<!-- athena-fix-result:failed -->"]));
		expect(await codeAgents.fixStatus(REF)).toEqual({ state: "failed" });
	});

	test("fixStatus follows the pull request to merged, open or closed", async () => {
		const pr = "https://github.com/jacobrbryson/athena-core-api/pull/21";
		for (const [issue, state] of [
			[{ state: "closed", pull_request: { merged_at: "2026-10-10T12:00:00Z" } }, "merged"],
			[{ state: "open", pull_request: { merged_at: null } }, "open"],
			[{ state: "closed", pull_request: { merged_at: null } }, "closed"],
		]) {
			codeAgents._reset();
			global.fetch.mockReset();
			global.fetch.mockResolvedValueOnce(comments([`<!-- athena-fix-pr: ${pr} -->\nPull request opened.`])).mockResolvedValueOnce(respond(issue));
			expect(await codeAgents.fixStatus(REF)).toEqual({ state, url: pr });
			expect(global.fetch.mock.calls[1][0]).toBe("https://api.github.com/repos/jacobrbryson/athena-core-api/issues/21");
		}
	});

	test("fixStatus never follows a pull request link into another repository", async () => {
		global.fetch.mockResolvedValueOnce(comments(["<!-- athena-fix-pr: https://github.com/evil/repo/pull/1 -->"]));
		expect(await codeAgents.fixStatus(REF)).toEqual({ state: "open", url: "https://github.com/evil/repo/pull/1" });
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	test("promptBlock raises a merged fix once, then only when asked", async () => {
		pool.query.mockImplementation(async (sql) => {
			if (sql.includes("FROM profile")) return [[{ google_id: OWNER }]];
			if (sql.includes("FROM athena_action"))
				return [[{ uuid: "f1", action_id: "fix_code", params: JSON.stringify({ repo: "core_api", change: "Fix the Jira range" }), result_ref: REF, executed_at: new Date() }]];
			return [[]];
		});
		const pr = "https://github.com/jacobrbryson/athena-core-api/pull/21";
		global.fetch.mockImplementation(async (url) =>
			url.endsWith("/issues/21") ? respond({ state: "closed", pull_request: { merged_at: "t" } }) : comments([`<!-- athena-fix-pr: ${pr} -->`])
		);
		const first = await codeAgents.promptBlock(PROFILE, "morning");
		expect(first).toContain('Fix in core_api: "Fix the Jira range"');
		expect(first).toMatch(/merged, and it deploys automatically/);
		expect(first).toContain("(new, mention it)");
		expect(first).toMatch(/you never merge or deploy anything yourself/);
		expect(await codeAgents.promptBlock(PROFILE, "morning")).toBeNull();
		expect(await codeAgents.promptBlock(PROFILE, "did the fix deploy?")).not.toContain("(new, mention it)");
	});
});
