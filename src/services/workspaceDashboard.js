/**
 * What one workspace's dashboard reads that the Work page doesn't already:
 * open pull requests (GitHub) and open epics (Jira).
 *
 * Both are read-only and use only the credential the person linked to THIS
 * workspace (Work → Development environments & keys for GitHub; the Jira
 * connection under the workspace). Nothing falls back to another workspace's
 * key or to the default Jira link. A source that can't be read comes back as
 * `{ items: [], error }` so one failure never blanks the other card.
 *
 * See docs/capabilities/workplaces.md.
 */
const credentials = require("./credentials");
const workplaces = require("./workplaces");

const TIMEOUT_MS = 12000;
const GITHUB = "https://api.github.com";
const JIRA_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.atlassian\.net$/i;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

const notFound = () => Object.assign(new Error("That workspace isn't on your list."), { status: 404 });

/** The workspace's linked, active credential for a provider, with its token — or null. */
async function credentialFor(profileId, workspace, provider) {
	const link = workspace.connections.find((c) => c.provider === provider && c.status === "active");
	if (!link) return null;
	const row = (await credentials.list(profileId)).find((c) => c.uuid === link.credentialUuid);
	if (!row) return null;
	const c = await credentials.get(profileId, provider, {
		externalAccountId: row.external_account_id || undefined,
		actor: "workspace-dashboard",
	});
	return c && c.uuid === link.credentialUuid && c.status === "active" && c.accessToken ? c : null;
}

async function getJson(url, headers) {
	const res = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { providerStatus: res.status });
	return res.json();
}

async function pullRequests(profileId, workspace) {
	const c = await credentialFor(profileId, workspace, "github");
	if (!c) return { items: [], error: "not_connected" };
	const headers = {
		Authorization: `Bearer ${c.accessToken}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	try {
		const me = await getJson(`${GITHUB}/user`, headers);
		if (!LOGIN.test(me.login || "")) throw new Error("bad login");
		const search = (q) => getJson(`${GITHUB}/search/issues?${new URLSearchParams({ q, sort: "updated", order: "desc", per_page: "100" })}`, headers);
		// Every open PR in the key's organizations, not only the ones touching you; your own
		// elsewhere still come in through `involves:`, and review requests through their own search.
		const orgList = await getJson(`${GITHUB}/user/orgs?per_page=100`, headers).catch(() => []);
		const orgs = (Array.isArray(orgList) ? orgList : []).map((o) => o?.login).filter((l) => LOGIN.test(l || ""));
		const [involved, asked, orgWide] = await Promise.all([
			search(`is:pr is:open involves:${me.login}`),
			search(`is:pr is:open review-requested:${me.login}`).catch(() => ({ items: [] })),
			orgs.length ? search(`is:pr is:open ${orgs.map((o) => `org:${o}`).join(" ")}`).catch(() => ({ items: [] })) : { items: [] },
		]);
		const reviewing = new Set((asked.items || []).map((i) => i.id));
		const seen = new Set();
		const all = [...(involved.items || []), ...(asked.items || []), ...(orgWide.items || [])]
			.filter((i) => !seen.has(i.id) && seen.add(i.id))
			.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
		const items = all.map((i) => {
			const full = String(i.repository_url || "").replace(`${GITHUB}/repos/`, "");
			return {
				id: i.id, number: i.number, title: String(i.title || "").slice(0, 200), url: i.html_url,
				repo: full.split("/")[1] || full, repoFull: full, author: i.user?.login || null,
				mine: i.user?.login === me.login, reviewRequested: reviewing.has(i.id), draft: Boolean(i.draft),
				comments: i.comments || 0, createdAt: i.created_at, updatedAt: i.updated_at,
			};
		});
		return { items, login: me.login, error: null };
	} catch (err) {
		console.warn("[workspaceDashboard] github unavailable:", err.message);
		return { items: [], error: err.providerStatus === 401 || err.providerStatus === 403 ? "rejected" : "unavailable" };
	}
}

async function epics(profileId, workspace) {
	const c = await credentialFor(profileId, workspace, "jira");
	if (!c) return { items: [], error: "not_connected" };
	const host = String(c.externalAccountId || "").toLowerCase();
	// Epics read by API token only; an Atlassian OAuth link has no per-workspace read yet.
	if (c.kind !== "api_key" || !JIRA_HOST.test(host) || !c.displayName) return { items: [], error: "unsupported" };
	const headers = {
		Authorization: `Basic ${Buffer.from(`${c.displayName}:${c.accessToken}`).toString("base64")}`,
		Accept: "application/json",
	};
	const search = (jql, fields, max) => getJson(`https://${host}/rest/api/3/search/jql?${new URLSearchParams({ jql, fields, maxResults: String(max) })}`, headers);
	try {
		const found = await search("issuetype = Epic AND statusCategory != Done ORDER BY updated DESC", "summary,status,project,updated,duedate", 25);
		const keys = (found.issues || []).map((i) => i.key).filter((k) => ISSUE_KEY.test(k));
		const progress = new Map(keys.map((k) => [k, { done: 0, total: 0 }]));
		if (keys.length) {
			const kids = await search(`parent in (${keys.join(",")})`, "status,parent", 100).catch(() => ({ issues: [] }));
			for (const kid of kids.issues || []) {
				const p = progress.get(kid.fields?.parent?.key);
				if (!p) continue;
				p.total += 1;
				if (kid.fields?.status?.statusCategory?.key === "done") p.done += 1;
			}
		}
		return {
			items: (found.issues || []).map((i) => ({
				key: i.key, title: i.fields?.summary || i.key, status: i.fields?.status?.name || "",
				statusCategory: i.fields?.status?.statusCategory?.key || null, project: i.fields?.project?.name || null,
				updated: i.fields?.updated || null, due: i.fields?.duedate || null,
				url: `https://${host}/browse/${encodeURIComponent(i.key)}`, ...(progress.get(i.key) || { done: 0, total: 0 }),
			})),
			error: null,
		};
	} catch (err) {
		console.warn("[workspaceDashboard] jira epics unavailable:", err.message);
		return { items: [], error: err.providerStatus === 401 || err.providerStatus === 403 ? "rejected" : "unavailable" };
	}
}

async function read(profileId, workplaceUuid) {
	const workspace = (await workplaces.list(profileId)).find((w) => w.uuid === workplaceUuid);
	if (!workspace) throw notFound();
	const [pulls, epicList] = await Promise.all([pullRequests(profileId, workspace), epics(profileId, workspace)]);
	return { pullRequests: pulls, epics: epicList };
}

module.exports = { read };
