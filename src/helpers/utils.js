function normalizeIp(ip) {
	if (!ip) return null;
	if (ip.startsWith("::ffff:")) return ip.slice(7);
	if (ip === "::1") return "127.0.0.1";
	return ip;
}

/**
 * The caller's IP. The leftmost X-Forwarded-For entry is trustworthy here only
 * because core_api is invoker-only and the proxy — the one public way in —
 * replaces the client's header with the single address it verified
 * (proxy_service src/utils/clientIp.js). Cloud Run then appends the proxy's
 * own address after it. Anywhere a client can reach directly, the leftmost
 * entry is whatever the client wrote.
 */
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
