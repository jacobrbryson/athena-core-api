/**
 * The small tolerant RSS/Atom parser.
 *
 * Feeds are no longer how this feature works — a source is a page you paste —
 * but a person who pastes a feed URL meant it, and plenty of the sources
 * already saved under the old feature are feeds. So the parser stays: no
 * dependencies, no schema, just enough XML tolerance to get titles and links
 * out of whatever a publisher emits.
 *
 * Lives here rather than in memoryStore because memory is now a CONSUMER of
 * the news watcher rather than the thing that fetches news itself.
 * `memoryStore/news.js` re-exports `parseFeed` for its existing callers.
 */
function decodeEntities(value) {
	return value
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
	const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
	if (!match) return "";
	return decodeEntities(match[1])
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Parse RSS <item> or Atom <entry> blocks. */
function parseFeed(xml) {
	const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
	return blocks.map((block) => {
		const atomLink = block.match(/<link[^>]*href="([^"]+)"/i);
		return {
			title: text(block, "title"),
			link: text(block, "link") || (atomLink ? atomLink[1] : ""),
			summary: text(block, "description") || text(block, "summary") || text(block, "content"),
			published: text(block, "pubDate") || text(block, "published") || text(block, "updated") || null,
		};
	});
}

module.exports = { parseFeed, decodeEntities };
