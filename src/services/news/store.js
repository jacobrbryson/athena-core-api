/**
 * Everything the news watcher keeps: the sources, the headlines seen on them,
 * and the record of every visit.
 *
 * The only interesting thing in here is `claimDue`. The poller can run from a
 * scheduled job and from a person pressing "check now" at the same time, so
 * due sources are LEASED before they are read — the claim pushes
 * `next_check_at` forward first, and the poll writes the real schedule after.
 * Two runners then cannot both fetch the same page, and a runner that dies
 * mid-poll releases its lease by the clock rather than leaving a source stuck.
 */
const crypto = require("node:crypto");
const { v4: uuidv4 } = require("uuid");
const pool = require("../../helpers/db");

/** Sources with no owner: seeded from NEWS_FEEDS, they feed world memory. */
const HOUSE_PROFILE = 0;

const sha1 = (value) => crypto.createHash("sha1").update(String(value)).digest("hex");
const mysqlDate = (value) => {
	const date = value ? new Date(value) : new Date();
	return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 19).replace("T", " ");
};
const trim = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

const SOURCE_COLUMNS = `id, uuid, profile_id, url, host, label, scope, enabled, interval_minutes,
  baseline_minutes, interval_set_by, interval_reason, interval_expires_at, next_check_at,
  last_checked_at, last_changed_at, etag, last_modified, content_hash, robots_allowed,
  robots_delay_s, robots_checked_at, consecutive_failures, last_error`;

/** Internal row -> the object the rest of the service (and the API) works with. */
function toSource(row) {
	return {
		id: row.id,
		uuid: row.uuid,
		profileId: row.profile_id,
		url: row.url,
		host: row.host,
		label: row.label || row.host,
		scope: row.scope,
		enabled: !!row.enabled,
		intervalMinutes: row.interval_minutes,
		baselineMinutes: row.baseline_minutes,
		intervalSetBy: row.interval_set_by,
		intervalReason: row.interval_reason,
		intervalExpiresAt: row.interval_expires_at,
		nextCheckAt: row.next_check_at,
		lastCheckedAt: row.last_checked_at,
		lastChangedAt: row.last_changed_at,
		etag: row.etag,
		lastModified: row.last_modified,
		contentHash: row.content_hash,
		robotsAllowed: row.robots_allowed === null ? null : !!row.robots_allowed,
		robotsDelayS: row.robots_delay_s,
		robotsCheckedAt: row.robots_checked_at,
		consecutiveFailures: row.consecutive_failures,
		lastError: row.last_error,
	};
}

async function listSources(profileId) {
	const [rows] = await pool.query(
		`SELECT ${SOURCE_COLUMNS} FROM news_source WHERE profile_id = ? ORDER BY created_at`,
		[profileId]
	);
	return rows.map(toSource);
}

async function sourceByUuid(profileId, uuid) {
	const [rows] = await pool.query(
		`SELECT ${SOURCE_COLUMNS} FROM news_source WHERE profile_id = ? AND uuid = ? LIMIT 1`,
		[profileId, uuid]
	);
	return rows.length ? toSource(rows[0]) : null;
}

/**
 * Add a page to someone's list, or wake it up again if it is already there.
 * `intervalMinutes` is only a starting guess — the first few visits replace it
 * with what the page actually does.
 *
 * Re-adding a page it already watches deliberately does NOT move
 * `next_check_at`: saving the panel would otherwise make every source due at
 * once, and editing a list is not a reason to go and knock on twelve doors.
 */
async function addSource(profileId, { url, host, label = null, scope = "world", intervalMinutes = 360 }) {
	await pool.query(
		`INSERT INTO news_source (uuid, profile_id, url, url_hash, host, label, scope,
       interval_minutes, baseline_minutes, next_check_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE enabled = 1, label = COALESCE(VALUES(label), label),
       scope = VALUES(scope), last_error = NULL`,
		[uuidv4(), profileId, url, sha1(url), host, trim(label, 120), scope, intervalMinutes, intervalMinutes]
	);
	const [rows] = await pool.query(
		`SELECT ${SOURCE_COLUMNS} FROM news_source WHERE profile_id = ? AND url_hash = ? LIMIT 1`,
		[profileId, sha1(url)]
	);
	return rows.length ? toSource(rows[0]) : null;
}

/** Forget a page, and the headlines and visit history that came with it. */
async function removeSource(profileId, id) {
	await pool.query(`DELETE FROM news_item WHERE source_id = ?`, [id]);
	await pool.query(`DELETE FROM news_poll WHERE source_id = ?`, [id]);
	const [result] = await pool.query(`DELETE FROM news_source WHERE profile_id = ? AND id = ?`, [profileId, id]);
	return result.affectedRows > 0;
}

/** The person's own settings for a source. Never touches the interval. */
async function updateSourceOptions(profileId, id, { label, scope, enabled }) {
	const sets = [];
	const params = [];
	if (label !== undefined) {
		sets.push("label = ?");
		params.push(trim(label, 120));
	}
	if (scope !== undefined) {
		sets.push("scope = ?");
		params.push(scope === "personal" ? "personal" : "world");
	}
	if (enabled !== undefined) {
		sets.push("enabled = ?");
		params.push(enabled ? 1 : 0);
	}
	if (!sets.length) return false;
	const [result] = await pool.query(`UPDATE news_source SET ${sets.join(", ")} WHERE profile_id = ? AND id = ?`, [
		...params,
		profileId,
		id,
	]);
	return result.affectedRows > 0;
}

/**
 * Take out a lease on the sources that are due, so two runners never fetch the
 * same page at once. The lease is short (the source's own interval, capped at
 * an hour) and the poll overwrites it with the real answer moments later.
 */
async function claimDue({ limit = 20, profileId = null } = {}) {
	const [rows] = await pool.query(
		`SELECT ${SOURCE_COLUMNS} FROM news_source
     WHERE enabled = 1 AND next_check_at <= NOW() ${profileId === null ? "" : "AND profile_id = ?"}
     ORDER BY next_check_at LIMIT ?`,
		profileId === null ? [limit] : [profileId, limit]
	);
	if (!rows.length) return [];
	await pool.query(
		`UPDATE news_source
     SET next_check_at = DATE_ADD(NOW(), INTERVAL LEAST(GREATEST(interval_minutes, 5), 60) MINUTE)
     WHERE id IN (?)`,
		[rows.map((row) => row.id)]
	);
	return rows.map(toSource);
}

/**
 * Which of these headlines we have not seen on this source before. Read-only,
 * so a dry run can answer "what would this visit have brought?" honestly
 * instead of counting the whole page as new.
 */
async function unseen(sourceId, items) {
	const withHashes = items.map((item) => ({ ...item, hash: sha1(item.url || item.title) }));
	if (!withHashes.length) return { all: [], added: [] };
	const [existing] = await pool.query(`SELECT item_hash FROM news_item WHERE source_id = ? AND item_hash IN (?)`, [
		sourceId,
		withHashes.map((item) => item.hash),
	]);
	const known = new Set(existing.map((row) => row.item_hash));
	return { all: withHashes, added: withHashes.filter((item) => !known.has(item.hash)) };
}

/**
 * Store what we saw. Returns the items that were not there before — the one
 * number the cadence decision actually turns on.
 */
async function saveItems(sourceId, items) {
	const { all: withHashes, added } = await unseen(sourceId, items);
	if (!withHashes.length) return { found: 0, added: [] };

	await pool.query(
		`INSERT INTO news_item (source_id, item_hash, title, url, summary, published_at, slot)
     VALUES ? ON DUPLICATE KEY UPDATE last_seen_at = NOW(), slot = VALUES(slot), title = VALUES(title)`,
		[
			withHashes.map((item) => [
				sourceId,
				item.hash,
				String(item.title).slice(0, 300),
				item.url ? String(item.url).slice(0, 1000) : null,
				item.summary ? String(item.summary).slice(0, 1000) : null,
				item.published ? mysqlDate(item.published) : null,
				item.slot || null,
			]),
		]
	);
	return { found: withHashes.length, added };
}

/**
 * The headlines to show someone, newest first. Ordered by when WE first saw
 * them, not by the site's own timestamp: half of those are missing and some
 * of the rest are the moment the page was rebuilt.
 */
async function recentItems(profileId, { limit = 60, days = 7 } = {}) {
	const [rows] = await pool.query(
		`SELECT i.title, i.url, i.summary, i.published_at, i.first_seen_at, i.slot,
            s.uuid AS source_uuid, s.host, s.label
     FROM news_item i JOIN news_source s ON s.id = i.source_id
     WHERE s.profile_id = ? AND s.enabled = 1 AND i.first_seen_at >= NOW() - INTERVAL ? DAY
     ORDER BY i.first_seen_at DESC, i.slot ASC LIMIT ?`,
		[profileId, days, limit]
	);
	return rows.map((row) => ({
		title: row.title,
		url: row.url,
		summary: row.summary,
		published: row.published_at ? new Date(row.published_at).toISOString() : null,
		firstSeen: new Date(row.first_seen_at).toISOString(),
		slot: row.slot,
		sourceUuid: row.source_uuid,
		source: row.label || row.host,
	}));
}

/** New headlines from world-scope sources, for Athena's world memory. */
async function worldItemsSince(since, limit = 200) {
	const [rows] = await pool.query(
		`SELECT i.id, i.item_hash, i.title, i.url, i.summary, i.published_at, i.first_seen_at, s.host, s.label
     FROM news_item i JOIN news_source s ON s.id = i.source_id
     WHERE s.scope = 'world' AND s.enabled = 1 AND i.first_seen_at >= ?
     ORDER BY i.first_seen_at LIMIT ?`,
		[mysqlDate(since), limit]
	);
	return rows;
}

async function recordPoll(sourceId, entry) {
	await pool.query(
		`INSERT INTO news_poll (source_id, status, http_status, items_found, items_new, duration_ms,
       interval_before, interval_after, decided_by, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			sourceId,
			entry.status,
			entry.httpStatus || null,
			entry.found || 0,
			entry.added || 0,
			entry.ms || null,
			entry.intervalBefore || null,
			entry.intervalAfter || null,
			entry.decidedBy || null,
			trim(entry.note, 300),
		]
	);
}

/**
 * How this page has actually behaved lately. This is the deterministic half of
 * the cadence decision — the half that does not need a model and cannot be
 * talked into anything.
 */
async function pollStats(sourceId, hours = 48) {
	const [rows] = await pool.query(
		`SELECT COUNT(*) AS polls, SUM(items_new > 0) AS changed, SUM(items_new) AS items,
            SUM(status = 'error') AS errors, MIN(polled_at) AS since,
            MAX(CASE WHEN decided_by = 'athena' THEN polled_at END) AS last_athena,
            SUM(items_new = 0 AND status <> 'error') AS quiet
     FROM news_poll WHERE source_id = ? AND polled_at >= NOW() - INTERVAL ? HOUR`,
		[sourceId, hours]
	);
	const row = rows[0] || {};
	const polls = Number(row.polls || 0);
	const hoursObserved = row.since ? Math.max(1, (Date.now() - new Date(row.since).getTime()) / 3_600_000) : 0;
	return {
		polls,
		changedPolls: Number(row.changed || 0),
		quietPolls: Number(row.quiet || 0),
		newItems: Number(row.items || 0),
		errors: Number(row.errors || 0),
		hoursObserved: Math.round(hoursObserved * 10) / 10,
		itemsPerHour: hoursObserved ? Math.round((Number(row.items || 0) / hoursObserved) * 10) / 10 : null,
		lastAthenaAt: row.last_athena ? new Date(row.last_athena) : null,
	};
}

/** The last few visits, newest first. Used to count consecutive quiet ones. */
async function lastPolls(sourceId, limit = 6) {
	const [rows] = await pool.query(
		`SELECT status, items_new FROM news_poll WHERE source_id = ? ORDER BY polled_at DESC LIMIT ?`,
		[sourceId, limit]
	);
	return rows.map((row) => ({ status: row.status, itemsNew: Number(row.items_new || 0) }));
}

/** Write the outcome of a visit: the new schedule, and the fetch bookkeeping. */
async function saveSchedule(sourceId, patch) {
	const fields = {
		interval_minutes: patch.intervalMinutes,
		baseline_minutes: patch.baselineMinutes,
		interval_set_by: patch.intervalSetBy,
		interval_reason: trim(patch.intervalReason, 300),
		interval_expires_at: patch.intervalExpiresAt === undefined ? undefined : mysqlDate(patch.intervalExpiresAt),
		next_check_at: patch.nextCheckAt === undefined ? undefined : mysqlDate(patch.nextCheckAt),
		last_checked_at: patch.lastCheckedAt === undefined ? undefined : mysqlDate(patch.lastCheckedAt),
		last_changed_at: patch.lastChangedAt === undefined ? undefined : mysqlDate(patch.lastChangedAt),
		etag: patch.etag,
		last_modified: patch.lastModified,
		content_hash: patch.contentHash,
		robots_allowed: patch.robotsAllowed === undefined ? undefined : patch.robotsAllowed === null ? null : patch.robotsAllowed ? 1 : 0,
		robots_delay_s: patch.robotsDelayS,
		robots_checked_at: patch.robotsCheckedAt === undefined ? undefined : mysqlDate(patch.robotsCheckedAt),
		consecutive_failures: patch.consecutiveFailures,
		last_error: patch.lastError === undefined ? undefined : trim(patch.lastError, 300),
	};
	const sets = [];
	const params = [];
	for (const [column, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		sets.push(`${column} = ?`);
		params.push(value);
	}
	if (!sets.length) return;
	await pool.query(`UPDATE news_source SET ${sets.join(", ")} WHERE id = ?`, [...params, sourceId]);
}

/** Drop headlines nobody will look at again. Called from the nightly job. */
async function pruneItems(days = 30) {
	const [result] = await pool.query(`DELETE FROM news_item WHERE first_seen_at < NOW() - INTERVAL ? DAY`, [days]);
	const [polls] = await pool.query(`DELETE FROM news_poll WHERE polled_at < NOW() - INTERVAL ? DAY`, [days]);
	return { items: result.affectedRows || 0, polls: polls.affectedRows || 0 };
}

/**
 * The RSS URLs someone saved under the old feature, moved across once.
 * Feeds still parse, so nobody loses their reading list to this redesign.
 */
async function legacySources(profileId) {
	try {
		const [rows] = await pool.query(`SELECT news_sources FROM dashboard_preference WHERE profile_id = ?`, [profileId]);
		if (!rows.length) return [];
		const value = rows[0].news_sources;
		const parsed = typeof value === "string" ? JSON.parse(value) : value;
		return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

/** One source by uuid, whatever profile owns it. For jobs and diagnostics. */
async function sourceByAnyUuid(uuid) {
	const [rows] = await pool.query(`SELECT ${SOURCE_COLUMNS} FROM news_source WHERE uuid = ? LIMIT 1`, [uuid]);
	return rows.length ? toSource(rows[0]) : null;
}

/** Every source, for the job's status output. */
async function listAll() {
	const [rows] = await pool.query(`SELECT ${SOURCE_COLUMNS} FROM news_source ORDER BY profile_id, created_at`);
	return rows.map(toSource);
}

/** Which pages this profile already watches, by url hash. */
async function existingHashes(profileId) {
	const [rows] = await pool.query(`SELECT url_hash FROM news_source WHERE profile_id = ?`, [profileId]);
	return new Set(rows.map((row) => row.url_hash));
}

/** Headlines seen per source in the last week, for the settings panel. */
async function itemCounts(profileId, days = 7) {
	const [rows] = await pool.query(
		`SELECT s.uuid, COUNT(i.id) AS n FROM news_source s
     LEFT JOIN news_item i ON i.source_id = s.id AND i.first_seen_at >= NOW() - INTERVAL ? DAY
     WHERE s.profile_id = ? GROUP BY s.uuid`,
		[days, profileId]
	);
	return new Map(rows.map((row) => [row.uuid, Number(row.n || 0)]));
}

async function countSources(profileId) {
	const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM news_source WHERE profile_id = ?`, [profileId]);
	return Number(rows[0]?.n || 0);
}

module.exports = {
	HOUSE_PROFILE,
	sha1,
	listSources,
	sourceByUuid,
	addSource,
	removeSource,
	updateSourceOptions,
	claimDue,
	unseen,
	saveItems,
	recentItems,
	worldItemsSince,
	recordPoll,
	pollStats,
	lastPolls,
	saveSchedule,
	pruneItems,
	legacySources,
	sourceByAnyUuid,
	listAll,
	existingHashes,
	itemCounts,
	countSources,
};
