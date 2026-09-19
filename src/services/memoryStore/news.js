/**
 * News memory: Athena reads the headlines so she can talk about the world.
 *
 * She no longer fetches them here. The news watcher (`services/news`) visits
 * the pages people gave her, on an interval it sets itself, and writes each new
 * headline into world-scope memory as it reads — so a story can reach her
 * memory minutes after it appears instead of waiting for the nightly run.
 *
 * What survives in this file is the two things memory still owns:
 *
 *   ingestNews()  the nightly catch-up. Re-walks the last day of world-scope
 *                 headlines and writes any memory that was missed (a failed
 *                 write, a poll that died mid-run). Free to re-run: the item
 *                 hash is the dedupe key, so everything already remembered is
 *                 an ignored insert.
 *   parseFeed     re-exported from services/news/feed for existing callers.
 *
 * Recall still only looks back 45 days, so old news fades on its own.
 */
const { parseFeed } = require("../news/feed");

/** Nightly: seed the unowned NEWS_FEEDS sources, then catch up any missed memories. */
async function ingestNews() {
	// Required lazily: services/news reaches back into ./events, and requiring
	// it at module load would make memoryStore's own index part of that cycle.
	const news = require("../news");
	const seeded = await news.seedHouseSources().catch((err) => ({ added: 0, error: err.message }));
	const totals = await news.catchUpWorldMemory();
	return { ...totals, seeded: seeded.added || 0 };
}

module.exports = { ingestNews, parseFeed };
