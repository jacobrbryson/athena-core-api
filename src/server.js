require("dotenv").config();
const express = require("express");
const http = require("http");
const createRouter = require("./routes");
const { startWebSocketServer } = require("./websocket/wsServer");
const config = require("./config");

const app = express();
app.use(express.json());

const server = http.createServer(app);
const clients = startWebSocketServer(server);

app.use("/", createRouter(clients));

server.listen(config.API_PORT, () => {
	console.log("API + WS server running on port 3001");
});
