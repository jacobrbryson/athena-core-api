require("dotenv").config();
const express = require("express");
const http = require("http");
const jsonParser = require("./middleware/jsonParser");
const createRouter = require("./routes");
const { startWebSocketServer } = require("./websocket/wsServer");

const app = express();
app.use(jsonParser);

const server = http.createServer(app);
const clients = startWebSocketServer(server);

app.use("/", createRouter(clients));

server.listen(3001, () => {
	console.log("API + WS server running on port 3001");
});
