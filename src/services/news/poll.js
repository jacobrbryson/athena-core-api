/**
 * One visit to one page: read it, keep what is new, decide when to come back.
 *
 * Four things make a visit cheap, and they are checked in this order because
 * each one can end it early:
 *
 *   robots.txt   cached for a day. A site that says no gets asked once.
 *   ETag         a conditional GET, so an unchanged page returns no body.
 *   body hash    some sites rebuild every page on every request; the hash
 *                catches "changed but identical" before extraction runs.
 *   new items    a page whose headlines we already have costs no model call.
 *
 * A visit never throws. A page that is down, blocked, malformed or simply
 * gone becomes a recorded failure and a longer interval — the poller's job is
 * to keep working through a list, not to stop on one bad site.
 */
const { fetchPage, robotsFor, pageUrl } = require("./fetch");
const { extractItems } = require("./extract");
const cadence = require("./cadence");
const store = require("./store");
const { createEvent } = require("../memoryStore/events");

const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const MINUTE = 60_000;

const nextCheck = (minutes) => new Date(Date.now() + Math.max(1, minutes) * MINUTE);

/**
 * Write a headline into Athena's world memory. World scope, so it is
 * recallable by everyone and dies out of recall on its own after 45 days; the
 * item hash is the dedupe key, so a re-run of this is free.
 */
async function remember(source, item, hash) {
	const published = item.published ? new Date(item.published) : null;
	return createEvent({
		scope: "world",
		kind: "news",
		title: String(item.title).slice(0, 200),
		content: item.summary ? `${item.title}. ${item.summary}`.slice(0, 1500) : item.title,
		occurredAt: published && !Number.isNaN(published.getTime()) ? published : null,
		importance: 3,
		source: "news",
		dedupeKey: hash,
		metadata: { link: item.url || null, page: source.url, publisher: source.label || source.host },
	}).catch(() => null);
}

/** robots.txt for this source, re-asked once a day. */
async function robots(source) {
	const fresh =
		source.robotsCheckedAt && Date.now() - new Date(source.robotsCheckedAt).getTime() < ROBOTS_TTL_MS;
	if (fresh) return { allowed: source.robotsAllowed !== false, crawlDelay: source.robotsDelayS, cached: true };
	const answer = await robotsFor(source.url).catch(() => ({ allowed: true, crawlDelay: null }));
	return { ...answer, cached: false };
}

/**
 * Visit one source. Returns a summary of what happened; writes the source's
 * new schedule, its headlines, and (for world-scope sources) memories.
 *
 * `dryRun` still fetches and extracts — that is the part worth testing against
 * a real site — it just writes nothing.
 */
async function pollSource(source, { dryRun = false } = {}) {
	const started = Date.now();
	const before = source.intervalMinutes;
	const result = { uuid: source.uuid, host: source.host, status: "ok", found: 0, added: 0, intervalBefore: before };

	try {
		pageUrl(source.url); // a source stored before a rule tightened must still be refused
		const permission = await robots(source);
		const robotsPatch = permission.cached
			? {}
			: { robotsAllowed: permission.allowed, robotsDelayS: permission.crawlDelay ?? null, robotsCheckedAt: new Date() };

		if (!permission.allowed) {
			result.status = "blocked";
			result.note = "The site asks readers not to fetch this page.";
			if (!dryRun) {
				await store.saveSchedule(source.id, {
					...robotsPatch,
					intervalMinutes: 1440,
					intervalSetBy: "rules",
					intervalReason: "This site asks not to be read automatically.",
					intervalExpiresAt: null,
					nextCheckAt: nextCheck(1440),
					lastCheckedAt: new Date(),
					lastError: result.note,
				});
				await store.recordPoll(source.id, { status: "blocked", ms: Date.now() - started, intervalBefore: before, intervalAfter: 1440, decidedBy: "rules", note: result.note });
			}
			result.intervalAfter = 1440;
			return result;
		}

		const response = await fetchPage(source.url, { etag: source.etag, lastModified: source.lastModified });
		result.httpStatus = response.status;

		let added = [];
		let found = 0;
		let unchanged = response.status === 304;
		let contentHash = source.contentHash;

		if (!unchanged) {
			contentHash = store.sha1(response.body);
			if (contentHash === source.contentHash) unchanged = true;
			else {
				const items = extractItems(response.body, response.finalUrl, response.contentType);
				found = items.length;
				if (items.length) {
					// A dry run asks the same question and writes nothing, so its
					// "new" count is the real one rather than the whole page.
					const saved = dryRun ? await store.unseen(source.id, items) : await store.saveItems(source.id, items);
					added = saved.added;
				}
			}
		}
		result.found = found;
		result.added = added.length;
		result.status = unchanged ? "unchanged" : "ok";

		const [stats, polls] = await Promise.all([store.pollStats(source.id), store.lastPolls(source.id)]);
		const decision = await cadence.decide({ source: { ...source, robotsDelayS: permission.crawlDelay ?? source.robotsDelayS }, added, stats, polls });

		result.intervalAfter = decision.intervalMinutes;
		result.decidedBy = decision.intervalSetBy;
		result.note = decision.intervalReason || null;

		if (dryRun) return result;

		await store.saveSchedule(source.id, {
			...robotsPatch,
			intervalMinutes: decision.intervalMinutes,
			baselineMinutes: decision.baselineMinutes,
			intervalSetBy: decision.intervalSetBy,
			intervalReason: decision.intervalReason,
			intervalExpiresAt: decision.intervalExpiresAt ?? null,
			nextCheckAt: nextCheck(decision.intervalMinutes),
			lastCheckedAt: new Date(),
			...(added.length ? { lastChangedAt: new Date() } : {}),
			etag: response.etag ?? source.etag,
			lastModified: response.lastModified ?? source.lastModified,
			contentHash,
			consecutiveFailures: 0,
			lastError: null,
		});
		await store.recordPoll(source.id, {
			status: result.status,
			httpStatus: response.status,
			found,
			added: added.length,
			ms: Date.now() - started,
			intervalBefore: before,
			intervalAfter: decision.intervalMinutes,
			decidedBy: decision.intervalSetBy,
			note: decision.intervalReason,
		});

		if (source.scope === "world" && added.length) {
			for (const item of added) await remember(source, item, item.hash);
		}
		return result;
	} catch (err) {
		const message = String(err?.message || err).slice(0, 300);
		result.status = "error";
		result.note = message;
		if (!dryRun) {
			const stats = await store.pollStats(source.id).catch(() => null);
			const decision = await cadence.decide({ source, added: [], stats, polls: [], error: message });
			result.intervalAfter = decision.intervalMinutes;
			await store
				.saveSchedule(source.id, {
					intervalMinutes: decision.intervalMinutes,
					baselineMinutes: decision.baselineMinutes,
					intervalSetBy: decision.intervalSetBy,
					intervalReason: decision.intervalReason,
					nextCheckAt: nextCheck(decision.intervalMinutes),
					lastCheckedAt: new Date(),
					consecutiveFailures: (source.consecutiveFailures || 0) + 1,
					lastError: message,
				})
				.catch(() => undefined);
			await store
				.recordPoll(source.id, {
					status: "error",
					ms: Date.now() - started,
					intervalBefore: before,
					intervalAfter: decision.intervalMinutes,
					decidedBy: decision.intervalSetBy,
					note: message,
				})
				.catch(() => undefined);
		}
		return result;
	}
}

/**
 * Visit everything that is due, a few at a time.
 *
 * Sequential per host is the point: these are other people's servers and the
 * whole list is a handful of pages. `concurrency` exists so a run of twenty
 * slow sites does not take four minutes, not to go fast.
 */
async function pollDue({ limit = 20, profileId = null, dryRun = false, concurrency = 3 } = {}) {
	const sources = await store.claimDue({ limit, profileId });
	const results = [];
	for (let i = 0; i < sources.length; i += concurrency) {
		const batch = sources.slice(i, i + concurrency);
		results.push(...(await Promise.all(batch.map((source) => pollSource(source, { dryRun })))));
	}
	return {
		checked: results.length,
		changed: results.filter((r) => r.added > 0).length,
		failed: results.filter((r) => r.status === "error").length,
		results,
	};
}

module.exports = { pollSource, pollDue };
