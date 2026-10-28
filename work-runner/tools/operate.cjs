// The model never reaches Docker or a shell. Only these file operations exist.
const fs = require("node:fs/promises"),
  path = require("node:path");
async function safe(root, relative, writing = false) {
  if (
    typeof relative !== "string" ||
    !/^[a-zA-Z0-9_./@-]+$/.test(relative) ||
    relative.startsWith("/") ||
    relative
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /^\.(?:git|github|env(?:\..*)?|npmrc|ssh|aws|codex|agents)$/i.test(p),
      ) ||
    /(?:^|\/)(?:AGENTS\.md|Dockerfile|docker-compose[^/]*|compose\.ya?ml|(?:credentials|secrets|serviceaccount)[^/]*|[^/]*\.(?:pem|key))$/i.test(
      relative,
    )
  )
    throw new Error("File is outside approved operation scope");
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(path.resolve(root) + path.sep))
    throw new Error("Path escape");
  const parts = relative.split("/");
  let parent = root;
  for (let i = 0; i < parts.length; i++) {
    parent = path.join(parent, parts[i]);
    const info = await fs.lstat(parent).catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    });
    if (info?.isSymbolicLink())
      throw new Error("Symbolic links are outside operation scope");
    if (!info && !writing) throw new Error("File does not exist");
  }
  return absolute;
}
async function main(op, root = "/workspace") {
  if (op.type === "search") {
    if (typeof op.query !== "string" || !op.query || op.query.length > 160)
      throw new Error("Invalid search");
    const files = (await main({ type: "list" }, root)).split("\n");
    const found = [];
    for (const name of files) {
      if (
        found.length >= 100 ||
        !/\.(?:[cm]?jsx?|tsx?|json|sql|md|ya?ml|css|html|prisma|graphql)$/.test(
          name,
        )
      )
        continue;
      let content;
      try {
        const file = await safe(root, name);
        const stat = await fs.stat(file);
        if (stat.size > 200000) continue;
        content = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      content.split("\n").forEach((line, i) => {
        if (found.length < 100 && line.includes(op.query))
          found.push(`${name}:${i + 1}: ${line.slice(0, 300)}`);
      });
    }
    return found.join("\n") || "No matches in the bounded source index.";
  }
  if (op.type === "list") {
    const out = [];
    async function walk(dir, prefix = "") {
      for (const d of await fs.readdir(dir, { withFileTypes: true })) {
        if (
          /^(?:node_modules|\.git|\.github|\.env.*|dist|build|coverage|\.next)$/.test(
            d.name,
          ) ||
          d.isSymbolicLink()
        )
          continue;
        const relative = `${prefix}${d.name}`;
        if (out.length >= 1500) return;
        if (d.isDirectory()) await walk(path.join(dir, d.name), `${relative}/`);
        else out.push(relative);
      }
    }
    await walk(root);
    return out.join("\n");
  }
  if (!["read", "write", "edit"].includes(op.type))
    throw new Error("Unsupported file operation");
  const file = await safe(root, op.path, op.type === "write");
  if (op.type === "read") {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 200000)
      throw new Error("Only source files up to 200 KB may be read");
    const offset =
      Number.isSafeInteger(op.offset) && op.offset >= 0 ? op.offset : 0;
    return (await fs.readFile(file, "utf8")).slice(offset, offset + 24000);
  }
  if (op.type === "edit") {
    if (
      typeof op.oldText !== "string" ||
      !op.oldText ||
      typeof op.newText !== "string" ||
      op.oldText.length > 20000 ||
      op.newText.length > 20000
    )
      throw new Error("Invalid edit");
    const source = await fs.readFile(file, "utf8");
    if (source.length > 1000000 || source.split(op.oldText).length !== 2)
      throw new Error("Edit needs exactly one matching source span");
    await fs.writeFile(
      file,
      source.replace(op.oldText, () => op.newText),
    );
    return `Edited ${op.path}`;
  }
  if (typeof op.content !== "string" || op.content.length > 100000)
    throw new Error("Invalid file content");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, op.content, { flag: "w" });
  return `Updated ${op.path}`;
}
module.exports = { safe, main };
if (require.main === module) {
  let data = "";
  process.stdin.on("data", (b) => {
    data += b;
    if (data.length > 150000) process.exit(1);
  });
  process.stdin.on("end", () =>
    main(JSON.parse(data)).then(
      (x) => process.stdout.write(x),
      (e) => {
        process.stderr.write(e.message);
        process.exitCode = 1;
      },
    ),
  );
}
