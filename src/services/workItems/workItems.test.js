jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn(), get: jest.fn() }));
jest.mock("../connectors/oauth", () => ({ accessToken: jest.fn() }));
jest.mock("../parent-helpers", () => ({
  withTransaction: (fn) => fn(require("../../helpers/db")),
}));
jest.mock("../llm/adapters/workProvider", () => ({ generate: jest.fn() }));
const v = require("./validation");
const db = require("../../helpers/db");
const creds = require("../credentials");
const store = require("./store");
const jira = require("./jira");
const { usageTokens } = require("./engine");
const id = "00000000-0000-4000-8000-000000000001";
const cfg = () => ({
  runnerUuid: id,
  jiraCredentialUuid: id,
  githubCredentialUuid: id,
  modelCredentialUuid: id,
  provider: "openai",
  model: "chosen-model",
  tokenLimit: 100000,
  repositories: [
    {
      name: "frontend",
      url: "https://github.com/Vivacity-Tech/Dream-Frontend",
      ref: "main",
    },
  ],
  backup: "gs://dream-db-exports/sterilized/example.sql.gz",
  backupFormat: "sql.gz",
  recipes: [
    { id: "tests", repository: "frontend", kind: "test", command: "npm test" },
    {
      id: "start",
      repository: "frontend",
      kind: "start",
      command: "npm run dev",
    },
  ],
  frontendUrl: "http://frontend:3000/",
  backendUrl: "http://frontend:3000/health",
});
beforeEach(() => {
  jest.clearAllMocks();
});
test("environment retains only reviewed fields and fixes PostgreSQL at 17", () => {
  const clean = v.config({
    ...cfg(),
    apiKey: "must-not-save",
    postgresVersion: 12,
    dangerous: true,
  });
  expect(clean.postgresVersion).toBe(17);
  expect(clean.apiKey).toBeUndefined();
  expect(clean.dangerous).toBeUndefined();
});
test.each([
  "https://evil.example/repo",
  "https://github.com@evil.example/o/r",
  "file:///source",
  "https://github.com/o/r?token=x",
])("rejects non-repository source %s", (url) => {
  const c = cfg();
  c.repositories[0].url = url;
  expect(() => v.config(c)).toThrow();
});
test.each([
  "http://169.254.169.254/",
  "http://localhost:3000/",
  "https://production.example/",
  "http://frontend@production/",
])("rejects health target %s", (frontendUrl) =>
  expect(() => v.config({ ...cfg(), frontendUrl })).toThrow(),
);
test("requires an exact backup, not an unpinned prefix", () =>
  expect(() =>
    v.config({ ...cfg(), backup: "gs://dream-db-exports/sterilized/" }),
  ).toThrow());
test.each([
  "../outside",
  "/etc/passwd",
  "frontend/.env.local",
  "frontend/.github/workflows/x.yml",
  "frontend/.git/config",
  "frontend/credentials.json",
  "frontend/x.pem",
  "frontend/a/../../x",
  "frontend/a\\b",
])("rejects escaped or secret path %s", (path) =>
  expect(() => v.path(path)).toThrow(),
);
test("planning refuses writes and unconfigured test commands", () => {
  expect(() =>
    v.operation(
      { type: "write", path: "frontend/src/x.ts", content: "x" },
      false,
      cfg(),
    ),
  ).toThrow();
  expect(() =>
    v.operation({ type: "test", recipe: "curl secrets" }, true, cfg()),
  ).toThrow();
  expect(v.operation({ type: "test", recipe: "tests" }, false, cfg())).toEqual({
    type: "test",
    recipe: "tests",
  });
});
test("implementation needs real browser assertions and rejects arbitrary browser operations", () => {
  expect(() =>
    v.operation({ type: "finish", text: "done", demo: [] }, true, cfg()),
  ).toThrow();
  expect(() =>
    v.operation(
      {
        type: "finish",
        text: "done",
        demo: [
          { type: "assert", text: "Saved", criterion: "Save works" },
          { type: "evaluate", script: "fetch(secret)" },
        ],
      },
      true,
      cfg(),
    ),
  ).toThrow();
  expect(
    v.operation(
      {
        type: "finish",
        text: "done",
        demo: [{ type: "assert", text: "Saved", criterion: "Save works" }],
      },
      true,
      cfg(),
    ).demo,
  ).toHaveLength(1);
});
test("credential lookup requires exact workplace, owner, UUID and provider; no fallback", async () => {
  db.query.mockResolvedValueOnce([[]]);
  await expect(
    store.credential(1, "client-a", id, "openai", true),
  ).rejects.toThrow(/belonging/);
  expect(creds.get).not.toHaveBeenCalled();
  expect(db.query.mock.calls[0][1]).toEqual([1, "client-a", id, "openai"]);
});
test("shared GCP identity cannot be used to read another workplace or profile backup", () => {
  const previous = process.env.WORK_BACKUP_PREFIXES;
  try {
    process.env.WORK_BACKUP_PREFIXES = JSON.stringify({
      "client-a": { profileId: 1, prefixes: ["gs://company-test/sterilized/"] },
    });
    expect(() =>
      store.authorizeBackup(
        1,
        "client-a",
        "gs://company-test/sterilized/test.sql",
      ),
    ).not.toThrow();
    expect(() =>
      store.authorizeBackup(
        2,
        "client-a",
        "gs://company-test/sterilized/test.sql",
      ),
    ).toThrow();
    expect(() =>
      store.authorizeBackup(
        1,
        "client-b",
        "gs://company-test/sterilized/test.sql",
      ),
    ).toThrow();
    expect(() =>
      store.authorizeBackup(
        1,
        "client-a",
        "gs://company-test/production/test.sql",
      ),
    ).toThrow();
  } finally {
    if (previous === undefined) delete process.env.WORK_BACKUP_PREFIXES;
    else process.env.WORK_BACKUP_PREFIXES = previous;
  }
});
test("credential returned for another account cannot be dispatched", async () => {
  db.query.mockResolvedValueOnce([
    [{ uuid: id, external_account_id: "workplace:client-a" }],
  ]);
  creds.get.mockResolvedValue({
    uuid: "wrong",
    status: "active",
    accessToken: "secret",
  });
  await expect(
    store.credential(1, "client-a", id, "openai", true),
  ).rejects.toThrow(/unavailable/);
});
test("counts provider-reported usage without double counting OpenAI cached/reasoning tokens", () => {
  expect(
    usageTokens("openai", {
      prompt_tokens: 100,
      completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 80 },
      completion_tokens_details: { reasoning_tokens: 20 },
    }),
  ).toBe(140);
  expect(
    usageTokens("anthropic", {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 30,
    }),
  ).toBe(160);
  expect(usageTokens("openai", null)).toBeNull();
  expect(usageTokens("openai", { prompt_tokens: 1 })).toBeNull();
});
test.each([
  "http://vivacitytech.atlassian.net/browse/DRM-9902",
  "https://vivacitytech.atlassian.net.evil/browse/DRM-9902",
  "https://user:token@vivacitytech.atlassian.net/browse/DRM-9902",
  "https://169.254.169.254/browse/DRM-9902",
])("Jira rejects unsafe destinations %s", (url) =>
  expect(() => jira.target(url)).toThrow(),
);
test("Jira keeps the site and issue key together", () =>
  expect(
    jira.target("https://vivacitytech.atlassian.net/browse/DRM-9902"),
  ).toMatchObject({ site: "vivacitytech.atlassian.net", key: "DRM-9902" }));
test("an ambiguous Jira comment is reconciled without repeating the POST", async () => {
  const original = global.fetch;
  try {
    creds.list.mockResolvedValue([
      {
        uuid: id,
        provider: "jira",
        status: "active",
        external_account_id: "vivacitytech.atlassian.net",
      },
    ]);
    creds.get.mockResolvedValue({
      uuid: id,
      kind: "api_key",
      externalAccountId: "vivacitytech.atlassian.net",
      displayName: "user@company.test",
      accessToken: "test-only",
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ startAt: 0, total: 0, comments: [] }),
      });
    const issue = {
      ...jira.target("https://vivacitytech.atlassian.net/browse/DRM-9902"),
      credentialUuid: id,
    };
    await expect(
      jira.postPlan(1, issue, "approved plan", id, "hash", true),
    ).rejects.toThrow(/unresolved/);
    expect(
      global.fetch.mock.calls.every(([, init]) => init.method === "GET"),
    ).toBe(true);
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        startAt: 0,
        total: 1,
        comments: [
          {
            id: "remote-id",
            body: {
              type: "paragraph",
              content: [{ text: `[Athena plan ${id} hash]\napproved plan` }],
            },
          },
        ],
      }),
    });
    expect(
      await jira.postPlan(1, issue, "approved plan", id, "hash", true),
    ).toBe("remote-id");
    expect(
      global.fetch.mock.calls.every(([, init]) => init.method === "GET"),
    ).toBe(true);
  } finally {
    global.fetch = original;
  }
});
test("unknown work run references fail before querying or granting any action", async () => {
  await expect(
    store.normalize(1, { run_uuid: "make-up-a-run" }, false),
  ).rejects.toThrow(/existing Work run/);
  expect(db.query).not.toHaveBeenCalled();
});
test("supporting services come from a fixed catalog and localhost ports map only to configured repositories", () => {
  const ok = v.config({
    ...cfg(),
    services: ["redis"],
    localPorts: [{ port: 8081, repository: "frontend" }],
  });
  expect(ok.services).toEqual(["redis"]);
  expect(ok.localPorts).toEqual([{ port: 8081, repository: "frontend" }]);
  expect(v.config(cfg())).toMatchObject({ services: [], localPorts: [] });
  for (const services of [["mongo"], ["redis:latest"], ["redis", "postgres"]])
    expect(() => v.config({ ...cfg(), services })).toThrow(/only supporting/);
  for (const localPorts of [
    [{ port: 22, repository: "frontend" }],
    [{ port: 8081, repository: "redis" }],
    [{ port: 8081, repository: "frontend" }, { port: 8081, repository: "frontend" }],
  ])
    expect(() => v.config({ ...cfg(), localPorts })).toThrow(/localhost ports/);
});
test("demo sign-in config takes a bare hostname, a test login and a stated role", () => {
  const auth = {
    domain: "Vivacity-Test.us.auth0.com",
    loginCredentialUuid: id,
    role: "Warehouse viewer",
  };
  expect(v.config({ ...cfg(), auth }).auth).toEqual({
    domain: "vivacity-test.us.auth0.com",
    loginCredentialUuid: id,
    role: "Warehouse viewer",
    startLabel: null,
    usernameLabel: "Email address",
    passwordLabel: "Password",
    submitLabel: "Continue",
  });
  expect(v.config(cfg()).auth).toBeNull();
  for (const domain of ["https://x.auth0.com", "x.auth0.com/path", "localhost", "a b.com"])
    expect(() => v.config({ ...cfg(), auth: { ...auth, domain } })).toThrow(/hostname/);
  expect(() => v.config({ ...cfg(), auth: { ...auth, loginCredentialUuid: "" } })).toThrow(/test login/);
  expect(() => v.config({ ...cfg(), auth: { ...auth, role: "" } })).toThrow(/role/);
});
test("only the owner's per-workplace allowlist opens a sign-in domain", () => {
  const before = process.env.WORK_AUTH_DOMAINS;
  try {
    delete process.env.WORK_AUTH_DOMAINS;
    expect(() => store.authorizeAuthDomain(1, id, "t.us.auth0.com")).toThrow(/WORK_AUTH_DOMAINS/);
    process.env.WORK_AUTH_DOMAINS = JSON.stringify({ [id]: { profileId: 1, domains: ["t.us.auth0.com"] } });
    expect(() => store.authorizeAuthDomain(1, id, "t.us.auth0.com")).not.toThrow();
    expect(() => store.authorizeAuthDomain(2, id, "t.us.auth0.com")).toThrow(/WORK_AUTH_DOMAINS/);
    expect(() => store.authorizeAuthDomain(1, id, "prod.us.auth0.com")).toThrow(/WORK_AUTH_DOMAINS/);
    expect(() => store.authorizeAuthDomain(1, "00000000-0000-4000-8000-000000000002", "t.us.auth0.com")).toThrow();
    process.env.WORK_AUTH_DOMAINS = "{not json";
    expect(() => store.authorizeAuthDomain(1, id, "t.us.auth0.com")).toThrow(/invalid/);
  } finally {
    if (before === undefined) delete process.env.WORK_AUTH_DOMAINS;
    else process.env.WORK_AUTH_DOMAINS = before;
  }
});
test("approval summary names the sign-in domain and role when a demo signs in", () => {
  const summary = require("./actions")[1].summarize({
    run_uuid: id,
    issue_key: "DRM-9902",
    plan_hash: "x",
    environment: {
      name: "Dream local",
      repositories: ["Vivacity-Tech/Dream-Frontend@main", "Vivacity-Tech/Dream-Backend@main"],
      backup: "gs://dream-db-exports/sterilized/example.sql.gz",
      signIn: { domain: "vivacity-test.us.auth0.com", role: "Warehouse viewer" },
      recipes: [],
    },
  });
  expect(summary).toContain("signs in at vivacity-test.us.auth0.com as Warehouse viewer");
  expect(summary.length).toBeLessThanOrEqual(500);
});
test("approval summary names the environment, repositories and backup being authorized", () => {
  const summary = require("./actions")[0].summarize({
    run_uuid: id,
    issue_key: "DRM-9902",
    environment: {
      name: "Vivacity / Dream local",
      repositories: ["Vivacity-Tech/Dream-Frontend@main"],
      backup: "gs://dream-db-exports/sterilized/example.sql.gz",
      recipes: [{ id: "tests", kind: "test", command: "npm test" }],
    },
  });
  expect(summary).toContain("DRM-9902");
  expect(summary).toContain('"Vivacity / Dream local"');
  expect(summary).toContain("Vivacity-Tech/Dream-Frontend@main");
  expect(summary).toContain("gs://dream-db-exports/sterilized/example.sql.gz");
  expect(summary.length).toBeLessThanOrEqual(500);
});
test("a runner device token reaches only leased-job routes", async () => {
  jest.resetModules();
  jest.doMock("../../helpers/actor", () => ({
    requireAdultActor: async () => ({ profileId: 1, audience: "adult" }),
  }));
  jest.doMock("@google-cloud/storage", () => ({ Storage: class {} }));
  const c = require("../../controllers/workItems");
  const response = () => {
    const res = { headersSent: false };
    res.set = () => res;
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  };
  const device = { user: { kind: "device", deviceUuid: id }, body: {}, query: {}, params: {}, headers: {} };
  for (const route of [c.setup, c.saveEnvironment, c.createRun, c.propose, c.issueRead, c.download, c.stop]) {
    const res = response();
    await route(device, res);
    expect(res.status).toHaveBeenCalledWith(403);
  }
  const browser = { ...device, user: { kind: "user" } };
  for (const route of [c.claim, c.login]) {
    const res = response();
    await route(browser, res);
    expect(res.status).toHaveBeenCalledWith(403);
  }
  expect(require("../../helpers/db").query).not.toHaveBeenCalled();
});
test("new work actions cannot be granted standing approval", () => {
  for (const action of require("./actions"))
    expect(action.standing).toBe(false);
  expect(require("./actions")[0].params).toEqual({
    run_uuid: expect.any(String),
  });
});
