// Validate an archive before extraction. GitHub archives may contain symlinks;
// none are allowed into a model-editable workspace.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const archive = "/tmp/source.tgz";
fs.writeFileSync(archive, fs.readFileSync(0));
const files = execFileSync("tar", ["-tzf", archive], {
  maxBuffer: 8 * 1024 * 1024,
})
  .toString()
  .trim()
  .split("\n");
if (files.some((f) => f.startsWith("/") || f.split("/").includes("..")))
  throw new Error("Unsafe archive path");
const verbose = execFileSync("tar", ["-tvzf", archive], {
  maxBuffer: 16 * 1024 * 1024,
})
  .toString()
  .split("\n");
if (verbose.some((line) => /^[lhbcp]/.test(line)))
  throw new Error(
    "Archive contains links or special files; use a reviewed source export",
  );
execFileSync(
  "tar",
  ["-xzf", archive, "--strip-components=1", "-C", process.argv[2]],
  { stdio: "inherit" },
);
