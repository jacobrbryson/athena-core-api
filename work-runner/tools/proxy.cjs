// Trusted package-download broker. Work containers only join the internal network.
const http = require("node:http"),
  net = require("node:net"),
  dns = require("node:dns").promises;
// Exact hostnames from the trusted runner: npm for installs, or the owner-allowed
// sign-in tenant (and its fixed asset hosts) while a demo records.
const allowed = new Set(process.argv.slice(2));
if (
  !allowed.size ||
  [...allowed].some((h) => !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(h))
)
  throw new Error("Proxy needs exact hostnames to allow");
const server = http.createServer((_req, res) => {
  res.writeHead(403);
  res.end("CONNECT only");
});
server.on("connect", async (req, client, head) => {
  try {
    const [host, port] = String(req.url).split(":");
    if (port !== "443" || !allowed.has(host))
      throw new Error("Forbidden destination");
    const { address } = await dns.lookup(host, { family: 4 });
    if (
      /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|224\.)/.test(
        address,
      )
    )
      throw new Error("Private destination");
    const upstream = net.connect(443, address, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.setTimeout(120000, () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  } catch {
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  }
});
server.listen(3128, "0.0.0.0");
