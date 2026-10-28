const { createHash } = require("node:crypto");
const bad = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const json = (value) => (typeof value === "string" ? JSON.parse(value) : value);
const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
function text(value, max, label) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw bad(`${label} is required (up to ${max} characters).`);
  return value.trim();
}
function path(value) {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^[a-zA-Z0-9_./@-]+$/.test(value) ||
    value.startsWith("/") ||
    value
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /^\.(?:git|github|env(?:\..*)?|npmrc|aws|ssh|codex|agents)$/i.test(p),
      ) ||
    /(^|\/)(?:AGENTS\.md|Dockerfile|docker-compose[^/]*|compose\.ya?ml|(?:credentials|secrets|serviceaccount)[^/]*|[^/]*\.(?:pem|key))$/i.test(
      value,
    )
  )
    throw bad("That file path is outside the work operation scope.");
  return value;
}
function config(raw) {
  if (
    !raw ||
    !uuid(raw.runnerUuid) ||
    !uuid(raw.jiraCredentialUuid) ||
    !uuid(raw.modelCredentialUuid) ||
    !uuid(raw.githubCredentialUuid)
  )
    throw bad(
      "Select a paired runner and Jira, GitHub and company model credentials.",
    );
  const provider = raw.provider;
  if (!["openai", "anthropic"].includes(provider))
    throw bad("Choose OpenAI or Anthropic.");
  if (
    !Array.isArray(raw.repositories) ||
    raw.repositories.length < 1 ||
    raw.repositories.length > 4
  )
    throw bad("Choose one to four repositories.");
  const repos = raw.repositories.map((r) => {
    const match =
      /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
        r.url || "",
      );
    if (!match || match[1] === "." || match[2] === ".")
      throw bad("Use a GitHub repository URL.");
    const name = text(r.name, 40, "Repository directory");
    if (
      !/^[a-z][a-z0-9-]*$/.test(name) ||
      ["postgres", "packages", "evidence", "tools", "redis"].includes(name)
    )
      throw bad(
        "Use a lowercase repository name distinct from reserved services.",
      );
    const ref = text(r.ref, 100, "Branch or revision");
    if (!/^[\w./-]+$/.test(ref) || ref.includes("..") || ref.startsWith("-"))
      throw bad("Invalid repository revision.");
    return {
      name,
      full: `${match[1]}/${match[2]}`,
      url: `https://github.com/${match[1]}/${match[2]}`,
      ref,
    };
  });
  if (new Set(repos.map((r) => r.name)).size !== repos.length)
    throw bad("Repository directory names must be unique.");
  const backup = text(raw.backup, 300, "GCS backup object");
  if (
    !/^gs:\/\/[a-z0-9][a-z0-9_.-]+\/[\w./-]+$/.test(backup) ||
    backup.endsWith("/") ||
    backup.includes("..")
  )
    throw bad("Choose an exact GCS backup object, not just a folder.");
  if (!["sql", "sql.gz", "custom"].includes(raw.backupFormat))
    throw bad("Choose the backup format.");
  if (
    !Array.isArray(raw.recipes) ||
    !raw.recipes.length ||
    raw.recipes.length > 12
  )
    throw bad("Add the development build, test and start recipes.");
  const recipes = raw.recipes.map((r) => {
    if (
      !repos.some((repo) => repo.name === r.repository) ||
      !["install", "build", "test", "start"].includes(r.kind)
    )
      throw bad("Recipe repository or kind is invalid.");
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(r.id || ""))
      throw bad("Recipe IDs must be lowercase names.");
    return {
      id: r.id,
      repository: r.repository,
      kind: r.kind,
      command: text(r.command, 500, "Reviewed recipe command"),
    };
  });
  if (
    new Set(recipes.map((r) => r.id)).size !== recipes.length ||
    !recipes.some((r) => r.kind === "test")
  )
    throw bad("Use unique recipe IDs and at least one test recipe.");
  if (
    repos.some(
      (repo) =>
        recipes.filter((r) => r.repository === repo.name && r.kind === "start")
          .length !== 1,
    )
  )
    throw bad("Configure exactly one start recipe per repository.");
  const urls = ["frontendUrl", "backendUrl"].map((k) => {
    const u = new URL(raw[k] || "http://invalid");
    if (
      u.protocol !== "http:" ||
      !repos.some((r) => r.name === u.hostname) ||
      u.username ||
      u.password ||
      u.hash
    )
      throw bad(
        "Health URLs must use a repository service name on the private network.",
      );
    return u.toString();
  });
  // Supporting services are a fixed catalog of images the runner knows how to
  // start; never an image name or command from configuration.
  const services = [...new Set(raw.services || [])];
  if (services.length > 1 || services.some((s) => s !== "redis"))
    throw bad("The only supporting service available is redis.");
  // The browser reaches a repository's service as http://localhost:<port>, the
  // way its developers run it, so localhost-based app configs and CORS work.
  const localPorts = (raw.localPorts || []).map((m) => {
    const port = Number(m?.port);
    if (
      !Number.isSafeInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      !repos.some((r) => r.name === m.repository)
    )
      throw bad(
        "Map localhost ports 1024-65535 to a configured repository service.",
      );
    return { port, repository: m.repository };
  });
  if (
    localPorts.length > 8 ||
    new Set(localPorts.map((m) => m.port)).size !== localPorts.length
  )
    throw bad("Use up to eight distinct localhost ports.");
  // Demo sign-in through the client's own test identity tenant. The domain is
  // only a request here: the owner allowlists it per workplace before any run.
  let auth = null;
  if (raw.auth) {
    const a = raw.auth;
    const domain = text(a.domain, 200, "Sign-in domain").toLowerCase();
    if (!/^(?=.{4,200}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain))
      throw bad("Use the sign-in tenant's bare hostname, e.g. example.us.auth0.com.");
    if (!uuid(a.loginCredentialUuid))
      throw bad("Select the encrypted test login for demo sign-in.");
    auth = {
      domain,
      loginCredentialUuid: a.loginCredentialUuid,
      role: text(a.role, 80, "Demo sign-in role"),
      startLabel: a.startLabel ? text(a.startLabel, 80, "Sign-in button") : null,
      usernameLabel: text(a.usernameLabel || "Email address", 80, "Username field"),
      passwordLabel: text(a.passwordLabel || "Password", 80, "Password field"),
      submitLabel: text(a.submitLabel || "Continue", 80, "Submit button"),
    };
  }
  const tokens = Number(raw.tokenLimit);
  if (!Number.isSafeInteger(tokens) || tokens < 10000 || tokens > 2000000)
    throw bad("Set a token ceiling from 10,000 to 2,000,000.");
  return {
    runnerUuid: raw.runnerUuid,
    jiraCredentialUuid: raw.jiraCredentialUuid,
    githubCredentialUuid: raw.githubCredentialUuid,
    modelCredentialUuid: raw.modelCredentialUuid,
    provider,
    model: text(raw.model, 100, "Model ID"),
    repositories: repos,
    backup,
    backupFormat: raw.backupFormat,
    postgresVersion: 17,
    recipes,
    services,
    localPorts,
    auth,
    frontendUrl: urls[0],
    backendUrl: urls[1],
    tokenLimit: tokens,
    runtimeImage: "athena-work-runtime:1",
    acceptanceField: raw.acceptanceField
      ? text(raw.acceptanceField, 80, "Acceptance field")
      : null,
  };
}
function operation(raw, implementing, cfg) {
  if (!raw || typeof raw !== "object") throw bad("Missing operation.");
  if (raw.type === "read")
    return {
      type: "read",
      path: path(raw.path),
      offset:
        Number.isSafeInteger(raw.offset) &&
        raw.offset >= 0 &&
        raw.offset <= 1000000
          ? raw.offset
          : 0,
    };
  if (raw.type === "list") return { type: "list" };
  if (raw.type === "search")
    return {
      type: "search",
      query: text(raw.query, 160, "Literal search text"),
    };
  if (raw.type === "test") {
    if (!cfg.recipes.some((r) => r.id === raw.recipe && r.kind === "test"))
      throw bad("Only configured test recipes may be requested.");
    return { type: "test", recipe: raw.recipe };
  }
  if (raw.type === "write" && implementing)
    return {
      type: "write",
      path: path(raw.path),
      content:
        typeof raw.content === "string" && raw.content.length <= 100000
          ? raw.content
          : (() => {
              throw bad("File content is too large.");
            })(),
    };
  if (raw.type === "edit" && implementing) {
    if (
      typeof raw.oldText !== "string" ||
      !raw.oldText.length ||
      raw.oldText.length > 20000 ||
      typeof raw.newText !== "string" ||
      raw.newText.length > 20000
    )
      throw bad("Provide a bounded exact source span and replacement.");
    return {
      type: "edit",
      path: path(raw.path),
      oldText: raw.oldText,
      newText: raw.newText,
    };
  }
  if (raw.type === "finish") {
    let demo;
    if (implementing) {
      if (
        !Array.isArray(raw.demo) ||
        raw.demo.length < 1 ||
        raw.demo.length > 24 ||
        !raw.demo.some((s) => s.type === "assert")
      )
        throw bad(
          "Provide a real browser demonstration with at least one acceptance assertion.",
        );
      demo = raw.demo.map((s) => {
        if (s.type === "click")
          return {
            type: "click",
            role: s.role === "link" ? "link" : "button",
            label: text(s.label, 200, "Control label"),
          };
        if (s.type === "fill") {
          if (typeof s.value !== "string" || s.value.length > 500)
            throw bad("Test values must be bounded text.");
          return {
            type: "fill",
            label: text(s.label, 200, "Input label"),
            value: s.value,
          };
        }
        if (s.type === "assert")
          return {
            type: "assert",
            text: text(s.text, 500, "Expected visible text"),
            criterion: text(s.criterion, 500, "Acceptance criterion"),
          };
        throw bad("Unsupported demonstration operation.");
      });
    }
    return {
      type: "finish",
      text: text(raw.text, 24000, "Plan or implementation report"),
      ...(demo ? { demo } : {}),
    };
  }
  throw bad("Operation is outside this approved phase.");
}
module.exports = { bad, hash, json, uuid, text, path, config, operation };
