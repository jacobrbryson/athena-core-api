jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./workplaces", () => ({ list: jest.fn() }));
jest.mock("./credentials", () => ({ list: jest.fn() }));
jest.mock("./workItems/store", () => ({
  credential: jest.fn(),
  environments: jest.fn(),
}));
jest.mock("./llm/adapters/workProvider", () => ({ generate: jest.fn() }));
jest.mock("./guardianEngine/dispatch", () => ({ wakeAt: jest.fn() }));
jest.mock("../helpers/actor", () => ({ requireAdultActor: jest.fn() }));
const pool = require("../helpers/db");
const workplaces = require("./workplaces");
const credentials = require("./credentials");
const store = require("./workItems/store");
const model = require("./llm/adapters/workProvider");
const dispatch = require("./guardianEngine/dispatch");
const svc = require("./workspaceReviews");
const action = require("./actions/workspaceReview");
const company = "11111111-2222-4333-8444-555555555555";
const other = "99999999-2222-4333-8444-555555555555";
const head = "a".repeat(40),
  base = "b".repeat(40);
let config, savedCriteria, draft, pr, keyId, runnerSeen, runnerPaired;
const generateParams = () => ({
  repository: "Acme/widgets",
  number: 7,
  headSha: head,
  baseSha: base,
});
const submission = () => ({
  workplace_uuid: company,
  repository: "Acme/widgets",
  pull_number: 7,
  head_sha: head,
  base_sha: base,
  event: "APPROVE",
  body: "Exact edited text",
  extra: "untrusted",
});
beforeEach(() => {
  jest.resetAllMocks();
  config = {
    credential_uuid: "model-key",
    provider: "openai",
    model: "explicit-company-model",
  };
  savedCriteria = "Check rollback safety and tenant isolation.";
  draft = null;
  keyId = "github-key";
  runnerSeen = true;
  runnerPaired = true;
  pr = {
    state: "open",
    title: "Fix bug",
    body: "Description",
    head: { sha: head },
    base: { sha: base },
    user: { login: "author" },
    changed_files: 1,
    requested_reviewers: [{ login: "reviewer" }],
  };
  workplaces.list.mockResolvedValue([
    {
      uuid: company,
      connections: [
        { provider: "github", credentialUuid: "github-key", status: "active" },
        { provider: "openai", credentialUuid: "model-key", status: "active" },
      ],
    },
  ]);
  credentials.list.mockResolvedValue([
    {
      uuid: "model-key",
      provider: "openai",
      kind: "api_key",
      status: "active",
      display_name: "Company OpenAI",
    },
    {
      uuid: "foreign-model",
      provider: "anthropic",
      kind: "api_key",
      status: "active",
      display_name: "Other company",
    },
  ]);
  store.credential.mockImplementation(async (_p, _w, _id, provider) => ({
    uuid: provider === "github" ? keyId : "model-key",
    accessToken: `${provider}-test-secret`,
  }));
  store.environments.mockResolvedValue([]);
  dispatch.wakeAt.mockResolvedValue(true);
  model.generate.mockResolvedValue({
    text: JSON.stringify({ review: "## Findings\nReview text." }),
    usage: { total_tokens: 123 },
  });
  pool.query.mockImplementation(async (sql, args) => {
    if (sql.startsWith("SELECT credential_uuid"))
      return [[...(config ? [config] : [])]];
    if (sql.startsWith("SELECT criteria"))
      return [[{ criteria: savedCriteria, updated_at: null }]];
    if (sql.startsWith("INSERT INTO athena_repository_review"))
      savedCriteria = args[3];
    if (sql.startsWith("INSERT INTO athena_workspace_review_config"))
      config = { credential_uuid: args[2], provider: args[3], model: args[4] };
    if (sql.startsWith("INSERT INTO athena_pull_review_draft"))
      draft = {
        uuid: args[0],
        profile_id: args[1],
        workplace_uuid: args[2],
        repository: args[3],
        pull_number: args[4],
        head_sha: args[5],
        base_sha: args[6],
        criteria: args[7],
        credential_uuid: args[8],
        provider: args[9],
        model: args[10],
        warnings: args[11],
        pull_title: args[12],
        db_check_state: args[13],
        state: "generating",
        pass_index: 0,
        pass_claimed: 0,
      };
    if (sql.includes("SET pass_claimed=1")) {
      const open =
        draft.state === "generating" &&
        draft.pass_index === args[1] &&
        !draft.pass_claimed;
      if (open) draft.pass_claimed = 1;
      return [{ affectedRows: open ? 1 : 0 }];
    }
    if (sql.includes("SET pass_total="))
      Object.assign(draft, { pass_total: args[0], warnings: args[1] });
    if (sql.includes("SET pass_notes=?"))
      Object.assign(draft, {
        pass_notes: args[0],
        pass_index: args[1],
        pass_claimed: 0,
      });
    if (sql.includes("SET usage_json=")) draft.usage_json = args[0];
    if (sql.startsWith("SELECT 1 FROM paired_device"))
      return [runnerSeen ? [{ 1: 1 }] : []];
    if (sql.startsWith("SELECT d.uuid"))
      return [
        runnerPaired && draft?.db_check_state === "queued"
          ? [draft]
          : [],
      ];
    if (sql.includes("db_check_state='running',db_check_runner=?")) {
      Object.assign(draft, {
        db_check_state: "running",
        db_check_runner: args[0],
      });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SET db_check_state=?,db_check_result=?")) {
      const open =
        draft.db_check_state === "running" && draft.db_check_runner === args[4];
      if (open)
        Object.assign(draft, {
          db_check_state: args[0],
          db_check_result: args[1],
        });
      return [{ affectedRows: open ? 1 : 0 }];
    }
    if (sql.includes("SET db_check_state='late'")) draft.db_check_state = "late";
    if (sql.includes("SET body="))
      Object.assign(draft, { body: args[0], state: "ready", pass_claimed: 0 });
    if (sql.includes("SET state=?"))
      Object.assign(draft, {
        state: args[0],
        failure: args[1],
        pass_claimed: 0,
      });
    if (sql.startsWith("SELECT uuid,workplace_uuid"))
      return [[...(draft ? [{ ...draft, updated_at: "now" }] : [])]];
    if (sql.startsWith("SELECT * FROM athena_pull_review_draft"))
      return [[...(draft ? [draft] : [])]];
    return [{ affectedRows: 1 }];
  });
  global.fetch = jest.fn(async (url, opts) => {
    const path = new URL(url).pathname;
    let data = [];
    if (path.endsWith("/pulls/7")) data = structuredClone(pr);
    if (path.endsWith("/files"))
      data = [
        {
          filename: "src/fix.js",
          status: "modified",
          patch: "@@ -1 +1 @@\n-old\n+new",
        },
      ];
    if (path === "/repos/acme/widgets") data = { full_name: "Acme/widgets" };
    if (opts.method === "POST") data = { id: 42, state: "APPROVED" };
    return { ok: true, json: async () => data };
  });
});
test("refuses another person’s company before reading keys or GitHub", async () => {
  await expect(svc.detail(9, other, "acme/widgets", 7)).rejects.toMatchObject({
    status: 404,
  });
  expect(store.credential).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
test.each([
  "https://attacker.test/a/b",
  "acme/../x",
  "acme/widgets?token=x",
  "acme/widgets#x",
  "acme/.",
  "acme/..",
])("refuses unsafe repository path %s", (repo) => {
  expect(() => svc.repository(repo)).toThrow();
});
test("settings expose only linked active company API-key metadata, never secret values", async () => {
  const result = await svc.settings(9, company);
  expect(result.keys).toEqual([
    { uuid: "model-key", provider: "openai", name: "Company OpenAI" },
  ]);
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(store.credential).not.toHaveBeenCalled();
});
test("cannot configure another company’s model key", async () => {
  await expect(
    svc.saveSettings(9, company, {
      credentialUuid: "foreign-model",
      model: "model",
    }),
  ).rejects.toThrow(/active AI API key/);
  expect(pool.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
});
test("saves criteria in the caller/company/repository scope after checking GitHub access", async () => {
  await svc.saveCriteria(9, company, "Acme/widgets", "New criteria");
  expect(store.credential).toHaveBeenCalledWith(
    9,
    company,
    "github-key",
    "github",
    true,
  );
  expect(pool.query).toHaveBeenCalledWith(
    expect.stringContaining("INSERT INTO athena_repository_review"),
    [9, company, "acme/widgets", "New criteria"],
  );
});
test("does not dispatch with no linked AI key or fall back to personal/global funding", async () => {
  credentials.list.mockResolvedValue([]);
  await expect(svc.generate(9, company, generateParams())).rejects.toThrow(
    /company AI API key/,
  );
  expect(model.generate).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
const reviewed = async () => {
  await svc.generate(9, company, generateParams());
  await svc.runPass(draft.uuid, draft.pass_index);
  return draft;
};
test("answers at once and leaves the model call to a background pass", async () => {
  const result = await svc.generate(9, company, generateParams());
  expect(result).toMatchObject({ state: "generating", headSha: head });
  expect(model.generate).not.toHaveBeenCalled();
  expect(dispatch.wakeAt).toHaveBeenCalledWith(
    expect.any(Number),
    expect.objectContaining({ reason: `${draft.uuid}:0` }),
  );
});
test("drafts with the guarded company adapter, saved criteria and diff; never publishes", async () => {
  const result = await reviewed();
  expect(model.generate).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "openai",
      model: "explicit-company-model",
      apiKey: "openai-test-secret",
      maxTokens: 16000,
      timeoutMs: 240000,
      prompt: expect.stringContaining(savedCriteria),
    }),
  );
  expect(model.generate.mock.calls[0][0].prompt).toContain("src/fix.js");
  expect(result).toMatchObject({
    state: "ready",
    head_sha: head,
    base_sha: base,
    criteria: savedCriteria,
  });
  expect(JSON.parse(result.usage_json)).toEqual({ total_tokens: 123 });
  expect(
    fetch.mock.calls.every(([, options]) => options.method === "GET"),
  ).toBe(true);
});
test("a redelivered task cannot pay for the same pass twice", async () => {
  await reviewed();
  await expect(svc.runPass(draft.uuid, 0)).resolves.toBe(false);
  expect(model.generate).toHaveBeenCalledTimes(1);
});
test("a pass runs as the draft's owner, not an empty background identity", async () => {
  const original = pool.query.getMockImplementation();
  pool.query.mockImplementation(async (sql, args) =>
    sql.startsWith("SELECT google_id")
      ? [[{ google_id: "owner-google" }]]
      : original(sql, args),
  );
  const access = require("../security/access");
  let seen;
  model.generate.mockImplementation(async () => {
    seen = access.context.getStore();
    return { text: JSON.stringify({ review: "Done" }), usage: null };
  });
  await reviewed();
  expect(seen).toEqual({ identity: { google_id: "owner-google" } });
});
test("output spent entirely on thinking is reported as that, not as unreadable", async () => {
  model.generate.mockResolvedValue({
    text: "",
    stopReason: "max_tokens",
    usage: { output_tokens: 16000 },
  });
  await reviewed();
  expect(draft).toMatchObject({
    state: "failed",
    failure: expect.stringMatching(/output allowance/),
  });
  expect(JSON.parse(draft.usage_json)).toEqual({ output_tokens: 16000 });
});
test("a refusal is reported as a refusal", async () => {
  model.generate.mockResolvedValue({ text: "", stopReason: "refusal" });
  await reviewed();
  expect(draft.failure).toMatch(/declined/);
});
test("a large diff is reviewed in parts, one task each, then combined", async () => {
  const original = fetch.getMockImplementation();
  fetch.mockImplementation((url, options) =>
    String(url).includes("/files?")
      ? Promise.resolve({
          ok: true,
          json: async () =>
            ["a.js", "b.js"].map((filename) => ({
              filename,
              status: "modified",
              patch: "x".repeat(30000),
            })),
        })
      : original(url, options),
  );
  pr.changed_files = 2;
  await svc.generate(9, company, generateParams());
  model.generate
    .mockResolvedValueOnce({
      text: JSON.stringify({ review: "Finding A" }),
      usage: { output_tokens: 1 },
    })
    .mockResolvedValueOnce({
      text: JSON.stringify({ review: "Finding B" }),
      usage: { output_tokens: 2 },
    })
    .mockResolvedValueOnce({
      text: JSON.stringify({ review: "Both findings" }),
      usage: { output_tokens: 4 },
    });
  await svc.runPass(draft.uuid, 0);
  expect(draft).toMatchObject({ state: "generating", pass_total: 3 });
  expect(dispatch.wakeAt).toHaveBeenLastCalledWith(
    expect.any(Number),
    expect.objectContaining({ reason: `${draft.uuid}:1` }),
  );
  await svc.runPass(draft.uuid, 1);
  await svc.runPass(draft.uuid, 2);
  const prompts = model.generate.mock.calls.map(([c]) => c.prompt);
  expect(prompts[0]).toContain("a.js");
  expect(prompts[0]).not.toContain("b.js");
  expect(prompts[1]).toContain("b.js");
  expect(prompts[2]).toContain("Finding A");
  expect(prompts[2]).toContain("Finding B");
  expect(draft).toMatchObject({ state: "ready", body: "Both findings" });
  expect(JSON.parse(draft.usage_json)).toEqual({ output_tokens: 7 });
});
test("a stale draft is called lost, not restarted", async () => {
  await svc.generate(9, company, generateParams());
  await svc.recent(9);
  expect(
    pool.query.mock.calls.some(
      ([sql]) => sql.includes("state='unknown'") && sql.includes("updated_at<"),
    ),
  ).toBe(true);
  expect(model.generate).not.toHaveBeenCalled();
});
test("Athena's Agents sees a running review with what opens it, and no key or diff", async () => {
  await svc.generate(9, company, generateParams());
  const [run] = await svc.recent(9);
  expect(run).toMatchObject({
    kind: "review",
    state: "working",
    repo: "acme/widgets",
    summary: "#7 Fix bug",
    workplaceUuid: company,
    number: 7,
  });
  expect(JSON.stringify(run)).not.toMatch(/secret|criteria/i);
});
test("rejects a PR changed since the drawer loaded before spending company tokens", async () => {
  pr.head.sha = "c".repeat(40);
  await expect(svc.generate(9, company, generateParams())).rejects.toThrow(
    /changed/,
  );
  expect(model.generate).not.toHaveBeenCalled();
});
test("rejects a snapshot that changes while fetching its diff", async () => {
  const original = fetch.getMockImplementation();
  fetch.mockImplementation(async (url, options) => {
    const r = await original(url, options);
    if (String(url).includes("/files?")) pr.base.sha = "c".repeat(40);
    return r;
  });
  await reviewed();
  expect(draft).toMatchObject({
    state: "failed",
    failure: expect.stringMatching(/changed while/),
  });
  expect(model.generate).not.toHaveBeenCalled();
});
test("marks missing patches as a review limitation and retains it in the editable text", async () => {
  const original = fetch.getMockImplementation();
  fetch.mockImplementation((url, options) =>
    String(url).includes("/files?")
      ? Promise.resolve({
          ok: true,
          json: async () => [{ filename: "binary.png" }],
        })
      : original(url, options),
  );
  const result = await reviewed();
  expect(result.warnings).toMatch(/patches are unavailable/);
  expect(result.body).toMatch(/^Review limitations:/);
});
test("ambiguous model failure records unknown billing and never auto-retries", async () => {
  model.generate.mockRejectedValue(new Error("timeout"));
  await reviewed();
  expect(draft.failure).toMatch(/may have incurred usage/);
  expect(draft.state).toBe("unknown");
  expect(model.generate).toHaveBeenCalledTimes(1);
});
test("retains provider usage even when output is malformed", async () => {
  model.generate.mockResolvedValue({
    text: "not JSON",
    usage: { total_tokens: 100 },
  });
  await reviewed();
  expect(draft.failure).toMatch(/unreadable review/);
  expect(JSON.parse(draft.usage_json)).toEqual({ total_tokens: 100 });
  expect(draft.state).toBe("failed");
});
test("normalizes only exact review text, decision, company and commits", async () => {
  const clean = await svc.normalizeSubmission(9, submission());
  expect(clean).toEqual({
    workplace_uuid: company,
    repository: "acme/widgets",
    pull_number: 7,
    head_sha: head,
    base_sha: base,
    event: "APPROVE",
    body: "Exact edited text",
    github_credential_uuid: "github-key",
  });
  expect(
    fetch.mock.calls.every(([, options]) => options.method === "GET"),
  ).toBe(true);
});
test("refuses invented decisions, closed PRs and stale bases", async () => {
  await expect(
    svc.normalizeSubmission(9, { ...submission(), event: "MERGE" }),
  ).rejects.toThrow(/Choose/);
  pr.state = "closed";
  await expect(svc.normalizeSubmission(9, submission())).rejects.toThrow(
    /changed or closed/,
  );
  pr.state = "open";
  pr.base.sha = "c".repeat(40);
  await expect(svc.normalizeSubmission(9, submission())).rejects.toThrow(
    /changed or closed/,
  );
});
test("rechecks commits and company key at execution, before writing GitHub", async () => {
  const clean = await svc.normalizeSubmission(9, submission());
  keyId = "replacement-key";
  await expect(svc.submit(9, clean)).rejects.toThrow(/GitHub key changed/);
  keyId = "github-key";
  pr.head.sha = "c".repeat(40);
  await expect(svc.submit(9, clean)).rejects.toThrow(/changed or closed/);
  expect(
    fetch.mock.calls.every(([, options]) => options.method === "GET"),
  ).toBe(true);
});
test("publishes the approved text/event pinned to its commit using only the company GitHub key", async () => {
  const clean = await svc.normalizeSubmission(9, submission());
  const result = await svc.submit(9, clean);
  expect(fetch).toHaveBeenLastCalledWith(
    "https://api.github.com/repos/acme/widgets/pulls/7/reviews",
    expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: expect.objectContaining({
        Authorization: "Bearer github-test-secret",
      }),
      body: JSON.stringify({
        commit_id: head,
        event: "APPROVE",
        body: "Exact edited text",
      }),
    }),
  );
  expect(result.ref).toContain("#pullrequestreview-42");
});
test("review action requires human approval and never accepts standing or direct execution", () => {
  expect(action).toMatchObject({
    id: "submit_workspace_review",
    consentType: "action_authority",
    standing: false,
    provider: "github",
  });
  expect(action.direct).not.toBe(true);
});
test("refuses a concurrent paid review before model dispatch", async () => {
  const original = pool.query.getMockImplementation();
  pool.query.mockImplementation((sql, args) =>
    sql.startsWith("INSERT INTO athena_pull_review_draft")
      ? Promise.reject(
          Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" }),
        )
      : original(sql, args),
  );
  await expect(svc.generate(9, company, generateParams())).rejects.toThrow(
    /already running/,
  );
  expect(model.generate).not.toHaveBeenCalled();
});
test("does not guess a model when a company key has no saved model choice or environment", async () => {
  config = null;
  await expect(svc.generate(9, company, generateParams())).rejects.toThrow(
    /key and model/,
  );
  expect(model.generate).not.toHaveBeenCalled();
});
test("reuses only an environment funded by the same company key", async () => {
  config = null;
  store.environments.mockResolvedValue([
    {
      workplace_uuid: other,
      config: {
        modelCredentialUuid: "model-key",
        provider: "openai",
        model: "foreign",
      },
    },
    {
      workplace_uuid: company,
      config: {
        modelCredentialUuid: "model-key",
        provider: "openai",
        model: "matching",
      },
    },
  ]);
  expect((await svc.settings(9, company)).config.model).toBe("matching");
});
test("combines paginated discussion, inline comments and review bodies without following external URLs", async () => {
  const original = fetch.getMockImplementation();
  fetch.mockImplementation((url, options) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/issues/7/comments"))
      return Promise.resolve({
        ok: true,
        json: async () =>
          u.searchParams.get("page") === "1"
            ? Array.from({ length: 100 }, (_, i) => ({
                id: i,
                body: `Comment ${i}`,
                user: { login: "commenter" },
                created_at: "2026-10-29T00:00:00Z",
              }))
            : [{ id: 101, body: "Second page", user: { login: "commenter" } }],
      });
    if (u.pathname.endsWith("/pulls/7/comments"))
      return Promise.resolve({
        ok: true,
        json: async () => [
          {
            id: 102,
            body: "Inline note",
            path: "src/a.js",
            user: { login: "inline" },
          },
        ],
      });
    if (u.pathname.endsWith("/pulls/7/reviews"))
      return Promise.resolve({
        ok: true,
        json: async () => [
          {
            id: 103,
            body: "Review body",
            user: { login: "reviewer" },
            state: "COMMENTED",
          },
        ],
      });
    return original(url, options);
  });
  const result = await svc.detail(9, company, "acme/widgets", 7);
  expect(result.comments).toHaveLength(103);
  expect(result.comments.map((c) => c.body)).toEqual(
    expect.arrayContaining(["Second page", "Inline note", "Review body"]),
  );
  expect(
    fetch.mock.calls.every(
      ([url]) => new URL(url).origin === "https://api.github.com",
    ),
  ).toBe(true);
  expect(result.truncated).toBe(false);
});
describe("the database check", () => {
  const device = "dddddddd-2222-4333-8444-555555555555";
  const sqlPr = () => {
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((url, options) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/files"))
        return Promise.resolve({
          ok: true,
          json: async () => [
            { filename: "b/two.sql", status: "added", patch: "+SELECT 2;" },
            { filename: "a/one.sql", status: "modified", patch: "+SELECT 1;" },
            { filename: "old.sql", status: "removed" },
          ],
        });
      if (u.pathname.includes("/contents/"))
        return Promise.resolve({
          ok: true,
          json: async () => ({
            encoding: "base64",
            content: Buffer.from(`-- ${u.pathname}@${u.searchParams.get("ref")}`).toString("base64"),
          }),
        });
      return original(url, options);
    });
  };
  const clean = {
    backupDate: "2026-10-30",
    tables: 12,
    restoreErrors: [],
    files: [
      { path: "a/one.sql", ok: true, ms: 40, output: "" },
      { path: "b/two.sql", ok: false, ms: 9, output: "ERROR: no such table" },
    ],
    notRun: [],
    schemaChanges: "+ CREATE TABLE x",
    rowChanges: [{ table: "public.x", before: 1, after: 2 }],
  };
  test("a PR with no SQL never waits for the runner", async () => {
    await svc.generate(9, company, generateParams());
    expect(draft.db_check_state).toBeNull();
    expect(dispatch.wakeAt.mock.calls[0][1].name).not.toMatch(/-wait$/);
  });
  test("SQL holds the review for the runner, with a backstop so it can't hang", async () => {
    sqlPr();
    const before = Date.now();
    await svc.generate(9, company, generateParams());
    expect(draft.db_check_state).toBe("queued");
    const [at, booking] = dispatch.wakeAt.mock.calls[0];
    expect(at - before).toBeGreaterThanOrEqual(8 * 60 * 1000);
    expect(booking.name).toMatch(/-wait$/);
    expect((await svc.recent(9))[0].progress).toBe("Waiting for the database check");
  });
  test("with no runner online the review goes ahead and says the SQL was not run", async () => {
    sqlPr();
    runnerSeen = false;
    await reviewed();
    expect(draft.body).toMatch(/no work runner was online/);
  });
  test("hands the runner the SQL at the reviewed commit, in path order, and no keys", async () => {
    sqlPr();
    await svc.generate(9, company, generateParams());
    const check = await svc.claimCheck(9, device);
    expect(check.owner).toBe("acme");
    expect(check.files.map((f) => f.path)).toEqual(["a/one.sql", "b/two.sql"]);
    expect(check.files[0].sql).toContain(`@${head}`);
    expect(JSON.stringify(check)).not.toMatch(/secret/);
    expect((await svc.recent(9))[0].progress).toBe("Testing on a database copy");
  });
  test("a device that isn't the paired runner gets nothing", async () => {
    sqlPr();
    await svc.generate(9, company, generateParams());
    runnerPaired = false;
    await expect(svc.claimCheck(9, device)).resolves.toBeNull();
    expect(draft.db_check_state).toBe("queued");
  });
  test("the result wakes the review, reaches the model and is stated by code", async () => {
    sqlPr();
    await svc.generate(9, company, generateParams());
    await svc.claimCheck(9, device);
    await expect(svc.finishCheck(9, device, draft.uuid, clean)).resolves.toEqual({ accepted: true });
    expect(dispatch.wakeAt).toHaveBeenLastCalledWith(
      expect.any(Number),
      expect.objectContaining({ reason: `${draft.uuid}:0`, name: `review-${draft.uuid}-0` }),
    );
    await svc.runPass(draft.uuid, 0);
    expect(model.generate.mock.calls[0][0].prompt).toContain("no such table");
    expect(draft.body).toMatch(/1 of 2 SQL files ran without error/);
    expect(draft.body).toMatch(/b\/two\.sql failed/);
    expect(draft.body).toMatch(/not production/);
  });
  test("a late runner cannot change a review that already went ahead", async () => {
    sqlPr();
    await svc.generate(9, company, generateParams());
    await svc.claimCheck(9, device);
    await svc.runPass(draft.uuid, 0);
    expect(draft.body).toMatch(/had not finished/);
    await expect(svc.finishCheck(9, device, draft.uuid, clean)).resolves.toEqual({ accepted: false });
    expect(model.generate).toHaveBeenCalledTimes(1);
  });
  test("a runner failure is reported, and the review still finishes", async () => {
    sqlPr();
    await svc.generate(9, company, generateParams());
    await svc.claimCheck(9, device);
    await svc.finishCheck(9, device, draft.uuid, { failure: "No backup is on the runner." });
    await svc.runPass(draft.uuid, 0);
    expect(draft.body).toMatch(/could not run: No backup/);
    expect(model.generate.mock.calls[0][0].prompt).not.toContain('"databaseCheck"');
  });
});
describe("the pass route", () => {
  const { passWith } = require("../controllers/workspaceReviews");
  const res = () => {
    const r = { set: jest.fn(), status: jest.fn(() => r), json: jest.fn(() => r) };
    return r;
  };
  const reason = `${company}:0`;
  test("refuses a caller that isn't an allowed service account", async () => {
    const out = res();
    const run = jest.fn();
    await passWith({ body: { reason } }, out, { verify: async () => false, run });
    expect(out.status).toHaveBeenCalledWith(401);
    expect(run).not.toHaveBeenCalled();
  });
  test("answers 200 on a failed pass, so Cloud Tasks can't bill it twice", async () => {
    const out = res();
    await passWith({ body: { reason } }, out, {
      verify: async () => true,
      run: async () => {
        throw new Error("boom");
      },
    });
    expect(out.status).not.toHaveBeenCalled();
    expect(out.json).toHaveBeenCalledWith({ ran: false });
  });
});
