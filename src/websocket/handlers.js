function handleConnection(ws, req) {
	const clientIp = req.socket.remoteAddress;
	console.log(`API Service: New WS connection from ${clientIp}`);

	ws.send("API: Welcome! You are connected via the proxied WebSocket.");

	ws.on("message", (message) => {
		const msgText = message.toString();
		console.log(`API Service: Received WS message: ${msgText}`);
		ws.send(
			JSON.stringify({
				type: "system",
				text: "Welcome!",
			})
		);
	});

	ws.on("close", () => {
		console.log("API Service: Client disconnected.");
	});
}

module.exports = { handleConnection };
