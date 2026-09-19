/**
 * News watcher tests. Three things are worth protecting here:
 *
 *   1. The fetch guards. A pasted URL is an outbound request the server makes,
 *      and the redirect following this feature added is exactly where a
 *      re-validated hop turns back into an SSRF.
 *   2. Extraction stability. A page that yields different junk every visit
 *      reads as constant breaking news and drags the interval to its floor.
 *   3. The cadence bounds. The model may ask for anything; what it gets is a
 *      step on the ladder, never below the floor, and never forever.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }));
jest.mock("../llm", () => ({ generateJson: jest.fn() }));
jest.mock("node:dns", () => ({ promises: { lookup: jest.fn() } }));
jest.mock("node:https", () => ({ get: jest.fn() }));

const { EventEmitter } = require("node:events");
const dns = require("node:dns").promises;
const https = require("node:https");
const pool = require("../../helpers/db");
const llm = require("../llm");
const fetchModule = require("./fetch");
const extract = require("./extract");
const cadence = require("./cadence");
const store = require("./store");

beforeEach(() => jest.resetAllMocks());

/** One canned HTTPS response, with the request object the code destroys on timeout. */
function respondWith({ statusCode = 200, headers = {}, body = "" }, onRequest) {
	https.get.mockImplementation((url, options, callback) => {
		const request = new EventEmitter();
		request.destroy = (error) => {
			request.emit("error", error || new Error("destroyed"));
			request.emit("close");
		};
		onRequest?.({ url, options, request });
		queueMicrotask(() => {
			const response = new EventEmitter();
			response.statusCode = statusCode;
			response.headers = headers;
			response.resume = () => undefined;
			callback(response);
			if (body) response.emit("data", Buffer.from(body));
			response.emit("end");
			request.emit("close");
		});
		return request;
	});
}

describe("page URLs", () => {
	test.each([
		"ftp://news.example.com/",
		"https://user:pass@news.example.com/",
		"https://news.example.com:8443/",
		"https://127.0.0.1/",
		"https://[::1]/",
		"https://localhost/",
		"https://news/",
	])("refuses %s", (value) => {
		expect(() => fetchModule.pageUrl(value)).toThrow();
	});

	test("accepts what a person actually pastes, and normalises it", () => {
		expect(fetchModule.pageUrl("news.example.com")).toBe("https://news.example.com/");
		// http is upgraded rather than refused: people paste what their browser shows.
		expect(fetchModule.pageUrl("http://news.example.com/world")).toBe("https://news.example.com/world");
		// The query survives (section pages use it); the fragment never does.
		expect(fetchModule.pageUrl("https://news.example.com/x?section=world#top")).toBe(
			"https://news.example.com/x?section=world"
		);
	});

	test.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1"])(
		"treats %s as non-public",
		(value) => {
			expect(fetchModule.publicIPv4(value)).toBe(false);
		}
	);
});

describe("fetching", () => {
	test("refuses a name that resolves anywhere private, before any request", async () => {
		dns.lookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
		await expect(fetchModule.fetchPage("https://news.example.com/")).rejects.toThrow();
		expect(https.get).not.toHaveBeenCalled();
	});

	test("refuses a name where only one answer is private", async () => {
		dns.lookup.mockResolvedValue([
			{ address: "93.184.216.34", family: 4 },
			{ address: "10.1.2.3", family: 4 },
		]);
		await expect(fetchModule.fetchPage("https://news.example.com/")).rejects.toThrow();
		expect(https.get).not.toHaveBeenCalled();
	});

	test("pins the address it validated and sends no credentials", async () => {
		dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
		let seen;
		respondWith({ headers: { "content-type": "text/html", etag: 'W/"abc"' }, body: "<html></html>" }, ({ options }) => {
			seen = options;
			options.lookup("ignored.example.com", {}, (err, address) => {
				expect(err).toBeNull();
				expect(address).toBe("93.184.216.34");
			});
		});
		const result = await fetchModule.fetchPage("https://news.example.com/");
		expect(result.status).toBe(200);
		expect(result.etag).toBe('W/"abc"');
		expect(seen.headers.Authorization).toBeUndefined();
		expect(seen.headers.Cookie).toBeUndefined();
	});

	test("follows a redirect, and re-validates the hop it was given", async () => {
		dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
		const hops = [];
		https.get.mockImplementation((url, options, callback) => {
			const request = new EventEmitter();
			request.destroy = (error) => {
				request.emit("error", error || new Error("destroyed"));
				request.emit("close");
			};
			hops.push(url.toString());
			queueMicrotask(() => {
				const response = new EventEmitter();
				response.resume = () => undefined;
				if (hops.length === 1) {
					response.statusCode = 301;
					response.headers = { location: "https://www.news.example.com/world" };
				} else {
					response.statusCode = 200;
					response.headers = { "content-type": "text/html" };
				}
				callback(response);
				if (hops.length > 1) response.emit("data", Buffer.from("<html></html>"));
				response.emit("end");
				request.emit("close");
			});
			return request;
		});
		const result = await fetchModule.fetchPage("https://news.example.com/world");
		expect(hops).toHaveLength(2);
		expect(result.finalUrl).toBe("https://www.news.example.com/world");
		// Both hops were resolved and checked, not just the first.
		expect(dns.lookup).toHaveBeenCalledTimes(2);
	});

	test("refuses a redirect into a private network", async () => {
		dns.lookup
			.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
			.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
		respondWith({ statusCode: 302, headers: { location: "https://metadata.internal.example.com/latest" } });
		await expect(fetchModule.fetchPage("https://news.example.com/")).rejects.toThrow();
	});

	test("a conditional GET that matches returns no body to parse", async () => {
		dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
		let seen;
		respondWith({ statusCode: 304 }, ({ options }) => {
			seen = options;
		});
		const result = await fetchModule.fetchPage("https://news.example.com/", { etag: '"abc"' });
		expect(seen.headers["If-None-Match"]).toBe('"abc"');
		expect(result.status).toBe(304);
		expect(result.body).toBe("");
	});
});

describe("robots.txt", () => {
	const robots = `
User-agent: *
Disallow: /world
Allow: /world/live
Crawl-delay: 20

User-agent: AthenaNewsReader
Disallow: /opinion
`;
	test("obeys the group that names us over the wildcard group", () => {
		expect(fetchModule.parseRobots(robots, "/opinion/column").allowed).toBe(false);
		// Our own group has no /world rule, so the wildcard's does not apply to us.
		expect(fetchModule.parseRobots(robots, "/world").allowed).toBe(true);
	});
	test("longest match wins inside a group", () => {
		const wildcardOnly = "User-agent: *\nDisallow: /world\nAllow: /world/live\n";
		expect(fetchModule.parseRobots(wildcardOnly, "/world/africa").allowed).toBe(false);
		expect(fetchModule.parseRobots(wildcardOnly, "/world/live/updates").allowed).toBe(true);
	});
	test("an empty Disallow allows everything, and a missing file says nothing", () => {
		expect(fetchModule.parseRobots("User-agent: *\nDisallow:\n", "/anything").allowed).toBe(true);
		expect(fetchModule.parseRobots("", "/anything").allowed).toBe(true);
	});
	test("reads Crawl-delay for the group that applies", () => {
		expect(fetchModule.parseRobots("User-agent: *\nCrawl-delay: 30\n", "/x").crawlDelay).toBe(30);
	});
});

describe("extraction", () => {
	const page = `<!doctype html><html><head>
    <script type="application/ld+json">{"@type":"ItemList","itemListElement":[
      {"@type":"ListItem","item":{"@type":"NewsArticle","headline":"Council votes to rebuild the north bridge","url":"/2026/09/19/north-bridge-vote","datePublished":"2026-09-19T08:00:00Z","description":"After four years of argument."}}]}</script>
    </head><body>
    <nav><a href="/subscribe">Subscribe to the daily edition today</a></nav>
    <header><a href="/account/login">Sign in to your account here</a></header>
    <main>
      <a href="/2026/09/19/north-bridge-vote"><img alt=""></a>
      <a href="/2026/09/19/north-bridge-vote">Council votes to rebuild the north bridge</a>
      <a href="/2026/09/19/harbour-strike-enters-second-week">Harbour strike enters its second week</a>
      <a href="/world">World</a>
      <a href="/2026/09/18/opinion-the-case-for-patience?utm_source=twitter">The case for patience on the harbour deal</a>
      <a href="https://other.example.net/2026/09/19/elsewhere">A story on somebody else's site entirely</a>
    </main>
    <footer><a href="/privacy">Privacy and cookie policy details</a></footer></body></html>`;

	const items = extract.extractItems(page, "https://news.example.com/");

	test("finds the stories and nothing else", () => {
		const titles = items.map((item) => item.title);
		expect(titles).toContain("Council votes to rebuild the north bridge");
		expect(titles).toContain("Harbour strike enters its second week");
		expect(titles.some((title) => /Subscribe|Sign in|Privacy/i.test(title))).toBe(false);
		// A section index is not a story, however prominent the link is.
		expect(titles).not.toContain("World");
		// Off-site links are dropped while the page's own stories are plentiful.
		expect(titles.some((title) => /somebody else's site/.test(title))).toBe(false);
	});

	test("the structured headline wins, and the duplicate link does not repeat it", () => {
		const bridge = items.filter((item) => item.title.startsWith("Council votes"));
		expect(bridge).toHaveLength(1);
		expect(bridge[0].published).toBe("2026-09-19T08:00:00Z");
		expect(bridge[0].url).toBe("https://news.example.com/2026/09/19/north-bridge-vote");
	});

	test("tracking parameters are stripped, so the same story hashes the same", () => {
		const opinion = items.find((item) => item.title.startsWith("The case for patience"));
		expect(opinion.url).toBe("https://news.example.com/2026/09/18/opinion-the-case-for-patience");
	});

	test("re-reading an unchanged page yields exactly the same items", () => {
		expect(extract.extractItems(page, "https://news.example.com/")).toEqual(items);
	});

	test("falls back to off-site links when the page is an aggregator", () => {
		const aggregator = `<html><body><main>
      <a href="https://first.example.org/2026/09/19/one-big-story">The first outlet reports a very big story</a>
      <a href="https://second.example.org/2026/09/19/another">The second outlet has another angle on it</a>
    </main></body></html>`;
		const found = extract.extractItems(aggregator, "https://aggregator.example.com/");
		expect(found).toHaveLength(2);
	});

	test("a pasted feed still works", () => {
		const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>Ferry timetable changes from Monday</title><link>https://news.example.com/ferry-timetable-changes</link><pubDate>Fri, 19 Sep 2026 06:00:00 GMT</pubDate></item>
    </channel></rss>`;
		expect(extract.looksLikeFeed(xml, "application/rss+xml")).toBe(true);
		const found = extract.extractItems(xml, "https://news.example.com/rss", "application/rss+xml");
		expect(found[0].title).toBe("Ferry timetable changes from Monday");
	});
});

/**
 * Every case here came from a real page, and each one was a real defect:
 * programme links reading as headlines, an entire card's text (including
 * "11 hrs ago") arriving as a title, an mp3 in the reading list, a page
 * offering itself as its own lead story.
 */
describe("extraction against what real publishers actually emit", () => {
	test("a card that wraps headline, standfirst and timestamp yields just the headline", () => {
		const page = `<html><body><main>
      <a href="/news/articles/c63d7lexyym1o">
        <h2>US and Denmark reach deal over Greenland after annexation threats</h2>
        <p>The agreement gives permanent control over security, officials said.</p>
        <span>11 hrs ago</span><span>World</span>
      </a></main></body></html>`;
		const [item] = extract.extractItems(page, "https://news.example.com/news");
		expect(item.title).toBe("US and Denmark reach deal over Greenland after annexation threats");
		// The timestamp is the one part of a card that differs every visit.
		expect(item.title).not.toMatch(/hrs? ago/);
		expect(item.summary).toMatch(/permanent control/);
	});

	test("a page does not offer itself as its own lead story", () => {
		const page = `<html><head>
      <script type="application/ld+json">{"@type":"WebPage","name":"Example News - Breaking news and the latest top stories","url":"https://news.example.com/news","description":"Visit Example News for the latest."}</script>
      </head><body><main>
      <a href="/news">Example News - Breaking news and the latest top stories</a>
      <a href="/news/articles/cq1234567890">A real story about the harbour strike</a>
      </main></body></html>`;
		const titles = extract.extractItems(page, "https://news.example.com/news").map((item) => item.title);
		expect(titles).toEqual(["A real story about the harbour strike"]);
	});

	test("programmes, podcasts, section indexes and audio files are not news", () => {
		const page = `<html><body><main>
      <a href="/programs/weekend-edition-saturday">Weekend Edition Saturday</a>
      <a href="/podcasts/510310/politics-podcast">The Example Politics Podcast</a>
      <a href="/sections/politics">Politics coverage from our reporters</a>
      <a href="https://ondemand.example.com/anon/2026/09/segment.mp3?e=nx-s1-1&amp;p=7">Listen &middot; 4:19</a>
      <a href="/2026/09/19/nx-s1-5966568/an-alaska-storm-scattered-artifacts">An Alaska storm scattered artifacts and archaeologists are racing</a>
      </main></body></html>`;
		const titles = extract.extractItems(page, "https://news.example.com/sections/news").map((item) => item.title);
		expect(titles).toEqual(["An Alaska storm scattered artifacts and archaeologists are racing"]);
	});

	test("sibling sections of the page you pasted are not stories", () => {
		const page = `<html><body><main>
      <a href="/world/south-and-central-asia">South and Central Asia</a>
      <a href="/world/2026/sep/19/pussy-riot-russian-spies-fsb-activists">The activist recruited by Russian spies to inform on her friends</a>
      </main></body></html>`;
		const titles = extract.extractItems(page, "https://news.example.com/world").map((item) => item.title);
		expect(titles).toEqual(["The activist recruited by Russian spies to inform on her friends"]);
	});

	test("entities are decoded in the text and in the link", () => {
		const page = `<html><body><main>
      <a href="/2026/09/19/story?a=1&amp;b=2">Ferry timetable changes &mdash; and what it means for the &lsquo;early boat&rsquo;</a>
      </main></body></html>`;
		const [item] = extract.extractItems(page, "https://news.example.com/");
		expect(item.title).toBe("Ferry timetable changes — and what it means for the ‘early boat’");
		// &amp; in an href is an ampersand; otherwise one story hashes two ways.
		expect(item.url).toBe("https://news.example.com/2026/09/19/story?a=1&b=2");
	});
});

describe("cadence", () => {
	const source = {
		id: 1,
		uuid: "u",
		url: "https://news.example.com/",
		host: "news.example.com",
		label: "news.example.com",
		scope: "world",
		intervalMinutes: 360,
		baselineMinutes: 360,
		intervalSetBy: "default",
		intervalReason: null,
		intervalExpiresAt: null,
		consecutiveFailures: 0,
		robotsDelayS: null,
	};
	const busy = { polls: 12, changedPolls: 8, quietPolls: 4, newItems: 30, errors: 0, hoursObserved: 24, itemsPerHour: 1.2, lastAthenaAt: null };

	test("only the intervals on the ladder exist, and the floor is never undercut", () => {
		expect(cadence.clampToStep(1)).toBe(cadence.MIN_STEP);
		expect(cadence.clampToStep(100)).toBe(180);
		expect(cadence.clampToStep(100000)).toBe(1440);
		// A site asking for ten minutes between visits raises OUR floor.
		expect(cadence.floorFor({ ...source, robotsDelayS: 1800 })).toBe(30);
	});

	test("what Athena asks for is honoured, bounded, and given an expiry", async () => {
		llm.generateJson.mockResolvedValue({
			data: { interval_minutes: 15, hold_hours: 48, reason: "The harbour strike is moving hour by hour." },
			model: "local-qwen",
		});
		const decision = await cadence.decide({
			source,
			added: [{ title: "Harbour strike talks collapse" }],
			stats: busy,
			polls: [],
		});
		expect(decision.intervalMinutes).toBe(15);
		expect(decision.intervalSetBy).toBe("athena");
		expect(decision.intervalReason).toMatch(/harbour strike/i);
		// 48 hours at fifteen minutes was never on offer.
		const hours = (new Date(decision.intervalExpiresAt).getTime() - Date.now()) / 3_600_000;
		expect(hours).toBeLessThanOrEqual(12.01);
		expect(hours).toBeGreaterThan(1);
	});

	test("a model answer off the ladder leaves the rules in charge", async () => {
		llm.generateJson.mockRejectedValue(new Error("interval_minutes must be one of 15, 30, ..."));
		const decision = await cadence.decide({
			source,
			added: [{ title: "A profile of the new harbourmaster" }],
			stats: busy,
			polls: [],
		});
		expect(decision.intervalSetBy).toBe("rules");
		expect(cadence.STEPS).toContain(decision.intervalMinutes);
	});

	test("no model at all still speeds up for a story that reads urgent", async () => {
		llm.generateJson.mockRejectedValue(new Error("no endpoint available"));
		const decision = await cadence.decide({
			source,
			added: [{ title: "Breaking: harbour evacuated after chemical leak" }],
			stats: busy,
			polls: [],
		});
		expect(decision.intervalMinutes).toBeLessThan(360);
		expect(decision.intervalExpiresAt).toBeTruthy();
		expect(decision.intervalSetBy).toBe("rules");
	});

	test("nothing new spends no model call", async () => {
		const decision = await cadence.decide({ source, added: [], stats: busy, polls: [] });
		expect(llm.generateJson).not.toHaveBeenCalled();
		expect(decision.intervalSetBy).toBe("rules");
	});

	test("a borrowed interval is held while it earns it, then given back", async () => {
		const hot = {
			...source,
			intervalMinutes: 15,
			intervalSetBy: "athena",
			intervalReason: "Something is unfolding.",
			intervalExpiresAt: new Date(Date.now() + 3_600_000),
		};
		const held = await cadence.decide({ source: hot, added: [], stats: busy, polls: [{ status: "ok", itemsNew: 0 }] });
		expect(held.intervalMinutes).toBe(15);

		const quiet = [
			{ status: "ok", itemsNew: 0 },
			{ status: "ok", itemsNew: 0 },
			{ status: "ok", itemsNew: 0 },
		];
		const returned = await cadence.decide({ source: hot, added: [], stats: busy, polls: quiet });
		expect(returned.intervalMinutes).toBeGreaterThan(15);
		expect(returned.intervalReason).toMatch(/quiet/i);
	});

	test("a failing page is backed off, further each time, and never past a day", async () => {
		const once = await cadence.decide({ source, added: [], stats: busy, polls: [], error: "timed out" });
		const often = await cadence.decide({ source: { ...source, consecutiveFailures: 6 }, added: [], stats: busy, polls: [], error: "timed out" });
		expect(once.intervalMinutes).toBeGreaterThan(360);
		expect(often.intervalMinutes).toBe(1440);
		expect(often.intervalReason).toMatch(/refus/i);
	});

	test("the resting rhythm follows the observed change rate, one step at a time", () => {
		const fast = cadence.baselineFor(source, { ...busy, itemsPerHour: 9 });
		expect(fast).toBe(180); // one step down from 360, not straight to 60
		const dead = cadence.baselineFor(source, { ...busy, itemsPerHour: 0 });
		expect(dead).toBe(720);
		// Not enough visits to have an opinion yet.
		expect(cadence.baselineFor(source, { polls: 1, itemsPerHour: 20 })).toBe(360);
	});
});

describe("stored headlines", () => {
	test("only headlines we have not seen before count as new", async () => {
		pool.query
			.mockResolvedValueOnce([[{ item_hash: store.sha1("https://news.example.com/old") }]])
			.mockResolvedValueOnce([{ affectedRows: 2 }]);
		const saved = await store.saveItems(7, [
			{ title: "An old story we already had", url: "https://news.example.com/old", slot: 1 },
			{ title: "A story we have not seen before", url: "https://news.example.com/new", slot: 2 },
		]);
		expect(saved.found).toBe(2);
		expect(saved.added.map((item) => item.title)).toEqual(["A story we have not seen before"]);
	});
});
