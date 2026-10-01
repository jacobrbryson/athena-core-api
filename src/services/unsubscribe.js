/**
 * One-click unsubscribe (RFC 8058) — Mail card phase 4.
 *
 * The link comes from an email header, so it is untrusted input that Athena
 * is about to make a network request to. What makes that acceptable:
 *
 *   - Only RFC 8058 one-click: the message must carry
 *     `List-Unsubscribe-Post: List-Unsubscribe=One-Click` and an https link.
 *     A mailto: link would mean sending email, which Athena never does.
 *   - The link is read from Athena's own stored row at execute time. The
 *     action's params only name the row, so neither a model nor a browser can
 *     supply the address that gets called.
 *   - The host must resolve only to public addresses (no loopback, private,
 *     link-local or metadata ranges), checked immediately before the request.
 *   - A fixed body, no cookies or credentials, redirects not followed, and a
 *     ten-second timeout.
 */
const dns = require("node:dns").promises;
const net = require("node:net");

const TIMEOUT_MS = 10_000;
const ONE_CLICK = /list-unsubscribe\s*=\s*one-click/i;

/** The https link from a List-Unsubscribe header, when the sender supports one-click; else null. */
function oneClickUrl(listUnsubscribe, listUnsubscribePost) {
	if (!ONE_CLICK.test(listUnsubscribePost || "")) return null;
	for (const [, candidate] of String(listUnsubscribe || "").matchAll(/<([^>]+)>/g)) {
		try {
			const url = new URL(candidate.trim());
			if (url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2000) return url.href;
		} catch {
			// not a URL — try the next one
		}
	}
	return null;
}

/** True for any address a request from our server must never reach. */
function isPrivateAddress(address) {
	if (net.isIPv4(address)) {
		const [a, b] = address.split(".").map(Number);
		return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
	}
	if (net.isIPv6(address)) {
		const lower = address.toLowerCase();
		if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
		return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
	}
	return true; // not an address at all: refuse
}

async function assertPublicHost(hostname) {
	const host = hostname.replace(/^\[|\]$/g, "");
	if (net.isIP(host)) {
		if (isPrivateAddress(host)) throw new Error("Unsubscribe link points at a private address");
		return;
	}
	const answers = await dns.lookup(host, { all: true, verbatim: true });
	if (!answers.length || answers.some((a) => isPrivateAddress(a.address))) {
		throw new Error("Unsubscribe link resolves to a private address");
	}
}

/**
 * Send the one-click request. Resolves { ok, status }; throws only when the
 * link is refused before anything is sent.
 */
async function send(urlText, { fetchImpl = fetch } = {}) {
	const url = new URL(urlText);
	if (url.protocol !== "https:") throw new Error("Only https unsubscribe links are used");
	await assertPublicHost(url.hostname);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetchImpl(url.href, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "List-Unsubscribe=One-Click",
			redirect: "manual",
			credentials: "omit",
			signal: controller.signal,
		});
		// RFC 8058 senders answer 2xx; a redirect is treated as accepted, since
		// some providers confirm with one, but it is never followed.
		return { ok: res.status >= 200 && res.status < 400, status: res.status };
	} catch (err) {
		return { ok: false, status: null, error: err.name === "AbortError" ? "timed out" : err.message };
	} finally {
		clearTimeout(timer);
	}
}

module.exports = { oneClickUrl, isPrivateAddress, assertPublicHost, send };
