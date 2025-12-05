require("dotenv").config();
const express = require("express");
const http = require("http");
const createRouter = require("./routes");
const { startWebSocketServer } = require("./websocket/wsServer");
const config = require("./config");

const app = express();
app.set("trust proxy", 1);
app.use(express.json());

const server = http.createServer(app);
const clients = startWebSocketServer(server);

app.use("/", createRouter(clients));

const port = process.env.PORT || config.API_PORT;
server.listen(port, () => {
	console.log(`API + WS server running on port ${port}`);
});
