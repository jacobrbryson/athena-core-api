import { chromium } from "playwright";
import fs from "node:fs/promises";
import net from "node:net";
let input = "";
for await (const b of process.stdin) input += b;
const cfg = JSON.parse(input);
const base = new URL(cfg.url);
// localhost:<port> in this container forwards to that repository's service on
// the private network, so apps configured for localhost reach their own backend.
const forwarded = new Set();
for (const { port, repository } of cfg.localPorts || []) {
  if (
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !cfg.hosts.includes(repository)
  )
    throw new Error("Invalid localhost mapping");
  const server = net.createServer((client) => {
    const upstream = net.connect(port, repository);
    client.pipe(upstream).pipe(client);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(port, "127.0.0.1", resolve),
  );
  server.unref();
  forwarded.add(String(port));
}
const isForwarded = (u) =>
  ["localhost", "127.0.0.1"].includes(u.hostname) && forwarded.has(u.port);
// Sign-in only: the login is typed here and never echoed into results or logs.
const login = cfg.login || null;
delete cfg.login;
const authHosts = new Set(login ? cfg.authHosts || [] : []);
const secrets = login?.password ? [login.password] : [];
const redact = (text) =>
  secrets.reduce((t, s) => t.split(s).join("[redacted]"), String(text));
// Playwright otherwise forces localhost through the proxy, which would send the
// app's own localhost-mapped traffic out to the sign-in proxy and fail.
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = "1";
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage"],
  // Only HTTPS to the sign-in hosts uses the proxy; the app stays direct.
  ...(login && cfg.proxy
    ? {
        proxy: {
          server: cfg.proxy,
          bypass: ["localhost", "127.0.0.1", ...cfg.hosts].join(","),
        },
      }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: {
    dir: "/workspace/evidence",
    size: { width: 1280, height: 720 },
  },
});
// All browser traffic stays on the job's private services; never follow a live link.
await context.route("**/*", (route) => {
  try {
    const u = new URL(route.request().url());
    if (
      (u.protocol === "http:" &&
        (cfg.hosts.includes(u.hostname) || isForwarded(u))) ||
      (u.protocol === "https:" && authHosts.has(u.hostname))
    )
      return route.continue();
  } catch {}
  return route.abort();
});
const page = await context.newPage();
const results = [];
try {
  const response = await page.goto(base.href, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  results.push({ check: "frontend responds", passed: !!response?.ok() });
  if (login) {
    const tenant = cfg.authHosts[0];
    if (login.startLabel)
      await page
        .getByRole("button", { name: login.startLabel, exact: true })
        .or(page.getByRole("link", { name: login.startLabel, exact: true }))
        .first()
        .click({ timeout: 15000 });
    await page.waitForURL((u) => u.hostname === tenant, { timeout: 30000 });
    await page.getByLabel(login.usernameLabel).first().fill(login.username, { timeout: 15000 });
    const password = page.getByLabel(login.passwordLabel).first();
    const submit = () =>
      page.getByRole("button", { name: login.submitLabel, exact: true }).first().click({ timeout: 15000 });
    // Identifier-first pages ask for the password on a second screen.
    if (!(await password.isVisible().catch(() => false))) await submit();
    await password.fill(login.password, { timeout: 15000 });
    await submit();
    await page.waitForURL((u) => !authHosts.has(u.hostname), { timeout: 45000 });
    await page.waitForLoadState("domcontentloaded");
    results.push({ check: "signed in with the test login", passed: true });
  }
  // A supplied scenario is approved plan data, constrained to same-origin UI operations.
  for (const s of cfg.steps || []) {
    if (s.type === "click")
      await page
        .getByRole(s.role === "link" ? "link" : "button", {
          name: s.label,
          exact: true,
        })
        .click({ timeout: 15000 });
    else if (s.type === "fill")
      await page
        .getByLabel(s.label, { exact: true })
        .fill(s.value, { timeout: 15000 });
    else if (s.type === "assert") {
      await page
        .getByText(s.text, { exact: true })
        .waitFor({ state: "visible", timeout: 15000 });
      results.push({ criterion: s.criterion, check: s.text, passed: true });
    } else throw new Error("Unsupported demo step");
  }
  await page.screenshot({ path: "/workspace/evidence/final.png" });
  await page.waitForTimeout(2500);
} catch (e) {
  results.push({ check: redact(e.message), passed: false });
}
login && (login.password = login.username = null);
const video = page.video();
await context.close();
await video.saveAs("/workspace/evidence/walkthrough.webm");
await browser.close();
await fs.writeFile(
  "/workspace/evidence/browser.json",
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results));
if (results.some((r) => !r.passed)) process.exitCode = 1;
