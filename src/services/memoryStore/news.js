/**
 * News memory: Athena reads the headlines so she can talk about the world.
 *
 * Pulls RSS/Atom feeds (NEWS_FEEDS, comma-separated) into world-scope
 * memory_event rows (kind "news", profile_id NULL), deduped by link. They're
 * recallable by everyone, and recall only looks back 45 days so old news
 * fades naturally. No API keys, no dependencies: a small tolerant parser.
 */
const crypto = require("crypto");
const { createEvent } = require("./events");

const DEFAULT_FEEDS = ["https://feeds.npr.org/1001/rss.xml", "https://feeds.bbci.co.uk/news/rss.xml"];
const PER_FEED = 20;

function feeds() {
	const raw = process.env.NEWS_FEEDS;
	if (raw === "") return [];
	return (raw ? raw.split(",") : DEFAULT_FEEDS).map((s) => s.trim()).filter(Boolean);
}

function decodeEntities(s) {
	return s
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;|&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");
}

function text(block, tag) {
	const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
	if (!m) return "";
	return decodeEntities(m[1])
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Parse RSS <item> or Atom <entry> blocks. */
function parseFeed(xml) {
	const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
	return blocks.map((b) => {
		const atomLink = b.match(/<link[^>]*href="([^"]+)"/i);
		return {
			title: text(b, "title"),
			link: text(b, "link") || (atomLink ? atomLink[1] : ""),
			summary: text(b, "description") || text(b, "summary") || text(b, "content"),
			published: text(b, "pubDate") || text(b, "published") || text(b, "updated") || null,
		};
	});
}

async function fetchFeed(url) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	try {
		const res = await fetch(url, {
			headers: { "User-Agent": "Athena/1.0 (+news memory)" },
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.text();
	} finally {
		clearTimeout(timer);
	}
}

/** Ingest all feeds. Returns { feeds, added, skipped, failed }. */
async function ingestNews() {
	const totals = { feeds: 0, added: 0, skipped: 0, failed: 0 };
	for (const url of feeds()) {
		try {
			const items = parseFeed(await fetchFeed(url)).slice(0, PER_FEED);
			totals.feeds += 1;
			for (const item of items) {
				if (!item.title) continue;
				const dedupeKey = crypto.createHash("sha1").update(item.link || item.title).digest("hex");
				const published = item.published ? new Date(item.published) : null;
				const created = await createEvent({
					scope: "world",
					kind: "news",
					title: item.title.slice(0, 200),
					content: item.summary ? `${item.title}. ${item.summary}`.slice(0, 1500) : item.title,
					occurredAt: published && !Number.isNaN(published.getTime()) ? published : null,
					importance: 3,
					source: "feed",
					dedupeKey,
					metadata: { link: item.link || null, feed: url },
				});
				if (created) totals.added += 1;
				else totals.skipped += 1;
			}
		} catch (err) {
			totals.failed += 1;
			console.warn(`[news] feed failed ${url}:`, err.message);
		}
	}
	return totals;
}

module.exports = { ingestNews, parseFeed, feeds };
