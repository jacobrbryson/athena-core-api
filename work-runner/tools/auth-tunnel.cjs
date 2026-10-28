// Preloaded into app containers (NODE_OPTIONS=--require) when an environment
// signs in through an outside tenant. Node's https client tunnels only the
// allowlisted sign-in hosts through the demo's sign-in proxy (e.g. a backend
// fetching the tenant's signing keys); every other host connects directly and
// stays blocked by the container firewall. Node 22.20 has no NODE_USE_ENV_PROXY,
// and HTTPS_PROXY is avoided because some clients mishandle it for HTTPS.
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");
const [proxyHost, proxyPort] = String(process.env.ATHENA_AUTH_PROXY || "").split(":");
const hosts = new Set(
  String(process.env.ATHENA_AUTH_HOSTS || "")
    .split(",")
    .filter(Boolean),
);
if (proxyHost && Number(proxyPort) && hosts.size) {
  class TunnelAgent extends https.Agent {
    createConnection(options, done) {
      const host = options.host || options.hostname;
      if (!hosts.has(host)) return super.createConnection(options, done);
      const connect = http.request({
        host: proxyHost,
        port: Number(proxyPort),
        method: "CONNECT",
        path: `${host}:${options.port || 443}`,
        timeout: 15000,
      });
      connect.once("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          return done(new Error(`Sign-in proxy refused ${host}`));
        }
        done(null, tls.connect({ ...options, socket, servername: options.servername || host }));
      });
      connect.once("timeout", () => connect.destroy(new Error("Sign-in proxy timed out")));
      connect.once("error", done);
      connect.end();
    }
  }
  https.globalAgent = new TunnelAgent({ keepAlive: true });
}
