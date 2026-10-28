import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { main, safe } = createRequire(import.meta.url)("../tools/operate.cjs");
test("file broker handles bounded source edits and refuses secrets and traversal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "athena-work-test-"));
  try {
    await main(
      {
        type: "write",
        path: "frontend/src/example.ts",
        content: "export const x = 1;",
      },
      root,
    );
    assert.equal(
      await main({ type: "read", path: "frontend/src/example.ts" }, root),
      "export const x = 1;",
    );
    assert.match(
      await main({ type: "list" }, root),
      /frontend\/src\/example.ts/,
    );
    assert.match(
      await main({ type: "search", query: "const x" }, root),
      /example.ts:1/,
    );
    await main(
      {
        type: "edit",
        path: "frontend/src/example.ts",
        oldText: "x = 1",
        newText: "x = 2",
      },
      root,
    );
    assert.equal(
      await main({ type: "read", path: "frontend/src/example.ts" }, root),
      "export const x = 2;",
    );
    await assert.rejects(() =>
      main(
        {
          type: "edit",
          path: "frontend/src/example.ts",
          oldText: "not present",
          newText: "no",
        },
        root,
      ),
    );
    for (const p of [
      "../outside",
      "/etc/passwd",
      "frontend/.env.production",
      "frontend/.git/config",
      "frontend/.npmrc",
      "frontend/secrets.json",
    ])
      await assert.rejects(() => safe(root, p, true));
    await assert.rejects(() =>
      main({ type: "shell", command: "echo forbidden" }, root),
    );
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
test("file broker refuses symlink escapes", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "athena-work-link-test-"),
  );
  try {
    try {
      await fs.symlink(os.tmpdir(), path.join(root, "outside"), "junction");
    } catch (e) {
      if (["EPERM", "EACCES"].includes(e.code))
        return t.skip("Host does not permit symlink creation");
      throw e;
    }
    await assert.rejects(
      () =>
        main(
          { type: "write", path: "outside/escaped.txt", content: "no" },
          root,
        ),
      /Symbolic/,
    );
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
