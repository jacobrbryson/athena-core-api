/**
 * Turning a news page into headlines.
 *
 * There is no standard for this, which is exactly why the feature this
 * replaces asked people to go and find an RSS URL. So we read the page the
 * way a person skimming it does, in two passes:
 *
 *   1. Structured data. Most publishers embed JSON-LD (NewsArticle, ItemList)
 *      because search engines pay them to. When it is there it is the best
 *      answer available — real headline, real link, real timestamp.
 *   2. Links. Strip the chrome (nav, header, footer, aside), then harvest
 *      anchors whose text reads like a headline and whose href reads like an
 *      article rather than a section.
 *
 * Both passes are heuristics and both are wrong sometimes. That is survivable
 * here in a way it would not be elsewhere: the worst case is a "Subscribe now"
 * in someone's reading list, not a wrong answer about their own life. What the
 * heuristics must NOT do is churn — a page that yields different junk every
 * visit would read as constant breaking news and drag the interval down to
 * fifteen minutes, so anything unstable (timestamps in link text, ad slots) is
 * filtered rather than merely ranked low.
 *
 * A pasted feed URL still works, through the parser in ./feed.js.
 * Feeds are not the point any more, but a person who pastes one meant it.
 */
const { parseFeed } = require("./feed");

const MAX_ITEMS = 40;
const MIN_TITLE = 20;
const MAX_TITLE = 300;

/** Chrome that never contains the story list, removed before harvesting. */
const CHROME = /<(nav|header|footer|aside|form|select)\b[\s\S]*?<\/\1>/gi;
const DEAD = /<(script|style|svg|noscript|template|iframe)\b[\s\S]*?<\/\1>/gi;

/**
 * Link text that is furniture, however long it is. Anchored at the start,
 * because these are how a navigational link BEGINS — "All Africa stories",
 * "Most viewed in world news", "Listen · 4:19" — while a headline that happens
 * to contain one of these words does not open with it.
 */
const FURNITURE =
	/^(sign in|sign up|log ?in|subscribe|subscription|newsletters?|menu|search|home|more from|more on|more|share|advertisement|advertise|contact( us)?|about( us)?|privacy|terms|cookies?|careers|jobs|accessibility|sitemap|skip to (main )?content|follow us|download the app|gift( an)? article|save|comments?|listen|watch live|most (viewed|read|popular)|all [\w\s]{0,24}(stories|coverage|sections)|see all|view all|latest (from|news|updates)|browse|explore|episodes?|full (episode|story|coverage))\b/i;
/**
 * Paths that are never a story.
 *
 * The second half of this list is the one that matters, and it was written
 * against real pages: a publisher's standing furniture — programmes, podcasts,
 * section indexes, staff pages — is linked from the body of the page, not just
 * the nav, and "All Things Considered" reads exactly like a headline. It is
 * stable text, so it never triggers a false "something is happening"; it just
 * quietly fills a reading list with things that are not news.
 */
const NON_STORY =
	/^\/(subscribe|account|login|signin|register|newsletters?|privacy|terms|cookie|about|contact|careers|jobs|advertis|sitemap|search|tag|tags|topic|topics|author|authors|profile|preferences|help|support|rss|feed|programs?|programmes?|podcasts?|sections?|series|shows?|people|staff|player|listen|watch|live-tv|schedule|music|games|puzzles|crossword|shop|store|donate|events|corrections|standards|ethics|apps?)(\/|$)/i;

/** The named entities that actually turn up in headlines and in hrefs. */
const NAMED = {
	quot: '"', apos: "'", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
	lt: "<", gt: ">", nbsp: " ", middot: "·", bull: "•", ndash: "–",
	mdash: "—", hellip: "…", deg: "°", pound: "£", euro: "€", amp: "&",
};
/**
 * Numeric entities first, then names. An unknown name is left alone rather than
 * blanked: `&foo;` in a headline is more likely to be text than an entity.
 */
const decodeEntities = (value) =>
	String(value)
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&([a-z]+);/gi, (match, name) => NAMED[name.toLowerCase()] ?? match);

const textOf = (html) =>
	decodeEntities(String(html).replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim();

/**
 * The part of a hostname that identifies the publisher. Crude on purpose:
 * it only has to answer "is this link still on the site I pasted?", and the
 * two-label rule plus a short list of registry suffixes covers the news
 * domains people actually read.
 */
function siteKey(hostname) {
	const labels = String(hostname).toLowerCase().split(".");
	if (labels.length <= 2) return labels.join(".");
	const secondLevel = labels[labels.length - 2];
	const topLevel = labels[labels.length - 1];
	// bbc.co.uk, asahi.co.jp: the "domain" is three labels, not two.
	const registrySuffix = topLevel.length === 2 && /^(co|com|net|org|gov|ac|edu|or|ne|go)$/.test(secondLevel);
	return labels.slice(registrySuffix ? -3 : -2).join(".");
}

/** Resolve, strip tracking, and drop the fragment, so the same story hashes the same. */
function canonical(href, base) {
	let url;
	try {
		// The href as written is HTML, so &amp; in a query string is an
		// ampersand. Without decoding it first, one story can hash two ways.
		url = new URL(decodeEntities(String(href).trim()), base);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	url.protocol = "https:";
	url.hash = "";
	url.hostname = url.hostname.toLowerCase();
	for (const key of [...url.searchParams.keys()]) {
		if (/^(utm_|fbclid|gclid|mc_|icid|ito$|at_|smid|partner$|ref$|s_campaign)/i.test(key)) url.searchParams.delete(key);
	}
	if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.replace(/\/+$/, "");
	const value = url.toString();
	return value.length <= 1000 ? value : null;
}

/** Files that are not pages. A link to an mp3 is not a headline. */
const RESOURCE = /\.(mp3|mp4|m3u8|pdf|jpe?g|png|gif|webp|svg|zip|xml|ics|rss|json|css|js)$/i;

/**
 * Does this path look like one story rather than a section index?
 *
 * Written against real publishers, where an article URL is always one of three
 * shapes: a date in the path, an article id, or a slug of three or more words.
 * `/world/americas` is none of them — which is the point, because it is linked
 * with text that reads exactly like a headline ("All Americas stories") and it
 * is a section.
 */
function pathShape(pathname) {
	const segments = pathname.split("/").filter(Boolean);
	const last = segments.length ? segments[segments.length - 1] : "";
	return {
		segments,
		dated: segments.some((segment) => /^(19|20)\d{2}$/.test(segment)),
		slug: last.split("-").filter(Boolean).length >= 3,
		// c63d7lexyym1o, nx-s1-5969816: an id, not a word.
		id: last.length >= 8 && /\d/.test(last),
	};
}

function storyPath(pathname) {
	if (NON_STORY.test(pathname) || RESOURCE.test(pathname)) return false;
	const shape = pathShape(pathname);
	if (!shape.segments.length) return false;
	return shape.dated || shape.slug || shape.id;
}

function usableTitle(title) {
	if (!title || title.length < MIN_TITLE || title.length > MAX_TITLE) return false;
	if (FURNITURE.test(title)) return false;
	if (title.split(/\s+/).length < 3) return false;
	// Bare timestamps and counters change every visit and would read as news.
	if (/^\d[\d\s:./-]*$/.test(title)) return false;
	return true;
}

/** Walk any JSON-LD shape and keep the things with a headline on them. */
function harvestJsonLd(html, base) {
	// A publisher's WebPage block carries the page's OWN title and description,
	// which would otherwise arrive as the lead story ("BBC News - Breaking
	// news, video and the latest top stories...").
	const pageItself = canonical(base, base);
	const items = [];
	const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
	for (const block of blocks) {
		const body = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
		let parsed;
		try {
			parsed = JSON.parse(decodeEntities(body));
		} catch {
			continue;
		}
		const seen = new Set();
		const walk = (node, depth) => {
			if (!node || depth > 6 || items.length >= MAX_ITEMS) return;
			if (Array.isArray(node)) return node.forEach((child) => walk(child, depth + 1));
			if (typeof node !== "object" || seen.has(node)) return;
			seen.add(node);
			const headline = typeof node.headline === "string" ? node.headline : typeof node.name === "string" ? node.name : null;
			const href =
				(typeof node.url === "string" && node.url) ||
				(typeof node.mainEntityOfPage === "string" && node.mainEntityOfPage) ||
				(node.mainEntityOfPage && typeof node.mainEntityOfPage["@id"] === "string" && node.mainEntityOfPage["@id"]) ||
				null;
			if (headline && href) {
				const title = textOf(headline);
				const url = canonical(href, base);
				if (url && url !== pageItself && usableTitle(title)) {
					items.push({
						title,
						url,
						summary: typeof node.description === "string" ? textOf(node.description).slice(0, 1000) : null,
						published: typeof node.datePublished === "string" ? node.datePublished : null,
					});
				}
			}
			for (const value of Object.values(node)) if (value && typeof value === "object") walk(value, depth + 1);
		};
		walk(parsed, 0);
	}
	return items;
}

/**
 * The headline out of one anchor's contents, and whatever else it was carrying.
 *
 * Modern news cards wrap the whole card in the link — headline, standfirst,
 * "11 hrs ago", section name — so the plain text of an anchor is not a
 * headline. When the card has a heading element in it (and they nearly all do)
 * that heading IS the headline and the rest is the summary. The relative
 * timestamp is cut off either way, because it is the one part of a card that is
 * different every single visit.
 */
const RELATIVE_TIME = /\s*\d+\s*(?:hr|hrs|hour|hours|min|mins|minute|minutes|sec|secs|day|days|week|weeks)\s+ago\b[\s\S]*$/i;

function titleFromAnchor(inner) {
	const heading = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/i.exec(inner);
	const whole = textOf(inner).replace(RELATIVE_TIME, "").trim();
	if (heading) {
		const title = textOf(heading[2]).replace(RELATIVE_TIME, "").trim();
		const rest = whole.startsWith(title) ? whole.slice(title.length).trim() : "";
		return { title, summary: rest ? rest.slice(0, 1000) : null };
	}
	// No heading. Keep the leading sentence rather than the whole card, so a
	// title stays a title; anything past it is the summary.
	if (whole.length > 200) {
		const cut = whole.lastIndexOf(" ", 200);
		return { title: whole.slice(0, cut > MIN_TITLE ? cut : 200).trim(), summary: whole.slice(cut).trim().slice(0, 1000) };
	}
	return { title: whole, summary: null };
}

/**
 * A sub-section of the page we were given, rather than a story on it.
 *
 * Paste a section page and its siblings are the most convincing junk on it:
 * `/world/south-and-central-asia` is a perfectly good slug, linked with text
 * that reads like a headline ("South and Central Asia"). What it is not is a
 * story, and the tell is that it sits under the same path with no date and no
 * article id, under a label too short to be a headline.
 */
function subSection(pathname, title, basePath) {
	if (basePath.length <= 1 || !pathname.startsWith(`${basePath}/`)) return false;
	const shape = pathShape(pathname);
	return !shape.dated && !shape.id && title.split(/\s+/).length < 6;
}

/** Anchors that read like stories, in the order the page lists them. */
function harvestLinks(html, base, { sameSiteOnly }) {
	const baseKey = siteKey(new URL(base).hostname);
	const self = canonical(base, base);
	const basePath = new URL(self || base).pathname.replace(/\/+$/, "");
	const items = [];
	const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
	let match;
	while ((match = pattern.exec(html)) && items.length < MAX_ITEMS * 3) {
		const url = canonical(match[1], base);
		if (!url || url === self) continue; // a page's link to itself is not a story
		const parsed = new URL(url);
		if (sameSiteOnly && siteKey(parsed.hostname) !== baseKey) continue;
		if (!storyPath(parsed.pathname)) continue;
		const { title, summary } = titleFromAnchor(match[2]);
		if (!usableTitle(title)) continue;
		if (subSection(parsed.pathname, title, basePath)) continue;
		items.push({ title, url, summary, published: null });
	}
	return items;
}

/**
 * Merge the two passes into one ordered list. JSON-LD first because it is the
 * publisher's own account of the page; links fill in behind it. Deduped by
 * URL and then by title, because the same story is usually linked twice (once
 * from the image, once from the headline).
 */
function merge(...lists) {
	const byUrl = new Set();
	const byTitle = new Set();
	const items = [];
	for (const list of lists) {
		for (const item of list) {
			const titleKey = item.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
			if (byUrl.has(item.url) || byTitle.has(titleKey)) continue;
			byUrl.add(item.url);
			byTitle.add(titleKey);
			items.push({ ...item, slot: items.length + 1 });
			if (items.length >= MAX_ITEMS) return items;
		}
	}
	return items;
}

const looksLikeFeed = (body, contentType) =>
	/(rss|atom)\+xml/i.test(contentType || "") || /^\s*(<\?xml[^>]*\?>\s*)?<(rss|feed|rdf:RDF)[\s>]/i.test(body || "");

/** Headlines from a feed, using the parser that already exists for them. */
function fromFeed(body, base) {
	return merge(
		parseFeed(body)
			.map((entry) => ({
				title: textOf(entry.title || "").slice(0, MAX_TITLE),
				url: entry.link ? canonical(entry.link, base) : null,
				summary: entry.summary ? textOf(entry.summary).slice(0, 1000) : null,
				published: entry.published || null,
			}))
			.filter((entry) => entry.title.length >= 3 && entry.url)
	);
}

/**
 * The headlines on this page, best effort, newest-looking first.
 *
 * Falls back to accepting off-site links when the same-site pass finds almost
 * nothing, because the page is then probably an aggregator — and someone who
 * pastes an aggregator wants what it points at.
 */
function extractItems(body, base, contentType = "") {
	if (!body || typeof body !== "string") return [];
	if (looksLikeFeed(body, contentType)) return fromFeed(body, base);

	const stripped = String(body).replace(/<!--[\s\S]*?-->/g, " ").replace(DEAD, " ");
	const structured = harvestJsonLd(body, base);
	const main = stripped.replace(CHROME, " ");
	let links = harvestLinks(main, base, { sameSiteOnly: true });
	// Fewer than three of the site's own stories means this is not a section page
	// we can read as one — most likely an aggregator, whose whole value is the
	// links it points off-site.
	if (structured.length + links.length < 3) links = harvestLinks(main, base, { sameSiteOnly: false });
	return merge(structured, links);
}

module.exports = { extractItems, looksLikeFeed, canonical, siteKey, storyPath, usableTitle, textOf };
