/**
 * Athena's news watcher. Import this — not the files beside it.
 *
 *   news.getSources(profileId)            what she is watching, and how often
 *   news.setSources(profileId, urls)      paste a list of pages; she takes it from there
 *   news.addSource / removeSource / updateSource
 *   news.getNews(profileId)               the headlines, from what she has already read
 *   news.checkNow(profileId)              look now, for the person who just added a page
 *   news.pollDue() / news.pollSource()    the scheduled job's entry points
 *   news.seedHouseSources()               NEWS_FEEDS -> unowned world sources
 *   news.catchUpWorldMemory()             anything the poller failed to remember
 *
 * The design in one line: a source is a PAGE, not a feed; the interval is
 * Athena's to set and nobody else's to maintain; and reading the dashboard
 * never fetches anything, because everything shown was already read in the
 * background. See docs/architecture/news-watch.md.
 *
 * `../memoryStore/news.js` re-exports the feed parser from here and delegates
 * its nightly ingest to `catchUpWorldMemory`, so memory is a consumer of this
 * service rather than a second thing that fetches news.
 */
const { pageUrl } = require("./fetch");
const { pollSource, pollDue } = require("./poll");
const { createEvent } = require("../memoryStore/events");
const cadence = require("./cadence");
const store = require("./store");

/** Enough for a real reading list, few enough to stay a polite neighbour. */
const MAX_SOURCES = Number(process.env.NEWS_MAX_SOURCES) || 12;
/** A person pressing "check now" repeatedly must not become a load generator. */
const CHECK_NOW_COOLDOWN_MS = 60_000;
const checkedRecently = new Map(); // profileId -> timestamp

const tooMany = () =>
	Object.assign(new Error(`I can watch up to ${MAX_SOURCES} pages for you.`), { status: 400 });

/** "every 15 minutes", "every 6 hours", "daily" — the interval, in words. */
function rhythm(minutes) {
	if (minutes >= 1440) return "daily";
	if (minutes === 60) return "hourly";
	if (minutes < 60) return `every ${minutes} minutes`;
	const hours = Math.round(minutes / 60);
	return `every ${hours} hours`;
}

/**
 * What the API and the dashboard see. Note what is NOT here: the ETag, the
 * content hash, the robots cache. A person tuning their reading list has no
 * use for our fetch bookkeeping.
 */
function publicSource(source, headlineCount) {
	return {
		uuid: source.uuid,
		url: source.url,
		host: source.host,
		label: source.label,
		scope: source.scope,
		enabled: source.enabled,
		everyMinutes: source.intervalMinutes,
		rhythm: rhythm(source.intervalMinutes),
		baselineMinutes: source.baselineMinutes,
		// Who chose this rhythm, and why. 'athena' is the only one worth showing
		// a person a sentence for; 'rules' and 'default' speak for themselves.
		setBy: source.intervalSetBy,
		reason: source.intervalReason,
		fasterUntil: source.intervalExpiresAt ? new Date(source.intervalExpiresAt).toISOString() : null,
		lastCheckedAt: source.lastCheckedAt ? new Date(source.lastCheckedAt).toISOString() : null,
		nextCheckAt: source.nextCheckAt ? new Date(source.nextCheckAt).toISOString() : null,
		lastChangedAt: source.lastChangedAt ? new Date(source.lastChangedAt).toISOString() : null,
		// Redacted to one sentence upstream; never a stack or a URL with a token.
		lastError: source.lastError,
		headlines: headlineCount ?? 0,
	};
}

/**
 * Move an old RSS list into the new table, once. A person who saved eight feed
 * URLs under the previous feature should find them still there, still working
 * (feeds parse), just now on a rhythm they no longer have to think about.
 */
async function adoptLegacy(profileId) {
	if (await store.countSources(profileId)) return;
	const legacy = await store.legacySources(profileId);
	for (const value of legacy.slice(0, MAX_SOURCES)) {
		try {
			const url = pageUrl(value);
			await store.addSource(profileId, { url, host: new URL(url).hostname, scope: "world" });
		} catch {
			// A URL the old rules allowed and these do not is simply dropped.
		}
	}
}

async function getSources(profileId) {
	await adoptLegacy(profileId);
	const [sources, counts] = await Promise.all([store.listSources(profileId), store.itemCounts(profileId)]);
	return sources.map((source) => publicSource(source, counts.get(source.uuid)));
}

/**
 * Add a page. `scope: "world"` (the default) means Athena also keeps what she
 * reads there in her own memory of the world, so she can bring it up in
 * conversation; "personal" keeps it on the dashboard only. The person chooses,
 * and the panel says which it is.
 */
async function addSource(profileId, value, { label = null, scope = "world" } = {}) {
	const url = pageUrl(typeof value === "string" ? value : value?.url);
	const host = new URL(url).hostname;
	const existing = await store.listSources(profileId);
	if (!existing.some((source) => source.url === url) && existing.length >= MAX_SOURCES) throw tooMany();
	// 6 hours to start with, because it is the least wrong guess for a page
	// nobody has watched yet. Three visits from now it will be arithmetic.
	const source = await store.addSource(profileId, { url, host, label, scope: scope === "personal" ? "personal" : "world", intervalMinutes: 360 });
	return publicSource(source, 0);
}

async function removeSource(profileId, uuid) {
	const source = await store.sourceByUuid(profileId, uuid);
	if (!source) return false;
	return store.removeSource(profileId, source.id);
}

async function updateSource(profileId, uuid, patch) {
	const source = await store.sourceByUuid(profileId, uuid);
	if (!source) return null;
	await store.updateSourceOptions(profileId, source.id, patch);
	const updated = await store.sourceByUuid(profileId, uuid);
	return publicSource(updated, 0);
}

/**
 * Replace the whole list from what someone pasted — one page per line.
 *
 * Reconciles rather than rewrites: a page that is already on the list keeps its
 * rhythm, its history and its headlines. Only what they actually removed is
 * removed. Order does not matter and duplicates are harmless.
 */
async function setSources(profileId, values) {
	if (!Array.isArray(values)) throw Object.assign(new Error("Send a list of pages."), { status: 400 });
	if (values.length > MAX_SOURCES) throw tooMany();

	const wanted = new Map();
	for (const value of values) {
		const raw = typeof value === "string" ? value : value?.url;
		if (!raw || !String(raw).trim()) continue;
		const url = pageUrl(raw); // throws a 400 the panel shows verbatim
		wanted.set(url, {
			url,
			host: new URL(url).hostname,
			label: typeof value === "object" ? value.label || null : null,
			scope: typeof value === "object" && value.scope === "personal" ? "personal" : "world",
		});
	}

	await adoptLegacy(profileId);
	const existing = await store.listSources(profileId);
	for (const source of existing) {
		if (!wanted.has(source.url)) await store.removeSource(profileId, source.id);
	}
	for (const entry of wanted.values()) {
		await store.addSource(profileId, { ...entry, intervalMinutes: 360 });
	}
	return getSources(profileId);
}

/**
 * The news, from what has already been read. No outbound request happens here:
 * opening a dashboard should not make sixteen strangers' servers work, and the
 * old version did exactly that on every glance.
 */
async function getNews(profileId) {
	await adoptLegacy(profileId);
	const [sources, counts, items] = await Promise.all([
		store.listSources(profileId),
		store.itemCounts(profileId),
		store.recentItems(profileId, { limit: 60, days: 7 }),
	]);
	const checked = sources.map((source) => source.lastCheckedAt).filter(Boolean);
	return {
		sources: sources.map((source) => publicSource(source, counts.get(source.uuid))),
		items,
		// The freshest thing we know, not the moment this request was served.
		checkedAt: checked.length ? new Date(Math.max(...checked.map((at) => new Date(at).getTime()))).toISOString() : null,
	};
}

/**
 * Look now. For the moment after someone pastes a page and wants to see that
 * it worked — not a refresh button, and rate limited per person because it is
 * the one path where a person's click reaches someone else's server.
 */
async function checkNow(profileId) {
	const last = checkedRecently.get(profileId) || 0;
	if (Date.now() - last < CHECK_NOW_COOLDOWN_MS) {
		return { checked: 0, changed: 0, failed: 0, cooling: true };
	}
	checkedRecently.set(profileId, Date.now());
	const result = await pollDue({ profileId, limit: MAX_SOURCES });
	return { ...result, cooling: false };
}

/** Visit one named source now, whoever owns it. The job's --source flag. */
async function pollByUuid(uuid, options = {}) {
	const source = await store.sourceByAnyUuid(uuid);
	if (!source) return null;
	return pollSource(source, options);
}

/** NEWS_FEEDS -> unowned sources that feed Athena's world memory. Idempotent. */
async function seedHouseSources() {
	const raw = process.env.NEWS_FEEDS;
	if (raw === "") return { added: 0 };
	const values = (raw ? raw.split(",") : ["https://feeds.npr.org/1001/rss.xml", "https://feeds.bbci.co.uk/news/rss.xml"])
		.map((value) => value.trim())
		.filter(Boolean);
	const known = await store.existingHashes(store.HOUSE_PROFILE);
	let added = 0;
	for (const value of values) {
		try {
			const url = pageUrl(value);
			if (known.has(store.sha1(url))) continue;
			await store.addSource(store.HOUSE_PROFILE, { url, host: new URL(url).hostname, scope: "world", intervalMinutes: 360 });
			added += 1;
		} catch (err) {
			console.warn(`[news] NEWS_FEEDS entry ignored (${value}):`, err.message);
		}
	}
	return { added };
}

/**
 * Write any world-scope headline from the last day that has no memory yet.
 *
 * The poller already remembers as it reads; this is the safety net for the
 * night a memory write failed while the headline was stored. Free to re-run:
 * the item hash is the memory's dedupe key, so everything already remembered
 * is an ignored insert.
 */
async function catchUpWorldMemory({ hours = 26 } = {}) {
	const since = new Date(Date.now() - hours * 3_600_000);
	const rows = await store.worldItemsSince(since, 400);
	const totals = { items: rows.length, added: 0, skipped: 0 };
	for (const row of rows) {
		const published = row.published_at ? new Date(row.published_at) : null;
		const created = await createEvent({
			scope: "world",
			kind: "news",
			title: String(row.title).slice(0, 200),
			content: row.summary ? `${row.title}. ${row.summary}`.slice(0, 1500) : row.title,
			occurredAt: published && !Number.isNaN(published.getTime()) ? published : new Date(row.first_seen_at),
			importance: 3,
			source: "news",
			dedupeKey: row.item_hash,
			metadata: { link: row.url || null, publisher: row.label || row.host },
		}).catch(() => null);
		if (created) totals.added += 1;
		else totals.skipped += 1;
	}
	return totals;
}

module.exports = {
	MAX_SOURCES,
	getSources,
	setSources,
	addSource,
	removeSource,
	updateSource,
	getNews,
	checkNow,
	pollDue,
	pollSource,
	pollByUuid,
	listAll: store.listAll,
	seedHouseSources,
	catchUpWorldMemory,
	worldPollHealth: store.worldPollHealth,
	prune: store.pruneItems,
	rhythm,
	STEPS: cadence.STEPS,
};
