function normalizeIp(ip) {
	if (!ip) return null;
	if (ip.startsWith("::ffff:")) return ip.slice(7);
	if (ip === "::1") return "127.0.0.1";
	return ip;
}

function extractIp(req) {
	const forwarded = req.headers?.["x-forwarded-for"];
	if (forwarded) {
		const forwardedList = Array.isArray(forwarded)
			? forwarded
			: String(forwarded)
					.split(",")
					.map((ip) => ip.trim())
					.filter(Boolean);

		const clientIp = normalizeIp(forwardedList[0] || null);
		if (clientIp) return clientIp;
	}

	// trust proxy is enabled at the app level; req.ip respects X-Forwarded-For
	return normalizeIp(req.ip || req.socket?.remoteAddress);
}

module.exports = {
	extractIp,
	normalizeIp,
};
