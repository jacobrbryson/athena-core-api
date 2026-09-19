/**
 * Reading a page on the open internet, safely and politely.
 *
 * Safely: a URL a person pastes is an outbound request the server makes on
 * their behalf, which is the shape of every SSRF bug ever written. So the
 * rules here are deliberately blunt — HTTPS only, no credentials, no custom
 * port, no IP literals, and every hostname must resolve to a public IPv4
 * address that is then PINNED to the connection, so a name that answers
 * publicly on the first lookup cannot answer 169.254.169.254 on the second.
 *
 * Redirects are followed, unlike the feed reader this replaces, because real
 * news sites redirect constantly (http -> https, bare -> www, canonical
 * slugs) and refusing them meant refusing most of the web. Each hop is
 * re-validated from scratch by the same rules, and there are at most three.
 *
 * Politely: we send a conditional GET when we have an ETag, we honour
 * robots.txt including Crawl-delay, we identify ourselves, and we cap what we
 * will read. None of that is required of us. All of it is the difference
 * between a reader and a nuisance, and a nuisance gets blocked.
 */
const https = require("node:https");
const dns = require("node:dns").promises;
const net = require("node:net");

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;
const ROBOTS_MAX_BYTES = 128 * 1024;

const USER_AGENT = process.env.NEWS_USER_AGENT || "AthenaNewsReader/1.0 (personal news reader; one page per source)";
/** The token a site would write in robots.txt to address us specifically. */
const UA_TOKEN = "athenanewsreader";

const ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml;q=0.8,*/*;q=0.5";

const badUrl = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * Normalise a pasted page URL, or throw a 400 whose message is safe to show.
 * The fragment goes (it never changes what a server returns) but the query
 * stays — plenty of section pages are `?section=world`.
 */
function pageUrl(value) {
	if (typeof value !== "string" || !value.trim()) throw badUrl("Paste the address of a news page.");
	const raw = value.trim();
	if (raw.length > 500) throw badUrl("That address is too long.");
	let url;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
	} catch {
		throw badUrl("That does not look like a web address.");
	}
	if (url.protocol === "http:") url.protocol = "https:";
	if (url.protocol !== "https:") throw badUrl("I can only read pages over HTTPS.");
	if (url.username || url.password) throw badUrl("I cannot read a page that needs a username in the address.");
	if (url.port && url.port !== "443") throw badUrl("I can only read pages on the standard HTTPS port.");
	if (net.isIP(url.hostname) || /[[\]]/.test(url.hostname)) throw badUrl("Paste the site's address, not an IP address.");
	if (!url.hostname.includes(".") || url.hostname.endsWith(".")) throw badUrl("That does not look like a public web address.");
	url.hash = "";
	return url.toString();
}

/** Everything that is not a globally routable IPv4 address. */
function publicIPv4(address) {
	if (net.isIP(address) !== 4) return false;
	const [a, b, c] = address.split(".").map(Number);
	return !(
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
		(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
		(a === 203 && b === 0 && c === 113)
	);
}

/** Resolve a hostname and refuse the whole name if ANY answer is private. */
async function resolvePublic(hostname) {
	const addresses = await dns.lookup(hostname, { all: true, family: 4 });
	if (!addresses.length) throw new Error("That address does not resolve.");
	if (addresses.some((a) => !publicIPv4(a.address))) throw new Error("That address points inside a private network.");
	return addresses[0].address;
}

function decode(buffer, contentType) {
	const charset = /charset="?([\w-]+)"?/i.exec(contentType || "")?.[1]?.toLowerCase();
	if (charset && /^(iso-8859-1|latin1|windows-1252)$/.test(charset)) return buffer.toString("latin1");
	return buffer.toString("utf8");
}

/**
 * One HTTPS GET to one already-validated address. No redirect following, no
 * cookies, no proxy env, and no second DNS lookup — the address resolved by
 * the caller is the address connected to.
 */
function getOnce(url, address, headers, maxBytes) {
	return new Promise((resolve, reject) => {
		const request = https.get(
			url,
			{
				family: 4,
				lookup: (_host, options, callback) =>
					options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
				headers: { Accept: ACCEPT, "User-Agent": USER_AGENT, "Accept-Language": "en", ...headers },
			},
			(response) => {
				const chunks = [];
				let size = 0;
				response.on("data", (chunk) => {
					size += chunk.length;
					if (size > maxBytes) request.destroy(new Error("That page is too big to read."));
					else chunks.push(chunk);
				});
				response.on("error", reject);
				response.on("end", () =>
					resolve({
						statusCode: response.statusCode,
						headers: response.headers,
						body: decode(Buffer.concat(chunks), response.headers["content-type"]),
					})
				);
			}
		);
		const deadline = setTimeout(() => request.destroy(new Error("That site took too long to answer.")), TIMEOUT_MS);
		request.on("close", () => clearTimeout(deadline));
		request.on("error", reject);
	});
}

/**
 * Fetch a page, following up to three re-validated redirects.
 *
 * Returns { status, finalUrl, body, contentType, etag, lastModified }.
 * `status` 304 means the conditional GET matched and `body` is empty — the
 * cheapest possible visit, and the common one.
 */
async function fetchPage(value, { etag = null, lastModified = null, maxBytes = MAX_BYTES } = {}) {
	let target = pageUrl(value);
	const headers = {};
	if (etag) headers["If-None-Match"] = etag;
	if (lastModified) headers["If-Modified-Since"] = lastModified;

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const url = new URL(target);
		const address = await resolvePublic(url.hostname);
		const response = await getOnce(url, address, headers, maxBytes);
		const status = response.statusCode;

		if (status >= 300 && status < 400 && response.headers.location) {
			if (hop === MAX_REDIRECTS) throw new Error("That page redirects too many times.");
			// Re-validated from scratch: a redirect is an address a stranger chose.
			target = pageUrl(new URL(response.headers.location, url).toString());
			continue;
		}
		if (status === 304) return { status, finalUrl: target, body: "", contentType: null, etag, lastModified };
		if (status === 429 || status === 503) throw new Error("That site asked me to come back later.");
		if (status === 403 || status === 401) throw new Error("That site would not let me read the page.");
		if (status !== 200) throw new Error(`That page answered ${status}.`);

		return {
			status,
			finalUrl: target,
			body: response.body,
			contentType: String(response.headers["content-type"] || ""),
			etag: response.headers.etag ? String(response.headers.etag).slice(0, 255) : null,
			lastModified: response.headers["last-modified"] ? String(response.headers["last-modified"]).slice(0, 64) : null,
		};
	}
	throw new Error("That page redirects too many times.");
}

/**
 * Parse robots.txt into the one answer we need: may we read this path, and
 * how long should we wait between visits.
 *
 * Deliberately simple and deliberately strict where it is ambiguous: the
 * longest matching rule wins (the convention every major crawler follows), a
 * group naming us beats the wildcard group, and `*` / `$` in a path are
 * honoured. An unparseable file is treated as no rules, because a site that
 * cannot write robots.txt has not refused us.
 */
function parseRobots(text, path) {
	const groups = new Map(); // agent -> { rules: [], delay }
	let agents = [];
	let collecting = false;
	for (const rawLine of String(text).split(/\r?\n/)) {
		const line = rawLine.split("#")[0].trim();
		if (!line) continue;
		const at = line.indexOf(":");
		if (at < 0) continue;
		const field = line.slice(0, at).trim().toLowerCase();
		const value = line.slice(at + 1).trim();
		if (field === "user-agent") {
			if (!collecting) agents = [];
			agents.push(value.toLowerCase());
			collecting = true;
			for (const agent of agents) if (!groups.has(agent)) groups.set(agent, { rules: [], delay: null });
			continue;
		}
		collecting = false;
		if (!agents.length) continue;
		for (const agent of agents) {
			const group = groups.get(agent);
			if (field === "disallow" || field === "allow") group.rules.push({ allow: field === "allow", path: value });
			else if (field === "crawl-delay" && Number.isFinite(Number(value))) group.delay = Number(value);
		}
	}

	const group = groups.get(UA_TOKEN) || groups.get("*");
	if (!group) return { allowed: true, crawlDelay: null };

	// Returns the match length (longer = more specific) or null for no match.
	const matches = (pattern) => {
		if (!pattern) return null; // "Disallow:" with no value allows everything
		const anchorEnd = pattern.endsWith("$");
		const body = anchorEnd ? pattern.slice(0, -1) : pattern;
		const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
		let expression;
		try {
			expression = new RegExp(`^${escaped}${anchorEnd ? "$" : ""}`);
		} catch {
			return null;
		}
		return expression.test(path) ? body.replace(/\*/g, "").length : null;
	};

	let best = { allow: true, length: -1 };
	for (const rule of group.rules) {
		const length = matches(rule.path);
		if (length === null) continue;
		if (length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
	}
	return { allowed: best.allow, crawlDelay: group.delay };
}

/**
 * What robots.txt says about this exact page. A site with no robots.txt, or
 * one we cannot read, has not said no — that is the standard reading, and
 * treating a 404 as a refusal would block most of the web.
 */
async function robotsFor(value) {
	const url = new URL(pageUrl(value));
	const path = `${url.pathname}${url.search}`;
	try {
		const response = await fetchPage(`https://${url.host}/robots.txt`, { maxBytes: ROBOTS_MAX_BYTES });
		return parseRobots(response.body, path);
	} catch {
		return { allowed: true, crawlDelay: null };
	}
}

module.exports = { pageUrl, publicIPv4, resolvePublic, fetchPage, robotsFor, parseRobots, USER_AGENT };
