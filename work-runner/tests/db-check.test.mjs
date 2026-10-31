import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  newestBackup,
  rowChanges,
  runDbCheck,
  schemaChanges,
} from "../dbCheck.mjs";
const uuid = "11111111-2222-4333-8444-555555555555";
test("picks the newest backup in that company's folder only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "athena-check-"));
  try {
    await fs.mkdir(path.join(root, "acme"));
    await fs.mkdir(path.join(root, "other"));
    const older = path.join(root, "acme", "old.sql");
    const newer = path.join(root, "acme", "new.sql");
    await fs.writeFile(older, "x");
    await fs.writeFile(newer, "x");
    await fs.utimes(older, new Date("2026-01-01"), new Date("2026-01-01"));
    await fs.writeFile(path.join(root, "other", "theirs.sql"), "x");
    assert.equal((await newestBackup(root, "Acme")).file, newer);
    assert.equal(await newestBackup(root, "nobody"), null);
    assert.equal(await newestBackup(root, "../other"), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("schema changes ignore pg_dump's comments and restrict tokens", () => {
  const before = "-- dumped\n\\restrict aaa\nCREATE TABLE a (\n    id int\n);\n";
  const after =
    "-- dumped later\n\\restrict bbb\nCREATE TABLE a (\n    id int,\n    b text\n);\n";
  assert.equal(schemaChanges(before, after), "-     id int\n+     id int,\n+     b text");
  assert.equal(schemaChanges(before, before), "");
});
test("row changes list only tables that moved, including new ones", () => {
  assert.deepEqual(rowChanges("public.a|1\npublic.b|2\n", "public.a|5\npublic.b|2\npublic.c|3\n"), [
    { table: "public.a", before: 1, after: 5 },
    { table: "public.c", before: 0, after: 3 },
  ]);
});
test("no backup means no container and a plain failure", async () => {
  const calls = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "athena-check-"));
  const result = await runDbCheck(
    { uuid, owner: "acme", files: [] },
    async (a) => calls.push(a),
    root,
  );
  await fs.rm(root, { recursive: true, force: true });
  assert.match(result.failure, /No backup/);
  assert.equal(calls.length, 0);
});
