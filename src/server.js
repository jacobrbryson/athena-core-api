require("dotenv").config();
const express = require("express");
const http = require("http");
const createRouter = require("./routes");
const { startWebSocketServer } = require("./websocket/wsServer");
const config = require("./config");
const llm = require("./services/llm");
const memoryStore = require("./services/memoryStore");

const app = express();
app.set("trust proxy", 1);
// Provider-authenticated ingress: the controller validates WHOOP's signature
// over exact bytes, then only persists work for opted-in, connected owners.
// All model work runs later under that owner's live access context.
app.post('/webhooks/whoop', express.raw({ type: 'application/json', limit: '32kb', inflate: false }), require('./controllers/whoopWebhook').receive);
// Google Nest events via Pub/Sub push: the controller verifies Google's OIDC
// token for the configured subscription account before reading anything.
app.post('/webhooks/nest', express.json({ limit: '96kb' }), require('./controllers/nestWebhook').receive);
// Household Eufy bridge: motion/doorbell/person events with one frame (base64) each.
app.post('/webhooks/eufy', express.json({ limit: '8mb' }), require('./controllers/eufyEvents').receive);
// Image-bearing routes (photo memories, camera keyframes, project photos) get a larger body
// limit; everything else keeps the 100kb default. body-parser skips a body
// that is already parsed, so the global parser below is a no-op for these.
app.use(["/memory/photos", "/vision/observe", "/vision/describe", "/projects/:uuid/entries", "/projects/property", "/dashboard/health/nutrition/scan"], express.json({ limit: "8mb" }));
app.use('/dashboard/family/people/:factUuid/portrait', express.json({ limit: '200kb' }));
app.use(express.json());

// Keep fact embeddings in sync with every writer, and watch Orcwood health.
memoryStore.start();
llm.startHealthLoop();

const server = http.createServer(app);
const clients = startWebSocketServer(server);

app.use("/", createRouter(clients));

const port = process.env.PORT || config.API_PORT;
server.listen(port, () => {
	console.log(`API + WS server running on port ${port}`);
});
