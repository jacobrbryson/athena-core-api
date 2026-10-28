// Disposable local fixture: no API keys, company sources or database data.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const image = "athena-work-runtime:1";
const name = `athena-work-smoke-${process.pid}`;
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
      c === 0 ? resolve(out.trim()) : reject(new Error(error || out)),
    );
    p.stdin.end(input);
  });
}
try {
  assert.notEqual(
    await docker(["run", "--rm", "--network", "none", image, "id", "-u"]),
    "0",
  );
  await docker(["network", "create", "--internal", name]);
  await docker([
    "run",
    "-d",
    "--name",
    name,
    "--network",
    name,
    "--network-alias",
    "fixture",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "1g",
    image,
    "sleep",
    "infinity",
  ]);
  const info = JSON.parse(await docker(["inspect", name]));
  const privateIp = info[0].NetworkSettings.Networks[name].IPAddress;
  const rules = `*filter\n:OUTPUT DROP [0:0]\n-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\n-A OUTPUT -o lo -j ACCEPT\n-A OUTPUT -d ${privateIp}/32 -j ACCEPT\nCOMMIT\n`;
  await docker(
    [
      "run",
      "--rm",
      "--user",
      "0:0",
      "--read-only",
      "--network",
      `container:${name}`,
      "--cap-drop",
      "ALL",
      "--cap-add",
      "NET_ADMIN",
      "-i",
      image,
      "iptables-restore",
    ],
    rules,
  );
  await docker([
    "exec",
    name,
    "node",
    "-e",
    'fetch("https://example.com",{signal:AbortSignal.timeout(1200)}).then(()=>process.exit(1)).catch(()=>console.log("external blocked"))',
  ]);
  const inspected = JSON.parse(await docker(["network", "inspect", name]));
  const gateway = inspected[0].IPAM.Config[0].Gateway;
  await docker([
    "exec",
    name,
    "node",
    "-e",
    'fetch(process.argv[1],{signal:AbortSignal.timeout(1200)}).then(()=>process.exit(1)).catch(()=>console.log("gateway blocked"))',
    `http://${gateway}:80`,
  ]);
  await docker([
    "exec",
    name,
    "node",
    "-e",
    'require("fs").access("/opt/work-tools/operate.cjs",require("fs").constants.W_OK,e=>{if(!e)process.exit(1);console.log("tools read-only")})',
  ]);
  const html =
    '<html><body><h1>Acceptance fixture</h1><button id="save">Save</button><p id="state">Ready</p><script>document.getElementById("save").addEventListener("click",()=>document.getElementById("state").textContent="Saved");</script></body></html>';
  await docker([
    "exec",
    "-d",
    name,
    "node",
    "-e",
    `require('http').createServer((q,s)=>{s.setHeader('Content-Type','text/html');s.end(${JSON.stringify(html)})}).listen(8080,'0.0.0.0')`,
  ]);
  await docker(["exec", name, "mkdir", "-p", "/workspace/evidence"]);
  const result = await docker(
    ["exec", "-i", name, "node", "/opt/work-tools/browser.mjs"],
    JSON.stringify({
      url: "http://fixture:8080/",
      hosts: ["fixture"],
      steps: [
        { type: "click", label: "Save" },
        {
          type: "assert",
          text: "Saved",
          criterion: "Saving confirms the change",
        },
      ],
    }),
  );
  const checks = JSON.parse(result);
  assert.ok(checks.every((c) => c.passed));
  await docker([
    "exec",
    name,
    "ffmpeg",
    "-y",
    "-i",
    "/workspace/evidence/walkthrough.webm",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=24000:cl=mono",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "/workspace/evidence/demo.mp4",
  ]);
  await docker(["exec", name, "test", "-s", "/workspace/evidence/demo.mp4"]);
  console.log(
    "PASS: non-root runtime, immutable tools, firewall helper, blocked external/gateway access, browser assertions, recording and MP4 encoding.",
  );
} finally {
  await docker(["rm", "-f", name]).catch(() => undefined);
  await docker(["network", "rm", name]).catch(() => undefined);
}
