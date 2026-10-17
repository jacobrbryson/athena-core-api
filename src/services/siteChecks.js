/**
 * Is each of the person's sites up, and how fast does it answer?
 *
 *   siteChecks.latest(siteIds)               the newest check and the last few, per site
 *   siteChecks.checkStale(profileId, mins)   check every site whose last check is older than that
 *   siteChecks.checkEveryone()               the nightly pass
 *   siteChecks.prune(days)                   drop old checks
 *
 * One GET to https://<domain>/, timed to the response headers, no redirects
 * followed (a redirect is an answer, and following one could lead anywhere).
 * The domain is the person's own, typed on the Work or Projects page, and it
 * is only contacted when it resolves to public addresses — never loopback,
 * a private range or a cloud metadata address.
 *
 * There is no frequent scheduler (owner, 2026-10-13): sites are checked when
 * the person opens the Work page and their last check is stale, and once in
 * the nightly job. Before migration 0079 there is nowhere to keep a check, and
 * every function here says "no data" rather than failing.
 */
const dns = require("node:dns").promises;
const pool = require("../helpers/db");
const { isPrivateAddress } = require("./unsubscribe");

const TIMEOUT_MS = 10_000;
const RECENT = 12;
const USER_AGENT = "Athena/1.0 (site monitor; one request per check)";

const missingTable = (err) => err?.code === "ER_NO_SUCH_TABLE";

/** One check of one domain: { ok, statusCode, ms, error }. Never throws. */
async function probe(domain, { fetchImpl = fetch, lookup = dns.lookup } = {}) {
	try {
		const answers = await lookup(domain, { all: true, verbatim: true });
		if (!answers.length) return { ok: false, statusCode: null, ms: null, error: "The domain doesn't resolve" };
		if (answers.some((a) => isPrivateAddress(a.address))) return { ok: false, statusCode: null, ms: null, error: "The domain points at a private address" };
	} catch {
		return { ok: false, statusCode: null, ms: null, error: "The domain doesn't resolve" };
	}
	const started = Date.now();
	try {
		const res = await fetchImpl(`https://${domain}/`, {
			method: "GET",
			redirect: "manual",
			headers: { "User-Agent": USER_AGENT },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const ms = Date.now() - started;
		res.body?.cancel?.().catch(() => undefined);
		const ok = res.status < 400;
		return { ok, statusCode: res.status, ms, error: ok ? null : `Answered ${res.status}` };
	} catch (err) {
		const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
		return { ok: false, statusCode: null, ms: null, error: timedOut ? `No answer in ${TIMEOUT_MS / 1000} seconds` : "Couldn't connect" };
	}
}

/** The newest check and the last few (oldest first), per site id. Empty before 0079. */
async function latest(siteIds) {
	if (!siteIds.length) return new Map();
	let rows;
	try {
		[rows] = await pool.query(
			`SELECT site_id, checked_at, ok, status_code, ms, error FROM (
			   SELECT c.*, ROW_NUMBER() OVER (PARTITION BY site_id ORDER BY checked_at DESC, id DESC) AS n
			     FROM athena_site_check c WHERE site_id IN (?)
			 ) t WHERE n <= ${RECENT} ORDER BY site_id, checked_at`,
			[siteIds]
		);
	} catch (err) {
		if (missingTable(err)) return new Map();
		throw err;
	}
	const out = new Map();
	for (const r of rows) {
		const list = out.get(Number(r.site_id)) || [];
		list.push({ ok: Boolean(r.ok), statusCode: r.status_code ?? null, ms: r.ms ?? null, error: r.error || null, checkedAt: r.checked_at });
		out.set(Number(r.site_id), list);
	}
	const shaped = new Map();
	for (const [id, recent] of out) {
		const last = recent[recent.length - 1];
		shaped.set(id, { ...last, recent: recent.map((c) => ({ ok: c.ok, ms: c.ms })) });
	}
	return shaped;
}

async function store(siteId, result) {
	await pool.query(
		"INSERT INTO athena_site_check (site_id, ok, status_code, ms, error) VALUES (?,?,?,?,?)",
		[siteId, result.ok ? 1 : 0, result.statusCode, result.ms, result.error ? String(result.error).slice(0, 190) : null]
	);
}

/** Check each of this person's sites whose last check is older than `minutes`. Returns how many were checked. */
async function checkStale(profileId, minutes = 10) {
	let rows;
	try {
		[rows] = await pool.query(
			`SELECT s.id, s.domain FROM athena_site s
			  LEFT JOIN (SELECT site_id, MAX(checked_at) AS at FROM athena_site_check GROUP BY site_id) c ON c.site_id = s.id
			  WHERE s.profile_id = ? AND (c.at IS NULL OR c.at < NOW() - INTERVAL ? MINUTE)`,
			[profileId, Math.max(1, Number(minutes) || 10)]
		);
	} catch (err) {
		if (missingTable(err)) return 0;
		throw err;
	}
	await Promise.all(rows.map(async (r) => store(Number(r.id), await probe(r.domain))));
	return rows.length;
}

/** The nightly pass: every site, everyone, one at a time per person. */
async function checkEveryone() {
	let rows;
	try {
		[rows] = await pool.query("SELECT DISTINCT profile_id FROM athena_site");
	} catch (err) {
		if (missingTable(err)) return { profiles: 0, checked: 0 };
		throw err;
	}
	let checked = 0;
	for (const { profile_id: profileId } of rows) {
		try {
			checked += await checkStale(profileId, 30);
		} catch (err) {
			console.warn("[siteChecks] check failed for a profile:", err?.message || err);
		}
	}
	return { profiles: rows.length, checked };
}

async function prune(days = 14) {
	try {
		const [result] = await pool.query("DELETE FROM athena_site_check WHERE checked_at < NOW() - INTERVAL ? DAY", [days]);
		return result.affectedRows;
	} catch (err) {
		if (missingTable(err)) return 0;
		throw err;
	}
}

/** A removed site takes its checks with it. */
async function forget(siteId) {
	try {
		await pool.query("DELETE FROM athena_site_check WHERE site_id = ?", [siteId]);
	} catch (err) {
		if (!missingTable(err)) throw err;
	}
}

module.exports = { probe, latest, checkStale, checkEveryone, prune, forget };
