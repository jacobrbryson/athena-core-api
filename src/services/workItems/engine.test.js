jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../credentials", () => ({}));
jest.mock("../parent-helpers", () => ({
  withTransaction: (fn) => fn(require("../../helpers/db")),
}));
jest.mock("../llm/adapters/workProvider", () => ({ generate: jest.fn() }));
const db = require("../../helpers/db");
const store = require("./store");
const model = require("../llm/adapters/workProvider");
const engine = require("./engine");
function run(implementing = false) {
  return {
    uuid: "run",
    profile_id: 1,
    workplace_uuid: "client",
    phase: implementing ? "implementing" : "planning",
    implementation_uuid: implementing ? "approved-implementation" : null,
    lease_token: "lease",
    lease_until: new Date(Date.now() + 120000),
    model_steps: 0,
    events: [],
    issue: {
      key: "FIXTURE-1",
      title: "Fixture",
      descriptionText: "A fixture request",
    },
    config: {
      provider: "openai",
      model: "chosen-model",
      modelCredentialUuid: "company-key-id",
      tokenLimit: 150000,
      repositories: [{ name: "frontend" }],
      recipes: [{ id: "tests", kind: "test" }],
    },
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue([{ affectedRows: 1 }]);
  jest
    .spyOn(store, "credential")
    .mockResolvedValue({ accessToken: "test-only-company-key" });
});
afterEach(() => jest.restoreAllMocks());
test("planning finishes in review, records actual company usage, and does not implement or post to Jira", async () => {
  const r = run();
  jest.spyOn(store, "get").mockResolvedValue(r);
  model.generate.mockResolvedValue({
    text: JSON.stringify({ type: "finish", text: "A concrete reviewed plan" }),
    usage: { prompt_tokens: 20, completion_tokens: 30 },
  });
  const op = await engine.step(r, "baseline passed");
  expect(op.type).toBe("finish");
  expect(model.generate).toHaveBeenCalledWith(
    expect.objectContaining({
      apiKey: "test-only-company-key",
      provider: "openai",
    }),
  );
  expect(
    db.query.mock.calls.some(([sql]) =>
      sql.includes("phase='awaiting_review'"),
    ),
  ).toBe(true);
  expect(
    db.query.mock.calls.some(
      ([sql, args]) =>
        sql.includes("tokens_used=tokens_used+") && args[1] === 50,
    ),
  ).toBe(true);
  expect(
    db.query.mock.calls.some(([sql]) => sql.includes("comment_state")),
  ).toBe(false);
});
test("a forbidden model write during planning is charged but never returned for execution", async () => {
  const r = run();
  jest.spyOn(store, "get").mockResolvedValue(r);
  model.generate.mockResolvedValue({
    text: JSON.stringify({
      type: "write",
      path: "frontend/src/x.ts",
      content: "unauthorized edit",
    }),
    usage: { prompt_tokens: 20, completion_tokens: 30 },
  });
  await expect(engine.step(r, "source")).rejects.toThrow(
    /unsupported operation/,
  );
  expect(
    db.query.mock.calls.some(([sql]) =>
      sql.includes("tokens_used=tokens_used+"),
    ),
  ).toBe(true);
  expect(
    db.query.mock.calls.some(([, args]) =>
      args?.includes("operation_proposed"),
    ),
  ).toBe(false);
});
test("ambiguous provider failure retains its reservation and blocks instead of spending another payer", async () => {
  model.generate.mockRejectedValue(new Error("timeout"));
  await expect(engine.step(run(), "source")).rejects.toThrow(
    /billing outcome is unknown/,
  );
  expect(model.generate).toHaveBeenCalledTimes(1);
  expect(
    db.query.mock.calls.some(([sql]) => sql.includes("state='unknown'")),
  ).toBe(true);
  expect(
    db.query.mock.calls.some(([sql]) =>
      sql.includes("tokens_reserved=tokens_reserved-"),
    ),
  ).toBe(false);
});
test("stop during a provider call records usage and refuses to return a file operation", async () => {
  const r = run(true);
  jest
    .spyOn(store, "get")
    .mockResolvedValue({ ...r, phase: "cancelled", lease_token: null });
  model.generate.mockResolvedValue({
    text: JSON.stringify({
      type: "write",
      path: "frontend/src/x.ts",
      content: "late edit",
    }),
    usage: { prompt_tokens: 20, completion_tokens: 30 },
  });
  await expect(engine.step(r, "source")).rejects.toThrow(
    /stopped or lease expired/,
  );
  expect(
    db.query.mock.calls.some(([, args]) =>
      args?.includes("operation_proposed"),
    ),
  ).toBe(false);
});
