// Real Docker, synthetic data: a good file, then a failing file, then one that
// must not run. Proves the container has no network and leaves nothing behind.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { runDbCheck } from "../dbCheck.mjs";
const docker = async (args, input, { timeout = 300000, binary = false } = {}) => {
  const r = spawnSync("docker", args, { input, timeout, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0)
    throw Object.assign(new Error(`docker ${args[0]} failed`), {
      output: `${r.stdout}\n${r.stderr}`.trim(),
    });
  return binary ? r.stdout : r.stdout.toString();
};
const dump = `CREATE TABLE public.repair (id int PRIMARY KEY, priority int DEFAULT 0);
ALTER TABLE public.repair OWNER TO someone_missing;
INSERT INTO public.repair (id) SELECT generate_series(1,5);
`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "athena-check-"));
await fs.mkdir(path.join(root, "acme"));
await fs.writeFile(path.join(root, "acme", "sterilized.sql.gz"), gzipSync(dump));
const uuid = "abcdefab-2222-4333-8444-555555555555";
const networkProbe = `DO $$ BEGIN RAISE NOTICE 'probe'; END $$;
COPY (SELECT 1) TO PROGRAM 'cat /sys/class/net/*/operstate >/tmp/net; ls /sys/class/net > /tmp/ifaces';
CREATE TABLE public.ifaces (name text);
COPY public.ifaces FROM '/tmp/ifaces';`;
try {
  const result = await runDbCheck(
    {
      uuid,
      owner: "acme",
      files: [
        {
          path: "a.sql",
          sql: `ALTER TABLE public.repair ADD COLUMN warranty date;
UPDATE public.repair SET priority = 1 WHERE id = 1;
DELETE FROM public.repair WHERE id = 2;
${networkProbe}`,
        },
        { path: "b.sql", sql: "SELECT * FROM public.does_not_exist;" },
        { path: "c.sql", sql: "DROP TABLE public.repair;" },
      ],
    },
    docker,
    root,
  );
  console.log(JSON.stringify(result, null, 1));
  assert.equal(result.failure, undefined);
  assert.equal(result.tables, 1);
  assert.deepEqual(result.restoreErrors, []);
  assert.deepEqual(result.files.map((f) => f.ok), [true, false]);
  assert.match(result.files[1].output, /does_not_exist/);
  assert.deepEqual(result.notRun, ["c.sql"]);
  assert.match(result.schemaChanges, /\+ .*warranty date/);
  assert.ok(result.rowChanges.some((r) => r.table === "public.repair" && r.before === 5 && r.after === 4));
  // The file listed the container's interfaces: loopback alone means no network.
  assert.ok(result.rowChanges.some((r) => r.table === "public.ifaces" && r.after === 1));
  const left = await docker(["ps", "-a", "--filter", `name=athena-review-${uuid}`, "--format", "{{.Names}}"]);
  assert.equal(left.trim(), "");
  console.log("Database check smoke test passed.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
