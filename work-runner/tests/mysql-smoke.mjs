// Validate the additive migration against a disposable, network-isolated MySQL.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
const name = `athena-work-mysql-smoke-${process.pid}`;
function docker(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn("docker", args, { shell: false, windowsHide: true });
    let out = "",
      error = "";
    p.stdout.on("data", (b) => {
      out += b;
    });
    p.stderr.on("data", (b) => {
      error += b;
    });
    p.on("error", reject);
    p.on("close", (c) =>
      c === 0 ? resolve(out) : reject(new Error(error || out)),
    );
    p.stdin.end(input);
  });
}
try {
  await docker([
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "none",
    "--memory",
    "768m",
    "-e",
    "MYSQL_ALLOW_EMPTY_PASSWORD=yes",
    "mysql:8.4",
  ]);
  for (let i = 0; ; i++) {
    try {
      const port = await docker([
        "exec",
        name,
        "mysql",
        "-uroot",
        "-N",
        "-e",
        "SELECT @@port",
      ]);
      // The image starts a temporary socket-only server while initializing and
      // then restarts it. Do not run a migration against that temporary server.
      if (port.trim() !== "3306") throw new Error("Still initializing");
      break;
    } catch {
      if (i >= 60) throw new Error("Fixture MySQL did not start");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const migration = await fs.readFile(
    new URL("../../db/migrations/0099_work_items.up.sql", import.meta.url),
    "utf8",
  );
  const result = await docker(
    ["exec", "-i", name, "mysql", "-uroot", "--batch"],
    `CREATE DATABASE fixture; USE fixture;\n${migration}\nSHOW TABLES;\nINSERT INTO athena_work_run (uuid,profile_id,environment_uuid,workplace_uuid,issue_json,config_json,phase) VALUES ('test-run',1,'test-env','test-client',JSON_OBJECT('key','FIXTURE-1'),JSON_OBJECT('runnerUuid','test-device'),'queued');\nUPDATE athena_work_run SET phase='preparing',lease_token='fixture-token',lease_until=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 3 MINUTE) WHERE uuid='test-run' AND phase='queued';\nSELECT phase,JSON_UNQUOTE(JSON_EXTRACT(config_json,'$.runnerUuid')) AS runner FROM athena_work_run;`,
  );
  assert.match(result, /athena_work_environment/);
  assert.match(result, /preparing\s+test-device/);
  const down = await fs.readFile(
    new URL("../../db/migrations/0099_work_items.down.sql", import.meta.url),
    "utf8",
  );
  await docker(["exec", "-i", name, "mysql", "-uroot", "fixture"], down);
  console.log(
    "PASS: migration 0099 creates its tables, JSON configuration and leased run transitions work, and rollback succeeds on isolated MySQL 8.4.",
  );
} finally {
  await docker(["rm", "-fv", name]).catch(() => undefined);
}
