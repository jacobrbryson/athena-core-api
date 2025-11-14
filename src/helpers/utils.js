function extractIp(req) {
	return (
		req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
		req.socket.remoteAddress
	);
}

module.exports = {
	extractIp,
};
