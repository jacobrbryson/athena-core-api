import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { runDbCheck } from "./dbCheck.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (key) => args[args.indexOf(key) + 1];
const base = (process.env.ATHENA_WORK_API || "").replace(/\/$/, "");
if (
  !/^https:\/\//.test(base) &&
  !/^http:\/\/localhost(?::\d+)?(?:\/|$)/.test(base)
)
  throw new Error(
    "Set ATHENA_WORK_API to the trusted API base: proxy URL plus /api/v1, or a local core API URL.",
  );
const configFile = path.join(here, ".runner-token.json");
let token;
if (args.includes("--pair")) {
  const r = await fetch(`${base}/devices/pair`, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: option("--pair"),
      name: "Work runner",
      platform: "web",
    }),
  });
  if (!r.ok) throw new Error(`Pairing failed: HTTP ${r.status}`);
  const c = await r.json();
  if (!c.device_token) throw new Error("Pairing did not return a device token");
  await fs.writeFile(
    configFile,
    JSON.stringify({ base, token: c.device_token }),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Paired. Token stored locally; revoke this Work runner from Companion to disconnect.",
  );
  process.exit(0);
}
const saved = JSON.parse(await fs.readFile(configFile, "utf8"));
if (saved.base !== base)
  throw new Error("The saved device token belongs to a different API host.");
token = saved.token;
async function api(route, body, lease, raw) {
  const r = await fetch(`${base}/work-items${route}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      "X-Athena-Device-Token": token,
      ...(lease ? { "X-Work-Lease": lease } : {}),
      ...(body !== undefined
        ? { "Content-Type": raw || "application/json" }
        : {}),
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(raw === "download" ? 1800000 : 150000),
  });
  if (!r.ok) {
    const error = await r.json().catch(() => ({}));
    throw new Error(error.message || `Work API HTTP ${r.status}`);
  }
  return raw === "download" ? r : r.json();
}
function command(
  program,
  argv,
  input,
  { timeout = 300000, binary = false } = {},
) {
  return new Promise((resolve, reject) => {
    const p = spawn(program, argv, {
      shell: false,
      windowsHide: true,
      cwd: here,
    });
    let chunks = [],
      bytes = 0,
      error = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error(`${program} timed out`));
    }, timeout);
    p.stdout.on("data", (b) => {
      bytes += b.length;
      if (bytes <= (binary ? 64 * 1024 * 1024 : 2 * 1024 * 1024))
        chunks.push(b);
      else p.kill();
    });
    p.stderr.on("data", (b) => {
      error = (error + b.toString()).slice(-4000);
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      code === 0
        ? resolve(binary ? out : out.toString())
        : reject(
            Object.assign(
              new Error(
                `${program} exited ${code}: ${error || out.toString().slice(-4000)}`,
              ),
              // Failing test runs are evidence, not just an error string.
              { output: `${out.toString().slice(-8000)}\n${error}`.trim() },
            ),
          );
    });
    p.stdin.on("error", () => undefined);
    p.stdin.end(input);
  });
}
const docker = (args, input, options) =>
  command("docker", args, input, options);
const image = "athena-work-runtime:1";
// A cold `npm ci` or a full Jest/CRA suite routinely exceeds five minutes.
const RECIPE_TIMEOUT = 30 * 60 * 1000;
await docker(["image", "inspect", image]);
console.log(
  "Work runner ready. One run at a time; press Ctrl+C to stop polling.",
);
async function processRun(r) {
  const prefix = `athena-work-${r.uuid}`;
  if (!/^athena-work-[a-f0-9-]{36}$/.test(prefix))
    throw new Error("Invalid run identifier");
  const vol = `${prefix}-source`,
    network = `${prefix}-private`,
    egress = `${prefix}-egress`,
    toolbox = `${prefix}-tools`;
  const internalHosts = r.config.repositories.map((x) => x.name);
  const redis = (r.config.services || []).includes("redis")
    ? `${prefix}-redis`
    : null;
  const supporting = [`${prefix}-db`, ...(redis ? [redis] : [])];
  // Sign-in egress exists only while a demo records, and only to the owner-
  // allowed tenant plus Auth0's fixed asset hosts its login page loads from.
  const auth = r.config.auth || null;
  if (auth && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(auth.domain))
    throw new Error("Invalid sign-in domain");
  const authHosts = auth
    ? [
        auth.domain,
        "cdn.auth0.com",
        "cdn.us.auth0.com",
        "cdn.eu.auth0.com",
        "cdn.au.auth0.com",
      ]
    : [];
  const authProxy = `${prefix}-authproxy`;
  const authEnv = auth
    ? [
        "-e",
        "NODE_OPTIONS=--require /opt/work-tools/auth-tunnel.cjs",
        "-e",
        "ATHENA_AUTH_PROXY=authproxy:3128",
        "-e",
        `ATHENA_AUTH_HOSTS=${authHosts.join(",")}`,
      ]
    : [];
  // Both common conventions; app-specific names belong in the reviewed recipes.
  const redisEnv = redis
    ? ["-e", "REDIS_URL=redis://redis:6379", "-e", "REDIS_HOST=redis", "-e", "REDIS_PORT=6379"]
    : [];
  const root = `/runs/${r.uuid}`;
  const lease = r.lease;
  let alive = true;
  const stopContainers = async () => {
    for (const name of [
      ...internalHosts.map((n) => `${prefix}-${n}`),
      ...supporting,
      toolbox,
      `${prefix}-proxy`,
      authProxy,
    ])
      await docker(["stop", name]).catch(() => undefined);
  };
  const heartbeat = setInterval(
    () =>
      api(`${root}/heartbeat`, {}, lease).catch(() => {
        alive = false;
        void stopContainers();
      }),
    30000,
  );
  const check = async () => {
    if (!alive) throw new Error("Run stopped or access revoked");
    await api(`${root}/heartbeat`, {}, lease);
  };
  const exec = async (argv, input, options) => {
    await check();
    return docker(["exec", "-i", toolbox, ...argv], input, options);
  };
  const downloadInto = async (route, target, commandArgs) => {
    await check();
    const response = await api(`${root}${route}`, undefined, lease, "download");
    const p = spawn("docker", ["exec", "-i", target, ...commandArgs], {
      shell: false,
      windowsHide: true,
    });
    let errors = "";
    p.stderr.on("data", (b) => {
      errors = (errors + b).slice(-2000);
    });
    p.stdout.resume();
    const completed = new Promise((resolve, reject) => {
      p.on("error", reject);
      p.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(errors || `Download/extraction exited ${code}`)),
      );
    });
    await Promise.all([
      pipeline(Readable.fromWeb(response.body), p.stdin),
      completed,
    ]);
  };
  const upload = (mime, buffer) =>
    api(`${root}/artifacts`, buffer, lease, mime);
  const recipeArgv = (recipe) => [
    "sh",
    "-lc",
    `cd /workspace/${recipe.repository} && ${recipe.command}`,
  ];
  // Test recipes report pass/fail as evidence instead of ending the run.
  const runTest = async (recipe) => {
    try {
      const output = await exec(recipeArgv(recipe), undefined, {
        timeout: RECIPE_TIMEOUT,
      });
      return { recipe: recipe.id, kind: "test", passed: true, output };
    } catch (e) {
      if (!alive) throw e;
      return {
        recipe: recipe.id,
        kind: "test",
        passed: false,
        output: e.output || e.message,
      };
    }
  };
  const testRecipes = r.config.recipes.filter((x) => x.kind === "test");
  const firewall = async (targets) => {
    const peers = [
      toolbox,
      ...supporting,
      `${prefix}-proxy`,
      authProxy,
      ...internalHosts.map((n) => `${prefix}-${n}`),
    ];
    const addresses = [];
    for (const peer of peers) {
      const records = await docker(["inspect", peer])
        .then(JSON.parse)
        .catch(() => []);
      const ip = records[0]?.NetworkSettings?.Networks?.[network]?.IPAddress;
      if (ip && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) addresses.push(ip);
    }
    if (!addresses.length)
      throw new Error("Cannot establish private peer firewall");
    const rules = [
      "*filter",
      ":OUTPUT DROP [0:0]",
      "-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
      "-A OUTPUT -o lo -j ACCEPT",
      ...addresses.map((ip) => `-A OUTPUT -d ${ip}/32 -j ACCEPT`),
      "COMMIT",
      "",
    ].join("\n");
    for (const target of targets) {
      // Trusted one-shot helper edits only this container's network namespace.
      // Neither the agent nor application receives NET_ADMIN or the Docker socket.
      await docker(
        [
          "run",
          "--rm",
          "--user",
          "0:0",
          "--read-only",
          "--network",
          `container:${target}`,
          "--cap-drop",
          "ALL",
          "--cap-add",
          "NET_ADMIN",
          "--security-opt",
          "no-new-privileges",
          "-i",
          image,
          "iptables-restore",
        ],
        rules,
      );
    }
  };
  const evidence = [];
  try {
    if (r.phase === "preparing") {
      await docker(["volume", "create", vol]);
      await docker(["network", "create", "--internal", network]);
      await docker(["network", "create", egress]);
      // Trusted initialization only: no repository content or credentials exist yet.
      await docker([
        "run",
        "--rm",
        "--user",
        "0:0",
        "--network",
        "none",
        "-v",
        `${vol}:/workspace`,
        image,
        "chown",
        "pwuser:pwuser",
        "/workspace",
      ]);
      await docker([
        "run",
        "-d",
        "--name",
        `${prefix}-proxy`,
        "--network",
        egress,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "256m",
        image,
        "node",
        "/opt/work-tools/proxy.cjs",
        "registry.npmjs.org",
      ]);
      await docker([
        "network",
        "connect",
        "--alias",
        "packages",
        network,
        `${prefix}-proxy`,
      ]);
      const password = randomBytes(24).toString("hex");
      await docker([
        "run",
        "-d",
        "--name",
        `${prefix}-db`,
        "--network",
        network,
        "--network-alias",
        "postgres",
        "--memory",
        "2g",
        "--security-opt",
        "no-new-privileges",
        "-e",
        "POSTGRES_DB=dream",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "postgres:17",
      ]);
      if (redis)
        // Throwaway cache for the run: no persistence, unprivileged, private network only.
        await docker([
          "run",
          "-d",
          "--name",
          redis,
          "--network",
          network,
          "--network-alias",
          "redis",
          "--user",
          "redis",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--memory",
          "256m",
          "redis:7.4",
          "redis-server",
          "--save",
          "",
          "--appendonly",
          "no",
        ]);
      await docker([
        "run",
        "-d",
        "--name",
        toolbox,
        "--network",
        network,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        // Installs, Jest/CRA suites and the demo browser all run here.
        "--memory",
        "4g",
        "--cpus",
        "2",
        "--pids-limit",
        "256",
        "-v",
        `${vol}:/workspace`,
        "-e",
        `PGPASSWORD=${password}`,
        "-e",
        "PGHOST=postgres",
        "-e",
        "PGUSER=postgres",
        "-e",
        "PGDATABASE=dream",
        "-e",
        `DATABASE_URL=postgresql://postgres:${password}@postgres:5432/dream`,
        ...redisEnv,
        image,
        "sleep",
        "infinity",
      ]);
      await firewall([toolbox, ...supporting]);
      for (const repo of r.config.repositories) {
        await exec(["mkdir", "-p", `/workspace/${repo.name}`]);
        await downloadInto(`/source/${repo.name}`, toolbox, [
          "node",
          "/opt/work-tools/unpack.cjs",
          `/workspace/${repo.name}`,
        ]);
        await exec(["git", "-C", `/workspace/${repo.name}`, "init"]);
        await exec(["git", "-C", `/workspace/${repo.name}`, "add", "."]);
        await exec([
          "git",
          "-C",
          `/workspace/${repo.name}`,
          "-c",
          "user.name=Athena Work",
          "-c",
          "user.email=work@localhost",
          "commit",
          "-qm",
          "Approved baseline",
        ]);
      }
      await exec(["mkdir", "-p", "/workspace/evidence"]);
      await downloadInto("/backup", `${prefix}-db`, [
        "sh",
        "-c",
        "cat > /tmp/backup",
      ]);
      for (let tries = 0; ; tries++) {
        try {
          // The runtime image has no PostgreSQL client; the database container does.
          await check();
          await docker(["exec", `${prefix}-db`, "pg_isready", "-U", "postgres", "-d", "dream"]);
          break;
        } catch {
          if (tries >= 30) throw new Error("PostgreSQL did not become ready");
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      const restore =
        r.config.backupFormat === "custom"
          ? [
              "pg_restore",
              "-U",
              "postgres",
              "--no-owner",
              "--no-acl",
              "--exit-on-error",
              "-d",
              "dream",
              "/tmp/backup",
            ]
          : [
              "bash",
              "-o",
              "pipefail",
              "-c",
              `${r.config.backupFormat === "sql.gz" ? "gzip -dc /tmp/backup" : "cat /tmp/backup"} | psql -U postgres -d dream -v ON_ERROR_STOP=1`,
            ];
      await check();
      evidence.push({
        restore: await docker(
          ["exec", "-i", `${prefix}-db`, ...restore],
          undefined,
          { timeout: 1800000 },
        ),
      });
      await docker(["exec", `${prefix}-db`, "rm", "/tmp/backup"]);
      for (const recipe of r.config.recipes.filter((x) =>
        ["install", "build"].includes(x.kind),
      )) {
        evidence.push({
          recipe: recipe.id,
          passed: true,
          output: await exec(
            [
              "env",
              "HTTPS_PROXY=http://packages:3128",
              "HTTP_PROXY=http://packages:3128",
              "npm_config_proxy=http://packages:3128",
              "npm_config_https_proxy=http://packages:3128",
              ...recipeArgv(recipe),
            ],
            undefined,
            { timeout: RECIPE_TIMEOUT },
          ),
        });
      }
      // Package egress closes before application services or model operations start.
      await docker(["stop", `${prefix}-proxy`]);
      for (const recipe of r.config.recipes.filter((x) => x.kind === "start")) {
        await docker([
          "run",
          "-d",
          "--name",
          `${prefix}-${recipe.repository}`,
          "--network",
          network,
          "--network-alias",
          recipe.repository,
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          // A CRA dev server with its type checker needs ~3 GB of heap.
          "--memory",
          "4g",
          "--cpus",
          "2",
          "--pids-limit",
          "256",
          "-v",
          `${vol}:/workspace`,
          "-w",
          `/workspace/${recipe.repository}`,
          "-e",
          `DATABASE_URL=postgresql://postgres:${password}@postgres:5432/dream`,
          "-e",
          "NODE_ENV=test",
          ...redisEnv,
          ...authEnv,
          image,
          "sleep",
          "infinity",
        ]);
      }
      await firewall([
        toolbox,
        ...supporting,
        ...internalHosts.map((n) => `${prefix}-${n}`),
      ]);
      for (const recipe of r.config.recipes.filter((x) => x.kind === "start"))
        await docker([
          "exec",
          "-d",
          `${prefix}-${recipe.repository}`,
          "sh",
          "-lc",
          recipe.command,
        ]);
      for (const url of [r.config.frontendUrl, r.config.backendUrl]) {
        let result;
        for (let tries = 0; ; tries++) {
          try {
            result = await exec([
              "node",
              "-e",
              // Up means "answers HTTP without a server error": not every app has a 200 route at /.
              "fetch(process.argv[1],{signal:AbortSignal.timeout(5000)}).then(r=>{if(r.status>=500)process.exit(1);console.log(r.status)}).catch(()=>process.exit(1))",
              url,
            ]);
            break;
          } catch {
            if (tries >= 24) throw new Error(`Health check failed: ${url}`);
            await new Promise((resolve) => setTimeout(resolve, 2500));
          }
        }
        evidence.push({ health: url, result, passed: true });
      }
      // Pre-existing failures are part of the diagnosis: plan anyway, with the
      // failing output in the evidence, and never report them as passing.
      for (const recipe of testRecipes) evidence.push(await runTest(recipe));
      for (const repo of r.config.repositories) {
        const changes = await exec([
          "git",
          "-C",
          `/workspace/${repo.name}`,
          "status",
          "--porcelain",
        ]);
        if (changes.trim())
          throw new Error(
            `Baseline recipes modified tracked or unignored product files in ${repo.name}. Review the recipes before planning.`,
          );
      }
      await api(
        `${root}/transition`,
        { kind: "baseline", ok: true, evidence },
        lease,
      );
    } else {
      // Same retained volume, toolbox and database are required for approved implementation.
      await docker([
        "start",
        ...supporting,
        toolbox,
        ...internalHosts.map((n) => `${prefix}-${n}`),
      ]);
      // A restarted container gets a fresh network namespace, so rules go back on.
      await firewall([
        toolbox,
        ...supporting,
        ...internalHosts.map((n) => `${prefix}-${n}`),
      ]);
      for (const recipe of r.config.recipes.filter((x) => x.kind === "start"))
        await docker([
          "exec",
          "-d",
          `${prefix}-${recipe.repository}`,
          "sh",
          "-lc",
          recipe.command,
        ]);
      await api(`${root}/comment`, {}, lease);
    }
    let observation = JSON.stringify({
      baseline: evidence,
      files: await exec(
        ["node", "/opt/work-tools/operate.cjs"],
        JSON.stringify({ type: "list" }),
      ),
    });
    let demo = [];
    for (;;) {
      await check();
      const op = await api(`${root}/step`, { observation }, lease);
      if (op.type === "finish") {
        if (r.phase === "preparing") return;
        demo = op.demo;
        break;
      }
      try {
        if (op.type === "test") {
          const recipe = r.config.recipes.find(
            (x) => x.id === op.recipe && x.kind === "test",
          );
          if (!recipe) throw new Error("Recipe outside scope");
          const result = await runTest(recipe);
          observation = `${result.passed ? "Tests passed" : "Tests failed"}:\n${result.output}`;
        } else if (
          ["read", "write", "edit", "list", "search"].includes(op.type)
        ) {
          if (["write", "edit"].includes(op.type) && r.phase !== "implementing")
            throw new Error("Planning cannot write files");
          if (op.path && !internalHosts.includes(op.path.split("/")[0]))
            throw new Error("Path outside configured repositories");
          observation = await exec(
            ["node", "/opt/work-tools/operate.cjs"],
            JSON.stringify(op),
          );
        } else throw new Error("Unknown operation");
      } catch (e) {
        observation = `Operation failed: ${e.message}`;
      }
    }
    // A recipe that passed at baseline and fails now is a regression and blocks.
    // One that already failed at baseline is recorded as still failing.
    const baseline = new Map(
      (Array.isArray(r.checkpoint) ? r.checkpoint : [])
        .filter((e) => e && e.kind === "test")
        .map((e) => [e.recipe, e.passed === true]),
    );
    for (const recipe of testRecipes) {
      const result = await runTest(recipe);
      result.baselinePassed = baseline.get(recipe.id) ?? null;
      evidence.push(result);
      if (!result.passed && result.baselinePassed !== false)
        throw new Error(
          `Test recipe ${recipe.id} fails after the change${result.baselinePassed ? " but passed at baseline" : ""}. Review the retained checkout.`,
        );
    }
    const stillFailing = evidence
      .filter((e) => e.kind === "test" && !e.passed)
      .map((e) => e.recipe);
    await api(
      `${root}/transition`,
      { kind: "verification", ok: true, evidence },
      lease,
    );
    // When the frontend's port is mapped, open it as localhost so the page's
    // origin and its localhost API calls match the developers' setup.
    const localPorts = r.config.localPorts || [];
    const entry = new URL(r.config.frontendUrl);
    if (
      localPorts.some(
        (m) => m.repository === entry.hostname && String(m.port) === entry.port,
      )
    )
      entry.hostname = "localhost";
    let login = null;
    if (auth) {
      await docker(["rm", "-f", authProxy]).catch(() => undefined);
      await docker([
        "run",
        "-d",
        "--name",
        authProxy,
        "--network",
        egress,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "256m",
        image,
        "node",
        "/opt/work-tools/proxy.cjs",
        ...authHosts,
      ]);
      await docker([
        "network",
        "connect",
        "--alias",
        "authproxy",
        network,
        authProxy,
      ]);
      // Peers now include the sign-in proxy; nothing else outside is reachable.
      await firewall([
        toolbox,
        ...supporting,
        ...internalHosts.map((n) => `${prefix}-${n}`),
      ]);
      login = await api(`${root}/login`, {}, lease);
    }
    let checks;
    try {
      // The login travels on stdin only: never argv, env, the model or logs.
      checks = await exec(
        ["node", "/opt/work-tools/browser.mjs"],
        JSON.stringify({
          url: entry.toString(),
          hosts: internalHosts,
          localPorts,
          steps: demo,
          ...(auth
            ? {
                proxy: "http://authproxy:3128",
                authHosts,
                login: {
                  ...login,
                  startLabel: auth.startLabel,
                  usernameLabel: auth.usernameLabel,
                  passwordLabel: auth.passwordLabel,
                  submitLabel: auth.submitLabel,
                },
              }
            : {}),
        }),
      );
    } finally {
      login = null;
      if (auth) await docker(["stop", authProxy]).catch(() => undefined);
    }
    // Whole sentences only, within the 800-character speech limit; the opening
    // and the closing review reminder are always kept.
    const opening = `${r.issue.key}. This walkthrough runs against the isolated application and restored test database. ${stillFailing.length ? `Tests that already failed before this change still fail: ${stillFailing.join(", ")}. No previously passing test fails.` : "The configured automated tests passed."}${auth ? ` I sign in as the ${auth.role} test user.` : ""}`;
    const closing = "Please review the evidence against all acceptance criteria.";
    let narration = opening;
    for (const sentence of demo.map((s) =>
      s.type === "click"
        ? `I click ${s.label}.`
        : s.type === "fill"
          ? `I enter a test value in ${s.label}.`
          : `The browser verified ${s.text}, checking ${s.criterion}.`,
    )) {
      if (`${narration} ${sentence} ${closing}`.length > 790) break;
      narration += ` ${sentence}`;
    }
    narration = `${narration} ${closing}`.slice(0, 800);
    const audio = await api(`${root}/speech`, { text: narration }, lease);
    const pcm = Buffer.from(audio.audioBase64, "base64");
    const sampleRate = audio.sampleRate || 24000;
    await exec(
      ["sh", "-c", "cat > /workspace/evidence/narration.pcm"],
      pcm,
    );
    // Playwright's WebM has no reliable duration header; read the last frame time.
    const frameTimes = await exec([
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "packet=pts_time",
      "-of",
      "csv=p=0",
      "/workspace/evidence/walkthrough.webm",
    ]);
    const videoSeconds = Math.max(
      0,
      ...frameTimes
        .split("\n")
        .map(Number)
        .filter((t) => Number.isFinite(t)),
    );
    const audioSeconds = pcm.length / 2 / sampleRate;
    // Neither stream may cut the other short: hold the last frame while the
    // narration finishes, pad silence while the walkthrough finishes.
    const seconds = Math.max(videoSeconds, audioSeconds) + 0.5;
    await exec([
      "ffmpeg",
      "-y",
      "-i",
      "/workspace/evidence/walkthrough.webm",
      "-f",
      "s16le",
      "-ar",
      String(sampleRate),
      "-ac",
      "1",
      "-i",
      "/workspace/evidence/narration.pcm",
      "-filter_complex",
      `[0:v]tpad=stop_mode=clone:stop_duration=${Math.ceil(seconds)}[v];[1:a]apad[a]`,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-t",
      seconds.toFixed(2),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      "/workspace/evidence/demo.mp4",
    ]);
    await upload(
      "video/mp4",
      await exec(["cat", "/workspace/evidence/demo.mp4"], undefined, {
        binary: true,
      }),
    );
    let patch = "";
    for (const repo of r.config.repositories) {
      await exec(["git", "-C", `/workspace/${repo.name}`, "add", "-N", "."]);
      patch +=
        `\n# Repository: ${repo.name}\n` +
        (await exec([
          "git",
          "-C",
          `/workspace/${repo.name}`,
          "diff",
          "--binary",
          "HEAD",
        ]));
    }
    await upload("text/x-diff", Buffer.from(patch));
    await upload(
      "application/json",
      Buffer.from(
        JSON.stringify(
          {
            tests: evidence,
            browser: JSON.parse(checks),
            acceptance:
              "Browser assertions verify the listed criteria. Unlisted criteria and final acceptance require human review.",
          },
          null,
          2,
        ),
      ),
    );
    await api(`${root}/transition`, { kind: "complete", ok: true }, lease);
  } catch (e) {
    console.error(`${r.issue.key}: ${e.message}`);
    await api(
      `${root}/transition`,
      { kind: "blocked", reason: e.message.slice(0, 500) },
      lease,
    ).catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
    // Preserve source/database for review, but never leave application processes running.
    await stopContainers();
  }
}
for (;;) {
  try {
    const { run } = await api("/claim", {});
    if (run) await processRun(run);
    else {
      const { check } = await api("/review-checks/claim", {});
      if (check)
        await api(
          `/review-checks/${check.uuid}/finish`,
          await runDbCheck(check, docker),
        );
    }
  } catch (e) {
    console.error(e.message);
  }
  await new Promise((resolve) => setTimeout(resolve, 10000));
}
