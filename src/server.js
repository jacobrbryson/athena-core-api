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
// Image-bearing routes (photo memories, camera keyframes) get a larger body
// limit; everything else keeps the 100kb default. body-parser skips a body
// that is already parsed, so the global parser below is a no-op for these.
app.use(["/memory/photos", "/vision/observe", "/vision/describe"], express.json({ limit: "8mb" }));
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
