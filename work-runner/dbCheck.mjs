// Tries a pull request's SQL on a throwaway PostgreSQL restored from a backup
// that stays on this computer. The container has no network at all: the backup
// goes in with `docker cp`, everything else over `docker exec`, and it is
// removed with its data afterwards. Only the outcome returns to the core API.
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const FILE_TIMEOUT = 150000;
const DEADLINE = 6 * 60 * 1000;
const SYSTEM = "('pg_catalog','information_schema','pg_toast')";
const psql = ["psql", "-U", "postgres", "-d", "dream", "-X", "-q"];
export const backupRoot = () =>
  process.env.ATHENA_DB_BACKUPS ||
  path.join(os.homedir(), ".athena-work", "db-backups");
// One folder per GitHub owner, so one company's PR can't touch another's data.
export async function newestBackup(root, owner) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(owner)) return null;
  const dir = path.join(root, owner.toLowerCase());
  const names = await fs.readdir(dir).catch(() => []);
  const files = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const stat = await fs.stat(file);
    if (stat.isFile()) files.push({ file, modified: stat.mtime });
  }
  return files.sort((a, b) => b.modified - a.modified)[0] || null;
}
// Compared as lines: pg_dump's order is stable, and a reader wants what changed.
export function schemaChanges(before, after, max = 8000) {
  const lines = (dump) =>
    dump
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith("--") && !l.startsWith("\\"));
  const count = (list) => {
    const seen = new Map();
    for (const l of list) seen.set(l, (seen.get(l) || 0) + 1);
    return seen;
  };
  const was = count(lines(before)),
    now = count(lines(after));
  const changes = [];
  for (const l of lines(before)) {
    if ((now.get(l) || 0) > 0) now.set(l, now.get(l) - 1);
    else changes.push(`- ${l}`);
  }
  for (const l of lines(after)) {
    if ((was.get(l) || 0) > 0) was.set(l, was.get(l) - 1);
    else changes.push(`+ ${l}`);
  }
  const text = changes.join("\n");
  return text.length > max ? `${text.slice(0, max)}\n(cut short)` : text;
}
export function rowChanges(before, after) {
  const read = (text) =>
    new Map(
      text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => l.split("|"))
        .map(([table, n]) => [table, Number(n)]),
    );
  const was = read(before),
    now = read(after);
  return [...new Set([...was.keys(), ...now.keys()])]
    .filter((t) => was.get(t) !== now.get(t))
    .sort()
    .map((table) => ({
      table,
      before: was.get(table) ?? 0,
      after: now.get(table) ?? 0,
    }));
}
export async function runDbCheck(check, docker, root = backupRoot()) {
  if (!/^[a-f0-9-]{36}$/.test(check.uuid)) throw new Error("Invalid review");
  const backup = await newestBackup(root, check.owner);
  if (!backup) {
    console.warn(`No backup under ${path.join(root, check.owner.toLowerCase())}`);
    return { failure: "No backup is on the runner for this company." };
  }
  const db = `athena-review-${check.uuid}`;
  const exec = (argv, input, options) =>
    docker(["exec", "-i", db, ...argv], input, options);
  const inside = (script, options) =>
    exec(["bash", "-c", script], undefined, options);
  const started = Date.now();
  try {
    await docker([
      "run",
      "-d",
      "--rm",
      "--name",
      db,
      "--network",
      "none",
      "--memory",
      "2g",
      "--cpus",
      "2",
      "--pids-limit",
      "256",
      "--security-opt",
      "no-new-privileges",
      "-e",
      "POSTGRES_DB=dream",
      "-e",
      `POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}`,
      "postgres:17",
    ]);
    // TCP, because the image's first-run server is socket-only and restarts.
    for (let tries = 0; ; tries++) {
      try {
        await exec(["pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "dream"]);
        break;
      } catch {
        if (tries >= 30) throw new Error("PostgreSQL did not become ready.");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    await docker(["cp", backup.file, `${db}:/tmp/backup`]);
    await inside(
      `if [ "$(head -c2 /tmp/backup | od -An -tx1 | tr -d ' ')" = "1f8b" ]; then gzip -dc < /tmp/backup > /tmp/plain && mv /tmp/plain /tmp/backup; fi`,
    );
    // Dumps name roles this database lacks; a real failure shows up in the rest.
    const restored = await inside(
      `set -o pipefail; if [ "$(head -c5 /tmp/backup)" = "PGDMP" ]; then pg_restore -U postgres --no-owner --no-acl -d dream /tmp/backup; else ${psql.join(" ")} -f /tmp/backup; fi 2>&1 >/dev/null | grep -E 'ERROR|error:' | grep -v 'role .* does not exist' | tail -n 10; true`,
      { timeout: 300000 },
    );
    await exec(["rm", "/tmp/backup"]);
    const restoreErrors = restored.split("\n").filter(Boolean);
    const tables = Number(
      await exec([
        ...psql,
        "-At",
        "-c",
        `SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ${SYSTEM}`,
      ]),
    );
    if (!tables)
      return { failure: "The backup restored no tables.", restoreErrors };
    const schema = () =>
      exec(
        ["pg_dump", "-U", "postgres", "-d", "dream", "--schema-only", "--no-owner", "--no-privileges"],
        undefined,
        { binary: true },
      ).then(String);
    const rows = async () => {
      await exec([...psql, "-c", "ANALYZE"]);
      return exec([
        ...psql,
        "-At",
        "-c",
        `SELECT n.nspname||'.'||c.relname, greatest(c.reltuples::bigint,0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ${SYSTEM}`,
      ]);
    };
    const [schemaBefore, rowsBefore] = [await schema(), await rows()];
    const files = [],
      notRun = [];
    for (const f of check.files) {
      if (files.some((x) => !x.ok) || Date.now() - started > DEADLINE) {
        notRun.push(f.path);
        continue;
      }
      const at = Date.now();
      try {
        const output = await exec(
          [...psql, "-v", "ON_ERROR_STOP=1"],
          f.sql,
          { timeout: FILE_TIMEOUT },
        );
        files.push({ path: f.path, ok: true, ms: Date.now() - at, output: output.slice(-1200) });
      } catch (e) {
        files.push({
          path: f.path,
          ok: false,
          ms: Date.now() - at,
          output: String(e.output || e.message).slice(-1200),
        });
      }
    }
    return {
      backupDate: backup.modified.toISOString().slice(0, 10),
      tables,
      restoreErrors,
      files,
      notRun,
      schemaChanges: schemaChanges(schemaBefore, await schema()),
      rowChanges: rowChanges(rowsBefore, await rows()).slice(0, 50),
    };
  } catch (e) {
    console.error(`Database check ${check.uuid}: ${e.message}`);
    return { failure: "The disposable database could not be prepared." };
  } finally {
    await docker(["rm", "-f", "-v", db]).catch(() => undefined);
  }
}
