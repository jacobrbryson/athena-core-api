const { providerGet, providerRequest, isNotConnected } = require("./http");

/**
 * Search Console and Google Analytics (GA4) reads for the Websites panel.
 *
 * Read-only, through the guarded provider adapter: the token never leaves
 * http.js, and the three Google hosts are named bases on the `websites`
 * descriptor. The two report calls are POSTs only because Google's query
 * endpoints take a JSON body; nothing here changes anything on Google.
 *
 * Per-site reads pass invalidateOnAuthFailure:false. A 403 on one site ("you
 * don't have access to this property") says nothing about the link, and must
 * not flag every other site's numbers as needing a reconnect.
 */

const PROVIDER = "websites";
const SEARCH_DAYS = 7;
// Search Console data trails real time by roughly two days; asking for the
// last two would compare a full week against a half-empty one.
const SEARCH_LAG_DAYS = 3;
const TOP_N = 5;

const READ = { invalidateOnAuthFailure: false };

const day = (offset) => {
	const d = new Date(Date.now() - offset * 86_400_000);
	return d.toISOString().slice(0, 10);
};

const num = (value) => {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
};

/** "https://www.Example.com/path" -> "example.com". Null if it is not a host. */
function hostOf(input) {
	const raw = String(input || "").trim().toLowerCase();
	if (!raw) return null;
	const stripped = raw.replace(/^sc-domain:/, "").replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
	const host = stripped.split(/[/?#]/)[0];
	return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : null;
}

/** GA4 property ids are numeric; "properties/123" and "123" both mean 123. */
function propertyId(input) {
	const m = /^(?:properties\/)?(\d{1,20})$/.exec(String(input || "").trim());
	return m ? m[1] : null;
}

/** Search Console property: a domain property or a URL-prefix one. */
function searchSite(input) {
	const raw = String(input || "").trim();
	if (/^sc-domain:/i.test(raw)) {
		const host = hostOf(raw);
		return host ? `sc-domain:${host}` : null;
	}
	if (/^https?:\/\//i.test(raw)) {
		try {
			const url = new URL(raw);
			return `${url.protocol}//${url.host}${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`;
		} catch {
			return null;
		}
	}
	return null;
}

/** Everything Search Console lets this person see. Null when not linked. */
async function listSearchSites(profileId) {
	try {
		const data = await providerGet(profileId, PROVIDER, "/webmasters/v3/sites", { api: "search" });
		return (data?.siteEntry || [])
			.filter((s) => s?.siteUrl && s.permissionLevel !== "siteUnverifiedUser")
			.map((s) => ({ site: s.siteUrl, host: hostOf(s.siteUrl), permission: s.permissionLevel || null }));
	} catch (err) {
		if (isNotConnected(err) && err.reason === "absent") return null;
		throw err;
	}
}

/** Every GA4 property this person can read, flattened across accounts. */
async function listProperties(profileId) {
	try {
		const out = [];
		let pageToken;
		do {
			const data = await providerGet(profileId, PROVIDER, "/accountSummaries", {
				api: "admin",
				query: { pageSize: 200, ...(pageToken ? { pageToken } : {}) },
			});
			for (const account of data?.accountSummaries || []) {
				for (const p of account.propertySummaries || []) {
					const id = propertyId(p.property);
					if (id) out.push({ property: id, name: p.displayName || id, account: account.displayName || null });
				}
			}
			pageToken = data?.nextPageToken;
		} while (pageToken && out.length < 500);
		return out;
	} catch (err) {
		if (isNotConnected(err) && err.reason === "absent") return null;
		throw err;
	}
}

function searchTotals(rows) {
	const r = Array.isArray(rows) && rows[0] ? rows[0] : {};
	return { clicks: num(r.clicks), impressions: num(r.impressions), ctr: num(r.ctr), position: num(r.position) };
}

/** Search Console totals for the last week, the week before, and top queries. */
async function searchSummary(profileId, site) {
	const target = searchSite(site);
	if (!target) throw Object.assign(new Error("Not a Search Console property"), { status: 400 });
	const path = `/webmasters/v3/sites/${encodeURIComponent(target)}/searchAnalytics/query`;
	const query = (body) => providerRequest(profileId, PROVIDER, path, { method: "POST", api: "search", body, ...READ });

	const end = day(SEARCH_LAG_DAYS);
	const start = day(SEARCH_LAG_DAYS + SEARCH_DAYS - 1);
	const prevEnd = day(SEARCH_LAG_DAYS + SEARCH_DAYS);
	const prevStart = day(SEARCH_LAG_DAYS + 2 * SEARCH_DAYS - 1);

	const [current, previous, queries] = await Promise.all([
		query({ startDate: start, endDate: end }),
		query({ startDate: prevStart, endDate: prevEnd }),
		query({ startDate: start, endDate: end, dimensions: ["query"], rowLimit: TOP_N }),
	]);
	return {
		window: { start, end },
		...searchTotals(current?.rows),
		previous: searchTotals(previous?.rows),
		topQueries: (queries?.rows || []).slice(0, TOP_N).map((r) => ({
			query: String(r.keys?.[0] || "").slice(0, 120),
			clicks: num(r.clicks),
			impressions: num(r.impressions),
		})),
	};
}

/** GA4: users, sessions and new users, this week against last, plus top pages. */
async function analyticsSummary(profileId, property) {
	const id = propertyId(property);
	if (!id) throw Object.assign(new Error("Not a GA4 property id"), { status: 400 });
	const path = `/properties/${id}:runReport`;
	const report = (body) => providerRequest(profileId, PROVIDER, path, { method: "POST", api: "analytics", body, ...READ });

	const [totals, pages] = await Promise.all([
		report({
			dateRanges: [
				{ startDate: "7daysAgo", endDate: "yesterday", name: "current" },
				{ startDate: "14daysAgo", endDate: "8daysAgo", name: "previous" },
			],
			metrics: [{ name: "activeUsers" }, { name: "sessions" }, { name: "newUsers" }],
		}),
		report({
			dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
			dimensions: [{ name: "pagePath" }],
			metrics: [{ name: "screenPageViews" }],
			orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
			limit: TOP_N,
		}),
	]);

	const byRange = {};
	for (const row of totals?.rows || []) {
		const label = row.dimensionValues?.[0]?.value;
		const m = row.metricValues || [];
		byRange[label] = { users: num(m[0]?.value), sessions: num(m[1]?.value), newUsers: num(m[2]?.value) };
	}
	const empty = { users: 0, sessions: 0, newUsers: 0 };
	return {
		...(byRange.current || empty),
		previous: byRange.previous || empty,
		topPages: (pages?.rows || []).slice(0, TOP_N).map((r) => ({
			path: String(r.dimensionValues?.[0]?.value || "").slice(0, 160),
			views: num(r.metricValues?.[0]?.value),
		})),
	};
}

module.exports = {
	PROVIDER,
	hostOf,
	propertyId,
	searchSite,
	listSearchSites,
	listProperties,
	searchSummary,
	analyticsSummary,
};
